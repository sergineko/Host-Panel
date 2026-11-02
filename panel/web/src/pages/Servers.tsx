import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Cpu, HardDrive, MemoryStick, Plus, RefreshCw, Server, Trash2 } from 'lucide-react';
import { api, type ServerNode } from '../lib/api';
import { bytes, timeAgo } from '../lib/format';
import { Badge, Button, Card, ConfirmButton, Copyable, Empty, ErrorBox, Field, Input, Modal, PageHeader, Spinner, cx } from '../components/ui';

interface ServersData {
  local: ServerNode;
  servers: ServerNode[];
}
interface Setup {
  public_key: string;
  command: string;
  port: number;
  panel_ip: string;
}

function Meter({ label, icon, used, total }: { label: string; icon: ReactNode; used: number; total: number }) {
  const pct = total ? Math.round((used / total) * 100) : 0;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs text-muted">
        <span className="flex items-center gap-1.5">
          {icon}
          {label}
        </span>
        <span className="tabular">
          {bytes(used)} / {bytes(total)}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div className={cx('h-full rounded-full', pct > 90 ? 'bg-danger' : pct > 75 ? 'bg-warn' : 'bg-ok')} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ServerCard({ s, local }: { s: ServerNode; local?: boolean }) {
  const qc = useQueryClient();
  const check = useMutation({
    mutationFn: () => api.post<ServerNode>(`/api/servers/${s.id}/check`),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['servers'] });
      if (r.status === 'online') toast.success(`${r.name} responde`);
      else toast.error(`${r.name}: ${r.last_error || 'sin conexión'}`);
    },
  });
  const i = s.info;
  return (
    <Card padded={false}>
      <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className={cx('grid size-9 shrink-0 place-items-center rounded-md', local ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-muted')}>
            <Server className="size-4" />
          </div>
          <div className="min-w-0">
            <div className="truncate font-semibold">{s.name}</div>
            <div className="truncate font-mono text-xs text-muted">{s.host}</div>
          </div>
        </div>
        {s.status === 'online' ? <Badge tone="ok" dot>En línea</Badge> : s.status === 'pending' ? <Badge dot>Pendiente</Badge> : <Badge tone="danger" dot>Sin conexión</Badge>}
      </div>
      <div className="space-y-3 p-4">
        {s.status === 'offline' && s.last_error && <p className="rounded-md bg-danger-soft px-3 py-2 text-xs text-danger">{s.last_error}</p>}
        {i.mem_total ? (
          <>
            <Meter label="Memoria" icon={<MemoryStick className="size-3.5" />} used={(i.mem_total ?? 0) - (i.mem_free ?? 0)} total={i.mem_total ?? 0} />
            <Meter label="Disco" icon={<HardDrive className="size-3.5" />} used={(i.disk_total ?? 0) - (i.disk_free ?? 0)} total={i.disk_total ?? 0} />
          </>
        ) : null}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          {i.cpus ? (
            <span className="flex items-center gap-1">
              <Cpu className="size-3.5" />
              {i.cpus} CPU · carga {i.load}
            </span>
          ) : null}
          {i.os && <span>{i.os}</span>}
          {i.php?.length ? <span>PHP {i.php.join(', ')}</span> : null}
          {i.node && <span>Node {i.node}</span>}
        </div>
        <div>
          <div className="mb-1.5 text-xs font-medium text-muted">Sitios ({s.sites.length})</div>
          <div className="flex flex-wrap gap-1">
            {s.sites.length ? (
              s.sites.map((x) => (
                <Link key={x.id} to={`/sites/${x.id}`} className="rounded bg-surface-2 px-2 py-0.5 text-xs hover:text-accent">
                  {x.name}
                </Link>
              ))
            ) : (
              <span className="text-xs text-muted">Ninguno todavía</span>
            )}
          </div>
        </div>
      </div>
      {!local && (
        <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-2.5">
          <span className="text-xs text-muted">{s.last_check ? `Comprobado ${timeAgo(s.last_check)}` : ''}</span>
          <div className="flex gap-1">
            <Button size="sm" icon={<RefreshCw className="size-3.5" />} loading={check.isPending} onClick={() => check.mutate()}>
              Comprobar
            </Button>
            <ConfirmButton
              size="sm"
              variant="ghost"
              aria-label="Quitar servidor"
              title={`Quitar ${s.name}`}
              message="El panel dejará de usar este servidor. No se borra nada en el VPS (para limpiarlo ejecuta node-install.sh --uninstall)."
              label="Quitar"
              onConfirm={async () => {
                await api.del(`/api/servers/${s.id}`);
                qc.invalidateQueries({ queryKey: ['servers'] });
              }}
            >
              <Trash2 className="size-3.5" />
            </ConfirmButton>
          </div>
        </div>
      )}
    </Card>
  );
}

function AddServer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const setup = useQuery({ queryKey: ['servers-setup'], queryFn: () => api.get<Setup>('/api/servers/setup'), enabled: open });
  const [form, setForm] = useState({ name: '', host: '', ssh_port: 22 });
  const add = useMutation({
    mutationFn: () => api.post<ServerNode>('/api/servers', form),
    onSuccess: (s) => {
      qc.invalidateQueries({ queryKey: ['servers'] });
      if (s.status === 'online') toast.success(`${s.name} conectado`);
      else toast.warning(`${s.name} añadido, pero aún no responde: ${s.last_error}`);
      setForm({ name: '', host: '', ssh_port: 22 });
      onClose();
    },
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title="Añadir servidor VPS"
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={add.isPending} disabled={!form.name || !form.host} onClick={() => add.mutate()}>
            Añadir y comprobar
          </Button>
        </>
      }
    >
      <ol className="space-y-5">
        <li>
          <div className="mb-1 font-medium">1. Prepara el VPS</div>
          <p className="mb-2 text-[13px] text-muted">
            En un VPS limpio (Ubuntu 22.04/24.04 o Debian 12/13) ejecuta como root. Instala Caddy, PHP y Node.js, autoriza la clave del panel y abre el puerto 8443 solo para este servidor.
          </p>
          {setup.isLoading ? <Spinner className="py-3" /> : setup.data && <Copyable value={setup.data.command} />}
        </li>
        <li>
          <div className="mb-2 font-medium">2. Añádelo aquí</div>
          {add.error && <ErrorBox error={add.error} />}
          <div className="mt-2 grid gap-3 sm:grid-cols-[1fr_1fr_100px]">
            <Field label="Nombre">
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="VPS Madrid 1" />
            </Field>
            <Field label="IP o hostname">
              <Input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value.trim() })} placeholder="198.51.100.20" />
            </Field>
            <Field label="Puerto SSH">
              <Input type="number" value={form.ssh_port} onChange={(e) => setForm({ ...form, ssh_port: Number(e.target.value) })} />
            </Field>
          </div>
        </li>
        <li className="text-[13px] text-muted">
          <span className="font-medium text-fg">3. Úsalo en tus sitios:</span> en la configuración de cada sitio elige en qué servidores se despliega. Si eliges varios, este servidor reparte el tráfico entre ellos (balanceo de carga con comprobación de salud) y mantiene el SSL, el WAF y la analítica.
        </li>
      </ol>
    </Modal>
  );
}

export default function Servers() {
  const q = useQuery({ queryKey: ['servers'], queryFn: () => api.get<ServersData>('/api/servers'), refetchInterval: 30_000 });
  const [open, setOpen] = useState(false);
  return (
    <>
      <PageHeader
        title="Servidores"
        description="Despliega tus sitios en otros VPS y reparte la carga entre ellos. Este servidor actúa como balanceador, WAF y SSL."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>
            Añadir servidor
          </Button>
        }
      />
      {q.isLoading ? (
        <Spinner />
      ) : q.error ? (
        <ErrorBox error={q.error} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <ServerCard s={q.data!.local} local />
          {q.data!.servers.map((s) => (
            <ServerCard key={s.id} s={s} />
          ))}
          {q.data!.servers.length === 0 && (
            <Card className="border-dashed">
              <Empty
                icon={<Server className="size-6" />}
                title="Sin servidores adicionales"
                description="Añade un VPS para desplegar sitios en él o repartir el tráfico entre varios."
                action={
                  <Button icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>
                    Añadir servidor
                  </Button>
                }
              />
            </Card>
          )}
        </div>
      )}
      <AddServer open={open} onClose={() => setOpen(false)} />
    </>
  );
}
