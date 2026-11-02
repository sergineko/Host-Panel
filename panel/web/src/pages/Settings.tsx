import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { timeAgo } from '../lib/format';
import { Button, Card, Copyable, ErrorBox, Field, Input, PageHeader, Spinner, Table, Td } from '../components/ui';

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
      <PageHeader title="Ajustes" description="Configuración del servidor (definida en la instalación) y cuenta de administrador." />
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
              <dt className="text-muted">PHP</dt>
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
            <Field label="Nueva contraseña" hint="Mínimo 10 caracteres.">
              <Input type="password" autoComplete="new-password" value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} />
            </Field>
            <Field label="Repite la nueva contraseña">
              <Input type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
            </Field>
            <Button variant="primary" type="submit" loading={change.isPending} disabled={!pw.current || !pw.password}>
              Actualizar
            </Button>
          </form>
        </Card>

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
