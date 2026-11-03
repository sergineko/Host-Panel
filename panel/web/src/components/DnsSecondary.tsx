import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Network, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';
import { Badge, Button, Callout, Card, ConfirmButton, Copyable, ErrorBox, Field, Input, Spinner, Table, Td } from './ui';

interface SecondaryState {
  configured: boolean;
  secondary: { ip: string; ipv6: string | null; added_at: string } | null;
  ns2: string;
  primary_ip: string;
  ready: boolean;
  reachable: boolean | null;
  zones: { name: string; primary_serial: number | null; secondary_serial: number | null; in_sync: boolean }[];
  command: string;
}

/** ns2 on another machine: install command, IP and per-zone sync status. */
export function DnsSecondaryCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['dns-secondary'], queryFn: () => api.get<SecondaryState>('/api/dns/secondary'), refetchInterval: 30_000 });
  const [ip, setIp] = useState('');
  const [ipv6, setIpv6] = useState('');
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['dns-secondary'] });
    qc.invalidateQueries({ queryKey: ['identity'] });
  };
  const add = useMutation({
    mutationFn: () => api.put('/api/dns/secondary', { ip, ipv6: ipv6 || null }),
    onSuccess: () => {
      toast.success('DNS secundario añadido');
      refresh();
    },
  });
  const sync = useMutation({
    mutationFn: () => api.post('/api/dns/secondary/sync'),
    onSuccess: () => {
      toast.success('Zonas enviadas al secundario');
      setTimeout(refresh, 3000);
    },
  });
  const remove = useMutation({
    mutationFn: () => api.del('/api/dns/secondary'),
    onSuccess: () => {
      toast.success('DNS secundario quitado');
      refresh();
    },
  });

  if (q.isLoading) return <Card title="DNS secundario"><Spinner /></Card>;
  if (q.error) return <Card title="DNS secundario"><ErrorBox error={q.error} /></Card>;
  const s = q.data!;
  const synced = s.zones.filter((z) => z.in_sync).length;

  return (
    <Card
      icon={<Network />}
      title="DNS secundario"
      description={`${s.ns2} en otra máquina: si este servidor cae, tus dominios siguen resolviendo.`}
      actions={
        s.configured ? (
          s.reachable === false ? <Badge tone="danger" dot>No responde</Badge> : <Badge tone="ok" dot>Activo · {synced}/{s.zones.length} zonas al día</Badge>
        ) : (
          <Badge tone="warn" dot>Sin secundario</Badge>
        )
      }
    >
      {!s.ready ? (
        <p className="text-[13px] text-muted">Configura primero el dominio principal del servidor (Ajustes).</p>
      ) : s.configured ? (
        <div className="space-y-4">
          <Callout tone="info" title="En el registrador de tu dominio principal">
            Cambia el glue record de <span className="font-mono">{s.ns2}</span> a <span className="font-mono">{s.secondary!.ip}</span>
            {s.secondary!.ipv6 && <> (IPv6 <span className="font-mono">{s.secondary!.ipv6}</span>)</>}. Los nameservers de tus dominios no cambian.
          </Callout>
          <div className="overflow-hidden rounded-lg border border-border">
            <Table head={['Zona', 'Serial aquí', 'Serial en el secundario', '']}>
              {s.zones.map((z) => (
                <tr key={z.name}>
                  <Td className="font-mono text-[12.5px]">{z.name}</Td>
                  <Td className="font-mono text-xs tabular-nums">{z.primary_serial ?? '—'}</Td>
                  <Td className="font-mono text-xs tabular-nums">{z.secondary_serial ?? '—'}</Td>
                  <Td>{z.in_sync ? <Badge tone="ok">Al día</Badge> : <Badge tone="warn">Pendiente</Badge>}</Td>
                </tr>
              ))}
            </Table>
          </div>
          <p className="text-xs text-muted">
            Los cambios se envían al momento; el secundario además comprueba cada minuto. Si borras un dominio aquí, en el secundario se queda una copia sin uso.
          </p>
          <div className="flex flex-wrap justify-between gap-2">
            <ConfirmButton
              variant="danger"
              title="Quitar el DNS secundario"
              message={`${s.ns2} volverá a apuntar a este servidor. Acuérdate de cambiar también su glue record en el registrador.`}
              label="Quitar"
              onConfirm={() => remove.mutateAsync()}
            >
              Quitar secundario
            </ConfirmButton>
            <Button icon={<RefreshCw className="size-4" />} loading={sync.isPending} onClick={() => sync.mutate()}>
              Sincronizar ahora
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4 text-[13px]">
          <p className="text-muted">
            Ahora {s.ns2} apunta a este mismo servidor. Con un secundario, cada nameserver está en una máquina y una IP distinta, como piden los registradores.
          </p>
          <ol className="space-y-3">
            <li>
              <strong>1.</strong> Prepara un VPS pequeño (512 MB bastan) con Ubuntu 22.04+ o Debian 12+, mejor en otro proveedor o centro de datos.
            </li>
            <li>
              <strong>2.</strong> Ejecuta en él, como root:
              <Copyable value={s.command} className="mt-1.5" />
            </li>
            <li>
              <strong>3.</strong> Escribe su IP pública:
              <form
                className="mt-1.5 flex flex-wrap items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  add.mutate();
                }}
              >
                <Field label="IPv4" className="min-w-40 flex-1">
                  <Input value={ip} onChange={(e) => setIp(e.target.value.trim())} placeholder="198.51.100.20" inputMode="decimal" />
                </Field>
                <Field label="IPv6 (opcional)" className="min-w-40 flex-1">
                  <Input value={ipv6} onChange={(e) => setIpv6(e.target.value.trim())} placeholder="2001:db8::20" />
                </Field>
                <Button type="submit" variant="primary" disabled={!ip} loading={add.isPending}>
                  Añadir secundario
                </Button>
              </form>
            </li>
          </ol>
          {add.error && <ErrorBox error={add.error} />}
          <p className="text-xs text-muted">
            El panel le enviará todas las zonas y apuntará {s.ns2} a esa IP. Después solo tendrás que cambiar el glue record de {s.ns2} en tu registrador.
          </p>
        </div>
      )}
    </Card>
  );
}
