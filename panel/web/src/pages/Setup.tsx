import { useMemo, useState, type ReactNode } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, Check, Eye, EyeOff, Globe, KeyRound, ShieldCheck, Sparkles, UserRound, Wand2 } from 'lucide-react';
import { api, ApiError, type ServerIdentity } from '../lib/api';
import { Logo } from '../components/Layout';
import { generatePassword, passwordStrength, StrengthMeter, usernameHint } from '../components/AccountFields';
import { TotpEnroll, AUTH_APPS } from '../components/TwoFactor';
import { DomainConnection } from '../components/Connection';
import { JobLog } from '../components/JobLog';
import { LicenseChooser, type Plan } from '../components/LicenseCards';
import { Button, Callout, Card, Copyable, ErrorBox, Field, Input, Select, Spinner, cx } from '../components/ui';

interface SetupStatus {
  required: boolean;
  account: boolean;
  token_required: boolean;
  license: boolean;
  store_url: string;
  plans: Plan[];
}
interface SetupState {
  pending: boolean;
  username: string;
  email: string;
  totp: boolean;
  twofa_done: boolean;
  timezone: string;
  private_ip: boolean;
  identity: ServerIdentity;
  main_domain_id: number | null;
}

const STEPS = [
  { id: 'license', label: 'Licencia', icon: <BadgeCheck /> },
  { id: 'account', label: 'Cuenta', icon: <UserRound /> },
  { id: '2fa', label: 'Verificación', icon: <ShieldCheck /> },
  { id: 'domain', label: 'Dominio', icon: <Globe /> },
  { id: 'dns', label: 'DNS', icon: <KeyRound /> },
] as const;
type StepId = (typeof STEPS)[number]['id'];

function Stepper({ current }: { current: StepId }) {
  const idx = STEPS.findIndex((s) => s.id === current);
  return (
    <ol className="mb-6 flex items-center gap-2" aria-label="Pasos de la configuración">
      {STEPS.map((s, i) => (
        <li key={s.id} className="flex flex-1 items-center gap-2" aria-current={i === idx ? 'step' : undefined}>
          <span
            className={cx(
              'grid size-7 shrink-0 place-items-center rounded-full border text-xs font-semibold transition-colors [&>svg]:size-3.5',
              i < idx ? 'border-ok bg-ok text-white' : i === idx ? 'border-accent bg-accent text-accent-fg' : 'border-border bg-surface text-muted',
            )}
          >
            {i < idx ? <Check /> : i + 1}
          </span>
          <span className={cx('hidden text-[13px] sm:inline', i === idx ? 'font-semibold' : 'text-muted')}>{s.label}</span>
          {i < STEPS.length - 1 && <span className={cx('h-px flex-1', i < idx ? 'bg-ok' : 'bg-border')} />}
        </li>
      ))}
    </ol>
  );
}

function Shell({ step, children, wide }: { step?: StepId; children: ReactNode; wide?: boolean }) {
  return (
    <div className="min-h-screen bg-[radial-gradient(ellipse_at_top,var(--accent-soft),transparent_55%)] px-4 py-10">
      <div className={cx('mx-auto w-full', wide ? 'max-w-3xl' : 'max-w-xl')}>
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>
        {step && <Stepper current={step} />}
        {children}
      </div>
    </div>
  );
}

// --- step 1: administrator account ---------------------------------------------------------

function AccountStep({ token, defaultEmail = '', onCreated }: { token: string; defaultEmail?: string; onCreated: () => void }) {
  const verify = useQuery({
    queryKey: ['setup-verify', token],
    queryFn: () => api.post<{ ok: boolean; server_ip: string; admin_email: string }>('/api/setup/verify', { token }),
    retry: false,
  });
  const [form, setForm] = useState({ username: '', email: defaultEmail, password: '', confirm: '' });
  const [show, setShow] = useState(false);
  const [generated, setGenerated] = useState(false);
  const create = useMutation({
    mutationFn: () => api.post('/api/setup/account', { token, username: form.username, email: form.email, password: form.password }),
    onSuccess: onCreated,
  });

  if (verify.isLoading) return <Spinner />;
  if (verify.error) {
    return (
      <Callout tone="danger" title="No se puede usar este enlace">
        {(verify.error as Error).message}
        <pre className="mt-2 rounded-md bg-surface px-2.5 py-1.5 font-mono text-[12.5px]">sudo hostpanel setup-link</pre>
      </Callout>
    );
  }

  const userProblem = usernameHint(form.username);
  const pw = passwordStrength(form.password, form.username);
  const mismatch = !!form.confirm && form.confirm !== form.password;
  const usernameIsEmail = form.username.includes('@');
  const ready = form.username && !userProblem && form.email && !pw.problem && form.password && form.password === form.confirm;
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <Card title="Crea la cuenta de administrador" icon={<UserRound />} description="Es la única cuenta con acceso total al servidor. Protégela bien.">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) create.mutate();
        }}
      >
        <Field
          label="Nombre de usuario"
          hint={
            userProblem ? (
              <span className="text-danger">{userProblem}</span>
            ) : (
              'Lo más seguro es un nombre poco evidente (no «admin» ni tu nombre de pila). Un correo también vale, aunque es más fácil de adivinar.'
            )
          }
        >
          <Input
            value={form.username}
            onChange={(e) => {
              const v = e.target.value;
              set('username', v);
              if (v.includes('@') && (!form.email || form.email === form.username)) set('email', v.trim().toLowerCase());
            }}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="p. ej. marta.ops o tu@empresa.com"
            autoFocus
          />
        </Field>
        <Field label="Correo electrónico de contacto" hint="Para los certificados SSL (Let's Encrypt), los informes de correo (DMARC) y avisos del servidor.">
          <Input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} autoComplete="email" placeholder="tu@empresa.com" disabled={usernameIsEmail && form.email === form.username.trim().toLowerCase()} />
        </Field>
        <Field label="Contraseña">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Input
                type={show ? 'text' : 'password'}
                value={form.password}
                onChange={(e) => {
                  set('password', e.target.value);
                  setGenerated(false);
                }}
                autoComplete="new-password"
                className="pr-9 font-mono"
                minLength={12}
              />
              <button type="button" className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-muted hover:text-fg" onClick={() => setShow((s) => !s)} aria-label={show ? 'Ocultar contraseña' : 'Mostrar contraseña'}>
                {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
            <Button
              type="button"
              icon={<Wand2 className="size-4" />}
              onClick={() => {
                const p = generatePassword();
                setForm((f) => ({ ...f, password: p, confirm: p }));
                setShow(true);
                setGenerated(true);
              }}
            >
              Generar
            </Button>
          </div>
          <StrengthMeter password={form.password} username={form.username} />
          {generated && (
            <div className="mt-2 space-y-1.5 rounded-lg border border-border bg-surface-2 p-2.5 text-xs text-muted">
              <Copyable value={form.password} />
              <p>Guárdala en tu gestor de contraseñas (Contraseñas de Apple, 1Password, Bitwarden…) antes de continuar.</p>
            </div>
          )}
        </Field>
        {!generated && (
          <Field label="Repite la contraseña" hint={mismatch ? <span className="text-danger">Las contraseñas no coinciden</span> : undefined}>
            <Input type={show ? 'text' : 'password'} value={form.confirm} onChange={(e) => set('confirm', e.target.value)} autoComplete="new-password" className="font-mono" />
          </Field>
        )}
        {create.error && <ErrorBox error={create.error} />}
        <div className="flex items-center justify-between gap-3 pt-1">
          <span className="text-xs text-muted">Este enlace deja de funcionar al crear la cuenta.</span>
          <Button variant="primary" type="submit" disabled={!ready} loading={create.isPending}>
            Crear cuenta y continuar
          </Button>
        </div>
      </form>
    </Card>
  );
}

// --- step 0: licence ---------------------------------------------------------------------------

function LicenseStep({ token, status, onDone }: { token: string; status: SetupStatus; onDone: (email: string) => void }) {
  const verify = useQuery({
    queryKey: ['setup-verify', token],
    queryFn: () => api.post<{ ok: boolean }>('/api/setup/verify', { token }),
    retry: false,
  });
  const install = useMutation({
    mutationFn: (license: string) => api.post<{ plan: Plan; email: string; id: string }>('/api/setup/license', { token, license }),
    onSuccess: (r) => onDone(r.email),
  });

  if (verify.isLoading) return <Spinner />;
  if (verify.error) {
    return (
      <Callout tone="danger" title="No se puede usar este enlace">
        {(verify.error as Error).message}
        <pre className="mt-2 rounded-md bg-surface px-2.5 py-1.5 font-mono text-[12.5px]">sudo hostpanel setup-link</pre>
      </Callout>
    );
  }
  return (
    <Card title="Licencia del panel" icon={<BadgeCheck />} description="Todos los planes son de suscripción.">
      <LicenseChooser plans={status.plans} storeUrl={status.store_url} onActivate={(t) => install.mutate(t)} pending={install.isPending} error={install.error} />
    </Card>
  );
}

// --- step 2: two-factor authentication -----------------------------------------------------

function TwoFactorStep({ onDone }: { onDone: () => void }) {
  const [enrolling, setEnrolling] = useState(false);
  const [confirmSkip, setConfirmSkip] = useState(false);
  const skip = useMutation({ mutationFn: () => api.post('/api/setup/2fa/skip'), onSuccess: onDone });
  return (
    <Card title="Verificación en dos pasos" icon={<ShieldCheck />} description="Aunque alguien consiga tu contraseña, sin tu móvil no podrá entrar.">
      {enrolling ? (
        <TotpEnroll onDone={onDone} doneLabel="Continuar" />
      ) : (
        <div className="space-y-4">
          <p className="text-[13px] text-muted">
            Al iniciar sesión se pedirá, además de la contraseña, un código de 6 dígitos que cambia cada 30 segundos. Funciona con {AUTH_APPS}.
          </p>
          <ul className="space-y-1.5 text-[13px]">
            <li className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-ok" />Sin conexión: el código se genera en el propio móvil.</li>
            <li className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-ok" />Con 10 códigos de recuperación por si pierdes el móvil.</li>
            <li className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-ok" />Cada código sirve una sola vez, aunque alguien lo vea.</li>
          </ul>
          {confirmSkip && (
            <Callout tone="warn" title="¿Seguro que quieres seguir sin ella?">
              El panel controla todo el servidor. Podrás activarla después en Ajustes, pero te recomendamos hacerlo ahora.
            </Callout>
          )}
          {skip.error && <ErrorBox error={skip.error} />}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" loading={skip.isPending} onClick={() => (confirmSkip ? skip.mutate() : setConfirmSkip(true))}>
              {confirmSkip ? 'Sí, omitir por ahora' : 'Omitir'}
            </Button>
            <Button variant="primary" onClick={() => setEnrolling(true)}>
              Activar verificación en dos pasos
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

// --- step 3: main domain ---------------------------------------------------------------------

function DomainStep({ state, onDone }: { state: SetupState; onDone: () => void }) {
  const qc = useQueryClient();
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zones = useMemo(() => {
    const list = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
    return list.includes('UTC') ? list : ['UTC', ...list];
  }, []);
  const [domain, setDomain] = useState(state.identity.base_domain ?? '');
  const [email, setEmail] = useState(state.email);
  const [timezone, setTimezone] = useState(state.timezone && state.timezone !== 'UTC' && state.timezone !== 'Etc/UTC' ? state.timezone : browserTz || 'UTC');
  const [jobId, setJobId] = useState<number | null>(state.identity.job?.id ?? null);
  const clean = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  const valid = /^(?=.{1,253}$)(?!-)([a-z0-9-]{1,63}(?<!-)\.)+[a-z]{2,63}$/.test(clean);
  const start = useMutation({
    mutationFn: () => api.post<{ job_id: number | null }>('/api/setup/domain', { domain: clean, email, timezone }),
    onSuccess: (r) => (r.job_id === null ? onDone() : setJobId(r.job_id)),
  });

  if (jobId !== null) {
    return (
      <Card title={`Configurando ${clean || state.identity.base_domain}`} icon={<Globe />} description="Se instala el correo, se abren sus puertos y se crea la zona DNS. Tarda unos minutos.">
        <JobLog
          jobId={jobId}
          onDone={(job) => {
            qc.invalidateQueries();
            if (job.status === 'success') onDone();
            else setJobId(null);
          }}
        />
        <p className="mt-2 text-xs text-muted">El panel se reinicia al terminar; si la página deja de responder unos segundos, es normal.</p>
      </Card>
    );
  }

  return (
    <Card title="Dominio principal del servidor" icon={<Globe />} description="El dominio con el que se conocerá este servidor (normalmente el de tu empresa).">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && email) start.mutate();
        }}
      >
        {state.private_ip && (
          <Callout tone="warn" title={`La IP detectada (${state.identity.server_ip}) es privada`}>
            Parece que el servidor está detrás de un router o NAT. Los registros DNS necesitan la IP pública: corrige <code className="font-mono">HP_SERVER_IP</code> en{' '}
            <code className="font-mono">/etc/hostpanel/hostpanel.env</code> y ejecuta <code className="font-mono">sudo hostpanel restart</code> antes de seguir.
          </Callout>
        )}
        <Field label="Dominio" hint="Debe estar registrado a tu nombre: tendrás que cambiar sus nameservers en el registrador.">
          <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="miempresa.com" autoCapitalize="none" spellCheck={false} autoFocus />
        </Field>
        {valid && (
          <div className="rounded-lg border border-border p-3 text-[13px]">
            <div className="mb-1.5 font-medium">El servidor pasará a ser:</div>
            <ul className="space-y-1 text-muted">
              <li><span className="font-mono text-fg">ns1.{clean}</span> y <span className="font-mono text-fg">ns2.{clean}</span>: nameservers de {clean} y de todos los dominios que alojes</li>
              <li><span className="font-mono text-fg">mail.{clean}</span>: servidor de correo (MX, IMAP y SMTP de todos tus dominios)</li>
              <li><span className="font-mono text-fg">panel.{clean}</span>: acceso al panel con SSL</li>
            </ul>
            <p className="mt-2 text-xs text-muted">La zona DNS completa de {clean} se gestionará desde Dominios → DNS.</p>
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Email de contacto" hint="Let's Encrypt avisa aquí si un certificado va a caducar.">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          </Field>
          <Field label="Zona horaria" hint="Para copias, tareas cron y actualizaciones nocturnas.">
            <Select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z.replace(/_/g, ' ')}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {start.error && <ErrorBox error={start.error} />}
        <div className="flex justify-end">
          <Button variant="primary" type="submit" disabled={!valid || !email} loading={start.isPending}>
            Configurar dominio
          </Button>
        </div>
      </form>
    </Card>
  );
}

// --- step 4: what to change outside the panel -------------------------------------------------

function DnsStep({ state }: { state: SetupState }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const finish = useMutation({
    mutationFn: () => api.post('/api/setup/finish'),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['me'] });
      navigate('/', { replace: true });
    },
  });
  const id = state.identity;
  return (
    <div className="space-y-4">
      <Callout tone="ok" title={`${id.base_domain} ya es el dominio principal`}>
        Solo falta decírselo a internet. Haz estos cambios en tu registrador y en tu proveedor del VPS; esta página comprueba sola cuándo se han propagado.
        No hace falta esperar: puedes entrar al panel ya.
      </Callout>
      <Card title="Resumen de cambios" icon={<Sparkles />}>
        <ol className="space-y-2 text-[13px]">
          <li>
            <strong>Registrador de {id.base_domain}</strong>: crea los glue records <span className="font-mono">{id.nameservers[0]}</span> y{' '}
            <span className="font-mono">{id.nameservers[1]}</span> → <span className="font-mono">{id.server_ip}</span>
            {id.server_ipv6 && <> (y <span className="font-mono">{id.server_ipv6}</span>)</>}, y pon esos dos como nameservers del dominio.
          </li>
          <li>
            <strong>Proveedor del VPS</strong>: DNS inverso (PTR) de <span className="font-mono">{id.server_ip}</span> → <span className="font-mono">{id.mail_hostname}</span>, y
            que no bloquee el puerto 25 de salida (algunos lo cierran por defecto: pídelo en soporte).
          </li>
          <li>
            <strong>Tus otros dominios</strong>: basta con poner <span className="font-mono">{id.nameservers.join(' y ')}</span> como nameservers en su registrador.
          </li>
          <li>
            Cuando se propague, entra en <span className="font-mono">https://{id.panel_domain}</span> con certificado válido (la dirección por IP sigue funcionando).
          </li>
        </ol>
      </Card>
      {state.main_domain_id !== null && <DomainConnection domainId={state.main_domain_id} />}
      {finish.error && <ErrorBox error={finish.error} />}
      <div className="flex justify-end">
        <Button variant="primary" loading={finish.isPending} onClick={() => finish.mutate()}>
          Ir al panel
        </Button>
      </div>
    </div>
  );
}

// --- page -------------------------------------------------------------------------------------

function Wizard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['setup-state'], queryFn: () => api.get<SetupState>('/api/setup/state'), retry: false });
  const refresh = () => qc.invalidateQueries({ queryKey: ['setup-state'] });
  if (q.isLoading) return <Shell><Spinner /></Shell>;
  if (q.error) {
    if (q.error instanceof ApiError && q.error.status === 401) return <Navigate to="/login" replace />;
    return <Shell><ErrorBox error={q.error} /></Shell>;
  }
  const s = q.data!;
  if (!s.pending) return <Navigate to="/" replace />;
  if (!s.twofa_done) return <Shell step="2fa"><TwoFactorStep onDone={refresh} /></Shell>;
  if (!s.identity.nameservers_ready || s.identity.job) return <Shell step="domain"><DomainStep state={s} onDone={refresh} /></Shell>;
  return <Shell step="dns" wide><DnsStep state={s} /></Shell>;
}

export default function Setup() {
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const token = params.get('token') ?? '';
  const [licenseEmail, setLicenseEmail] = useState('');
  const status = useQuery({ queryKey: ['setup-status'], queryFn: () => api.get<SetupStatus>('/api/setup/status') });
  if (status.isLoading) return <Shell><Spinner /></Shell>;
  if (status.error) return <Shell><ErrorBox error={status.error} /></Shell>;
  const st = status.data!;
  if (!st.required) return <Navigate to="/login" replace />;
  if (st.account) return <Wizard />;
  if (st.token_required && !token) {
    return (
      <Shell>
        <Callout tone="info" title="Configuración inicial pendiente">
          Abre el enlace que mostró el instalador al terminar. Si lo has perdido, genera uno nuevo en el servidor:
          <pre className="mt-2 rounded-md bg-surface px-2.5 py-1.5 font-mono text-[12.5px]">sudo hostpanel setup-link</pre>
        </Callout>
      </Shell>
    );
  }
  if (!st.license) {
    return (
      <Shell step="license">
        <LicenseStep
          token={token}
          status={st}
          onDone={async (email) => {
            setLicenseEmail(email);
            await qc.invalidateQueries({ queryKey: ['setup-status'] });
          }}
        />
      </Shell>
    );
  }
  return (
    <Shell step="account">
      <AccountStep
        token={token}
        defaultEmail={licenseEmail}
        onCreated={async () => {
          // Drop the token from the address bar and history.
          window.history.replaceState(null, '', '/setup');
          await qc.invalidateQueries({ queryKey: ['setup-status'] });
        }}
      />
    </Shell>
  );
}
