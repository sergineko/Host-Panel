import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Laptop, ShieldCheck, ShieldOff } from 'lucide-react';
import { api } from '../lib/api';
import { timeAgo } from '../lib/format';
import { MainDomainCard } from '../components/Connection';
import { StrengthMeter } from '../components/AccountFields';
import { AUTH_APPS, RecoveryCodes, TotpEnroll } from '../components/TwoFactor';
import { Badge, Button, Card, Copyable, ErrorBox, Field, Input, Modal, PageHeader, Spinner, Table, Td, Textarea } from '../components/ui';

interface Settings {
  serverIp: string;
  serverIpv6: string;
  panelDomain: string;
  panelPort: number;
  nameservers: string[];
  mailHostname: string;
  adminEmail: string;
  phpVersion: string;
}
interface Session {
  id: string;
  ip: string;
  user_agent: string;
  expires_at: number;
  current: boolean;
}

function browserName(ua: string) {
  const b = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl/i.test(ua) ? 'curl' : 'Navegador';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${b} en ${os}` : b;
}

function TwoFactor() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.get<{ username: string; totp: boolean; recovery_codes_left: number }>('/api/auth/me') });
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [confirm, setConfirm] = useState<'disable' | 'codes' | null>(null);
  const [password, setPassword] = useState('');
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const close = () => {
    setConfirm(null);
    setPassword('');
  };
  const disable = useMutation({
    mutationFn: () => api.post('/api/auth/2fa/disable', { password }),
    onSuccess: () => {
      toast.success('Verificación en dos pasos desactivada');
      close();
      qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
  const regenerate = useMutation({
    mutationFn: () => api.post<{ recovery_codes: string[] }>('/api/auth/2fa/recovery-codes', { password }),
    onSuccess: (r) => {
      close();
      setNewCodes(r.recovery_codes);
      qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
  const action = confirm === 'disable' ? disable : regenerate;

  const on = !!me.data?.totp;
  const left = me.data?.recovery_codes_left ?? 0;
  return (
    <Card title="Verificación en dos pasos" actions={on ? <Badge tone="ok" dot>Activa</Badge> : <Badge tone="warn" dot>Desactivada</Badge>}>
      <div className="flex items-start gap-3">
        {on ? <ShieldCheck className="mt-0.5 size-5 shrink-0 text-ok" /> : <ShieldOff className="mt-0.5 size-5 shrink-0 text-warn" />}
        <p className="text-[13px] text-muted">
          {on
            ? 'Al iniciar sesión se pide además un código de tu app de autenticación.'
            : `Protege el panel aunque alguien consiga tu contraseña. Compatible con ${AUTH_APPS}.`}
        </p>
      </div>
      {on && (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-lg bg-surface-2 px-3 py-2 text-[13px]">
          <span>
            Códigos de recuperación: <strong className={left <= 2 ? 'text-danger' : ''}>{left} disponibles</strong>
          </span>
          <Button size="sm" onClick={() => setConfirm('codes')}>
            Generar nuevos
          </Button>
        </div>
      )}
      <div className="mt-4">
        {on ? (
          <Button variant="danger" onClick={() => setConfirm('disable')}>
            Desactivar
          </Button>
        ) : (
          <Button variant="primary" onClick={() => setEnrollOpen(true)}>
            Activar
          </Button>
        )}
      </div>

      <Modal open={enrollOpen} onClose={() => setEnrollOpen(false)} title="Activar verificación en dos pasos" wide>
        {enrollOpen && (
          <TotpEnroll
            onDone={() => {
              setEnrollOpen(false);
              toast.success('Verificación en dos pasos activada');
              qc.invalidateQueries({ queryKey: ['me'] });
            }}
          />
        )}
        <p className="mt-4 text-xs text-muted">
          Si pierdes el móvil y los códigos: <code className="font-mono">sudo hostpanel disable-2fa</code> en el servidor.
        </p>
      </Modal>

      <Modal open={!!newCodes} onClose={() => setNewCodes(null)} title="Nuevos códigos de recuperación">
        {newCodes && <RecoveryCodes codes={newCodes} onConfirm={() => setNewCodes(null)} confirmLabel="Cerrar" />}
        <p className="mt-3 text-xs text-muted">Los códigos anteriores ya no sirven.</p>
      </Modal>

      <Modal
        open={confirm !== null}
        onClose={close}
        title={confirm === 'disable' ? 'Desactivar verificación en dos pasos' : 'Generar nuevos códigos de recuperación'}
        footer={
          <>
            <Button onClick={close}>Cancelar</Button>
            <Button
              variant="primary"
              className={confirm === 'disable' ? '!bg-danger !text-white' : ''}
              disabled={!password}
              loading={action.isPending}
              onClick={() => action.mutate()}
            >
              {confirm === 'disable' ? 'Desactivar' : 'Generar'}
            </Button>
          </>
        }
      >
        {action.error && <ErrorBox error={action.error} />}
        <Field label="Confirma con tu contraseña">
          <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
        </Field>
      </Modal>
    </Card>
  );
}

function Sessions() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['sessions'], queryFn: () => api.get<Session[]>('/api/auth/sessions') });
  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/api/auth/sessions/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }),
  });
  return (
    <Card title="Sesiones abiertas" padded={false}>
      {q.isLoading ? (
        <Spinner />
      ) : (
        <ul className="divide-y divide-border">
          {q.data?.map((s) => (
            <li key={s.id} className="flex items-center gap-3 px-4 py-2.5">
              <Laptop className="size-4 shrink-0 text-muted" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">
                  {browserName(s.user_agent)} {s.current && <Badge tone="ok">Esta sesión</Badge>}
                </div>
                <div className="font-mono text-xs text-muted">{s.ip}</div>
              </div>
              {!s.current && (
                <Button size="sm" variant="ghost" loading={revoke.isPending && revoke.variables === s.id} onClick={() => revoke.mutate(s.id)}>
                  Cerrar
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function PanelAccess() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['panel-settings'], queryFn: () => api.get<{ auto_update: string; panel_allow_ips: string }>('/api/panel-settings') });
  const [ips, setIps] = useState('');
  useEffect(() => {
    if (q.data) setIps(q.data.panel_allow_ips);
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => api.put('/api/panel-settings', { auto_update: q.data?.auto_update ?? 'system', panel_allow_ips: ips }),
    onSuccess: () => {
      toast.success('Acceso al panel actualizado');
      qc.invalidateQueries({ queryKey: ['panel-settings'] });
    },
  });
  return (
    <Card title="Acceso al panel por IP">
      <p className="mb-3 text-[13px] text-muted">
        Si indicas IPs, solo se podrá abrir el panel desde ellas (las webs, el correo y las APIs no se ven afectados). Vacío = desde cualquier IP.
      </p>
      {save.error && <ErrorBox error={save.error} />}
      <Textarea value={ips} onChange={(e) => setIps(e.target.value)} placeholder={'203.0.113.25\n198.51.100.0/24'} className="min-h-24" />
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted">
          ¿Te quedaste fuera? <code className="font-mono">sudo hostpanel panel-access-reset</code>
        </span>
        <Button variant="primary" size="sm" loading={save.isPending} onClick={() => save.mutate()}>
          Guardar
        </Button>
      </div>
    </Card>
  );
}

export default function SettingsPage() {
  const s = useQuery({ queryKey: ['settings'], queryFn: () => api.get<Settings>('/api/settings') });
  const audit = useQuery({ queryKey: ['audit'], queryFn: () => api.get<{ id: number; username: string; action: string; target: string; ip: string; created_at: string }[]>('/api/audit') });
  const [pw, setPw] = useState({ current: '', password: '', confirm: '' });
  const change = useMutation({
    mutationFn: () => {
      if (pw.password !== pw.confirm) throw new Error('Las contraseñas no coinciden');
      return api.post('/api/auth/password', { current: pw.current, password: pw.password });
    },
    onSuccess: () => {
      toast.success('Contraseña actualizada');
      setPw({ current: '', password: '', confirm: '' });
    },
  });

  return (
    <>
      <PageHeader title="Ajustes" description="Servidor, seguridad de tu cuenta y acceso al panel." />
      <div className="mb-4">
        <MainDomainCard />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Servidor">
          {s.isLoading ? (
            <Spinner />
          ) : (
            <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2.5 text-[13px]">
              <dt className="text-muted">IP pública</dt>
              <dd><Copyable value={s.data!.serverIp} /></dd>
              {s.data!.serverIpv6 && (
                <>
                  <dt className="text-muted">IPv6</dt>
                  <dd><Copyable value={s.data!.serverIpv6} /></dd>
                </>
              )}
              <dt className="text-muted">Panel</dt>
              <dd className="font-mono">{s.data!.panelDomain ? `https://${s.data!.panelDomain}` : `https://${s.data!.serverIp}:${s.data!.panelPort}`}</dd>
              <dt className="text-muted">Nameservers</dt>
              <dd className="font-mono">{s.data!.nameservers.join(', ')}</dd>
              <dt className="text-muted">Correo</dt>
              <dd className="font-mono">{s.data!.mailHostname || '—'}</dd>
              <dt className="text-muted">Email SSL</dt>
              <dd className="font-mono">{s.data!.adminEmail}</dd>
              <dt className="text-muted">PHP por defecto</dt>
              <dd className="font-mono">{s.data!.phpVersion}</dd>
            </dl>
          )}
          <p className="mt-4 text-xs text-muted">
            Para cambiarlos edita <code className="font-mono">/etc/hostpanel/hostpanel.env</code> y ejecuta <code className="font-mono">sudo hostpanel restart</code>.
          </p>
        </Card>

        <Card title="Cambiar contraseña">
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              change.mutate();
            }}
          >
            {change.error && <ErrorBox error={change.error} />}
            <Field label="Contraseña actual">
              <Input type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
            </Field>
            <Field label="Nueva contraseña" hint="Mínimo 12 caracteres combinando mayúsculas, minúsculas, números y símbolos (o una frase de 16+).">
              <Input type="password" autoComplete="new-password" value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} />
              <StrengthMeter password={pw.password} />
            </Field>
            <Field label="Repite la nueva contraseña">
              <Input type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
            </Field>
            <Button variant="primary" type="submit" loading={change.isPending} disabled={!pw.current || !pw.password}>
              Actualizar
            </Button>
          </form>
        </Card>

        <TwoFactor />
        <PanelAccess />
        <div className="lg:col-span-2">
          <Sessions />
        </div>

        <Card title="Registro de actividad" padded={false} className="lg:col-span-2">
          <div className="max-h-[420px] overflow-y-auto">
            <Table head={['Cuándo', 'Usuario', 'Acción', 'Objeto', 'IP']}>
              {audit.data?.map((a) => (
                <tr key={a.id}>
                  <Td className="text-xs whitespace-nowrap text-muted">{timeAgo(a.created_at)}</Td>
                  <Td>{a.username}</Td>
                  <Td className="font-mono text-xs">{a.action}</Td>
                  <Td className="max-w-xs truncate text-muted">{a.target}</Td>
                  <Td className="font-mono text-xs text-muted">{a.ip}</Td>
                </tr>
              ))}
            </Table>
          </div>
        </Card>
      </div>
    </>
  );
}
