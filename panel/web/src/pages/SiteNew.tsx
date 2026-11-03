import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, Database, Eye, EyeOff, GitBranch, Lock, RefreshCw, ShieldCheck } from 'lucide-react';
import { api, type Site } from '../lib/api';
import { Button, Card, ErrorBox, Field, Input, PageHeader, Select, cx } from '../components/ui';
import { HostnamesInput, SiteForm, type SiteFormValue } from '../components/SiteForm';

type Kind = 'wordpress' | 'git';

export interface WordPressCredentials {
  admin_url: string;
  user: string;
  password: string;
}

function WordPressLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-8.99 10c0-1.3.28-2.54.78-3.66l4.29 11.75A8.99 8.99 0 0 1 3.01 12Zm8.99 8.99c-.88 0-1.73-.13-2.54-.37l2.7-7.84 2.76 7.57.06.13c-.93.33-1.94.51-2.98.51Zm1.24-13.2c.54-.03 1.03-.09 1.03-.09.49-.06.43-.77-.06-.74 0 0-1.46.11-2.4.11-.88 0-2.37-.11-2.37-.11-.49-.03-.54.71-.06.74 0 0 .46.06.94.09l1.4 3.83-1.96 5.88-3.27-9.71c.54-.03 1.03-.09 1.03-.09.49-.06.43-.77-.06-.74 0 0-1.46.11-2.4.11l-.58-.01A8.98 8.98 0 0 1 12 3.01c2.34 0 4.47.9 6.07 2.36h-.12c-.88 0-1.5.77-1.5 1.59 0 .74.43 1.37.88 2.11.34.6.74 1.37.74 2.48 0 .77-.3 1.66-.68 2.91l-.9 3-3.25-9.67Zm3.29 12.04 2.75-7.95c.51-1.28.68-2.31.68-3.22l-.03-.94A8.99 8.99 0 0 1 20.99 12a8.98 8.98 0 0 1-4.46 7.83Z" />
    </svg>
  );
}

function KindCard({ active, onClick, icon, title, description, bullets }: { active: boolean; onClick: () => void; icon: ReactNode; title: string; description: string; bullets: string[] }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'flex flex-col gap-3 rounded-lg border p-5 text-left transition-colors',
        active ? 'border-accent bg-accent-soft ring-1 ring-accent/30' : 'border-border bg-surface hover:border-accent/40',
      )}
    >
      <div className="flex items-center gap-3">
        <div className={cx('grid size-10 place-items-center rounded-lg', active ? 'bg-accent text-accent-fg' : 'bg-surface-2 text-muted')}>{icon}</div>
        <div>
          <div className="font-semibold">{title}</div>
          <div className="text-[13px] text-muted">{description}</div>
        </div>
      </div>
      <ul className="space-y-1 text-[13px] text-muted">
        {bullets.map((b) => (
          <li key={b} className="flex items-start gap-1.5">
            <Check className="mt-0.5 size-3.5 shrink-0 text-ok" />
            {b}
          </li>
        ))}
      </ul>
    </button>
  );
}

const LOCALES = [
  { id: 'es_ES', label: 'Español (España)' },
  { id: 'en_US', label: 'English' },
  { id: 'ca', label: 'Català' },
  { id: 'gl_ES', label: 'Galego' },
  { id: 'eu', label: 'Euskara' },
  { id: 'pt_PT', label: 'Português' },
  { id: 'pt_BR', label: 'Português (Brasil)' },
  { id: 'fr_FR', label: 'Français' },
  { id: 'it_IT', label: 'Italiano' },
  { id: 'de_DE', label: 'Deutsch' },
];

function newPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%*-_';
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

function WordPressForm({ host }: { host: string | null }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const php = useQuery({ queryKey: ['php'], queryFn: () => api.get<{ default: string; versions: { version: string; installed: boolean; security: { patched: boolean } | null }[] }>('/api/php') });
  const [showPw, setShowPw] = useState(false);
  const [v, setV] = useState({
    name: host ?? '',
    hostnames: host ? [host, `www.${host}`] : ([] as string[]),
    title: '',
    locale: 'es_ES',
    admin_user: '',
    admin_email: '',
    admin_password: newPassword(),
    php_version: '',
  });
  const set = <K extends keyof typeof v>(k: K, val: (typeof v)[K]) => setV({ ...v, [k]: val });
  const create = useMutation({
    mutationFn: () => api.post<Site & { deployment_id: number; credentials: WordPressCredentials }>('/api/sites/wordpress', { ...v, name: v.name || v.title }),
    onSuccess: (site) => {
      qc.invalidateQueries({ queryKey: ['sites'] });
      qc.invalidateQueries({ queryKey: ['databases'] });
      toast.success('Instalando WordPress…');
      navigate(`/sites/${site.id}?deployment=${site.deployment_id}`, { state: { credentials: site.credentials } });
    },
  });
  const ready = v.hostnames.length && v.title && v.admin_user && v.admin_email && v.admin_password.length >= 10;

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <Card title="Sitio">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Dominios" className="sm:col-span-2" hint="El primero será la dirección principal. El SSL se emite automáticamente.">
            <HostnamesInput
              value={v.hostnames}
              onChange={(h) => setV({ ...v, hostnames: h, name: v.name || h[0] || '' })}
            />
          </Field>
          <Field label="Título del sitio">
            <Input value={v.title} onChange={(e) => set('title', e.target.value)} placeholder="Mi tienda" />
          </Field>
          <Field label="Idioma">
            <Select value={v.locale} onChange={(e) => set('locale', e.target.value)}>
              {LOCALES.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Card>

      <Card title="Administrador de WordPress">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Usuario" hint="Evita «admin»: es el primero que prueban los bots.">
            <Input value={v.admin_user} onChange={(e) => set('admin_user', e.target.value.replace(/\s/g, ''))} placeholder="maria" autoComplete="off" />
          </Field>
          <Field label="Email">
            <Input type="email" value={v.admin_email} onChange={(e) => set('admin_email', e.target.value)} placeholder="tu@correo.com" />
          </Field>
          <Field label="Contraseña" className="sm:col-span-2" hint="Generada de forma segura. Se mostrará otra vez al terminar para que la guardes.">
            <div className="flex gap-2">
              <Input
                type={showPw ? 'text' : 'password'}
                className="font-mono"
                value={v.admin_password}
                onChange={(e) => set('admin_password', e.target.value)}
                autoComplete="new-password"
              />
              <Button type="button" variant="ghost" aria-label={showPw ? 'Ocultar' : 'Mostrar'} onClick={() => setShowPw(!showPw)}>
                {showPw ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </Button>
              <Button type="button" variant="ghost" aria-label="Generar otra" onClick={() => set('admin_password', newPassword())}>
                <RefreshCw className="size-4" />
              </Button>
            </div>
          </Field>
        </div>
      </Card>

      <Card title="PHP">
        <Field label="Versión" hint="WordPress funciona mejor con PHP 8.2 o superior.">
          <Select value={v.php_version} onChange={(e) => set('php_version', e.target.value)}>
            <option value="">Por defecto del servidor{php.data ? ` (PHP ${php.data.default})` : ''}</option>
            {php.data?.versions
              // Only builds with the PHP2Shell fix can be chosen.
                .filter((x) => x.installed && x.security?.patched !== false)
              .map((x) => (
                <option key={x.version} value={x.version}>
                  PHP {x.version}
                </option>
              ))}
          </Select>
        </Field>
      </Card>

      <div className="flex flex-wrap gap-x-5 gap-y-1 rounded-md bg-surface-2 px-4 py-3 text-[13px] text-muted">
        <span className="flex items-center gap-1.5"><Database className="size-3.5" /> Base de datos MariaDB propia</span>
        <span className="flex items-center gap-1.5"><Lock className="size-3.5" /> HTTPS automático</span>
        <span className="flex items-center gap-1.5"><ShieldCheck className="size-3.5" /> wp-config.php y uploads protegidos por el WAF</span>
      </div>

      {create.error && <ErrorBox error={create.error} />}
      <div className="flex justify-end gap-2">
        <Link to="/sites">
          <Button type="button">Cancelar</Button>
        </Link>
        <Button variant="primary" type="submit" loading={create.isPending} disabled={!ready}>
          Instalar WordPress
        </Button>
      </div>
    </form>
  );
}

function GitForm({ host }: { host: string | null }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [value, setValue] = useState<SiteFormValue>({
    name: host ?? '',
    hostnames: host ? [host, `www.${host}`] : [],
    type: 'static',
    spa: false,
    repo_url: '',
    branch: 'main',
    install_command: '',
    build_command: '',
    output_dir: '',
    start_command: '',
    env: {},
    memory_mb: 512,
    auto_deploy: true,
    php_version: '',
    node_version: 'latest',
    server_ids: [0],
    lb_policy: 'round_robin',
  });
  const create = useMutation({
    mutationFn: () => api.post<Site & { deployment_id: number }>('/api/sites', value),
    onSuccess: (site) => {
      qc.invalidateQueries({ queryKey: ['sites'] });
      toast.success('Sitio creado. Primer despliegue en marcha.');
      navigate(`/sites/${site.id}?deployment=${site.deployment_id}`);
    },
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
      className="space-y-4"
    >
      <SiteForm value={value} onChange={setValue} />
      {create.error && <ErrorBox error={create.error} />}
      <div className="flex justify-end gap-2">
        <Link to="/sites">
          <Button type="button">Cancelar</Button>
        </Link>
        <Button variant="primary" type="submit" loading={create.isPending} disabled={!value.name || !value.hostnames.length}>
          Crear y desplegar
        </Button>
      </div>
    </form>
  );
}

export default function SiteNew() {
  const [params, setParams] = useSearchParams();
  const host = params.get('host');
  const kind = params.get('kind') as Kind | null;
  const choose = (k: Kind) => setParams((p) => {
    p.set('kind', k);
    return p;
  });

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Nuevo sitio" description="¿Qué quieres publicar?" />
      <div className="mb-6 grid gap-3 sm:grid-cols-2">
        <KindCard
          active={kind === 'wordpress'}
          onClick={() => choose('wordpress')}
          icon={<WordPressLogo className="size-5" />}
          title="WordPress"
          description="Instalación en un clic"
          bullets={['Sin GitHub ni comandos', 'Base de datos y administrador creados', 'Actualizaciones de WordPress desde su panel']}
        />
        <KindCard
          active={kind === 'git'}
          onClick={() => choose('git')}
          icon={<GitBranch className="size-5" />}
          title="Desde un repositorio Git"
          description="Estático, PHP o Node.js"
          bullets={['Se despliega en cada push (webhook)', 'Versiones con vuelta atrás', 'Uno o varios servidores con balanceo']}
        />
      </div>
      {kind === 'wordpress' && <WordPressForm host={host} />}
      {kind === 'git' && <GitForm host={host} />}
    </div>
  );
}
