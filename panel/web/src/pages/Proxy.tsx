import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeftRight, ArrowRight, Code, Lock, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, type ProxyRoute, type Redirect } from '../lib/api';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Modal, PageHeader, Select, Spinner, Table, Tabs, Td, Toggle } from '../components/ui';

type ProxyForm = Omit<ProxyRoute, 'id'>;
const emptyProxy: ProxyForm = { hostname: '', path_prefix: '', strip_prefix: false, upstreams: [''], lb_policy: 'round_robin', preserve_host: true, tls_skip_verify: false, enabled: true, note: '' };
type RedirectForm = Omit<Redirect, 'id'>;
const emptyRedirect: RedirectForm = { hostname: '', path: '', target: 'https://', code: 301, preserve_path: true, enabled: true };

function ProxyModal({ initial, id, onClose }: { initial: ProxyForm; id?: number; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState(initial);
  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, upstreams: f.upstreams.map((u) => u.trim()).filter(Boolean) };
      return id ? api.put(`/api/proxy/${id}`, body) : api.post('/api/proxy', body);
    },
    onSuccess: () => {
      toast.success('Ruta aplicada en el proxy');
      qc.invalidateQueries({ queryKey: ['proxy'] });
      onClose();
    },
  });
  const set = <K extends keyof ProxyForm>(k: K, v: ProxyForm[K]) => setF({ ...f, [k]: v });
  return (
    <Modal
      open
      onClose={onClose}
      title={id ? 'Editar ruta' : 'Nueva ruta de proxy inverso'}
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Guardar y aplicar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {save.error && <ErrorBox error={save.error} />}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Hostname" className="sm:col-span-2" hint="SSL automático">
            <Input value={f.hostname} onChange={(e) => set('hostname', e.target.value.trim().toLowerCase())} placeholder="api.midominio.com" autoFocus />
          </Field>
          <Field label="Ruta (opcional)" hint="Ej. /api">
            <Input value={f.path_prefix} onChange={(e) => set('path_prefix', e.target.value.trim())} placeholder="/" />
          </Field>
        </div>
        <Field label="Servidores de destino (upstreams)" hint="Varios = balanceo de carga con failover automático.">
          <div className="space-y-2">
            {f.upstreams.map((u, i) => (
              <div key={i} className="flex gap-2">
                <Input className="font-mono text-[13px]" value={u} onChange={(e) => set('upstreams', f.upstreams.map((x, j) => (j === i ? e.target.value : x)))} placeholder="127.0.0.1:8080 o https://10.0.0.5" />
                {f.upstreams.length > 1 && (
                  <Button type="button" variant="ghost" aria-label="Quitar" onClick={() => set('upstreams', f.upstreams.filter((_, j) => j !== i))}>
                    <Trash2 className="size-4" />
                  </Button>
                )}
              </div>
            ))}
            <Button type="button" size="sm" icon={<Plus className="size-3.5" />} onClick={() => set('upstreams', [...f.upstreams, ''])}>
              Añadir servidor
            </Button>
          </div>
        </Field>
        {f.upstreams.length > 1 && (
          <Field label="Balanceo">
            <Select value={f.lb_policy} onChange={(e) => set('lb_policy', e.target.value)}>
              <option value="round_robin">Round robin</option>
              <option value="least_conn">Menos conexiones</option>
              <option value="ip_hash">Por IP (sesiones fijas)</option>
              <option value="random">Aleatorio</option>
              <option value="first">Primero disponible (failover)</option>
            </Select>
          </Field>
        )}
        <div className="divide-y divide-border border-t border-border">
          {f.path_prefix && <Toggle checked={f.strip_prefix} onChange={(v) => set('strip_prefix', v)} label="Quitar el prefijo de la ruta" description={`${f.path_prefix}/usuarios llega al backend como /usuarios`} />}
          <Toggle checked={f.preserve_host} onChange={(v) => set('preserve_host', v)} label="Conservar la cabecera Host" description="Desactívalo si el backend espera su propio nombre (p. ej. servicios externos)." />
          <Toggle checked={f.tls_skip_verify} onChange={(v) => set('tls_skip_verify', v)} label="No verificar el certificado del backend" description="Solo para backends HTTPS con certificado autofirmado." />
          <Toggle checked={f.enabled} onChange={(v) => set('enabled', v)} label="Ruta activa" />
        </div>
        <Field label="Nota">
          <Input value={f.note} onChange={(e) => set('note', e.target.value)} placeholder="Opcional" />
        </Field>
      </div>
    </Modal>
  );
}

function RedirectModal({ initial, id, onClose }: { initial: RedirectForm; id?: number; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState(initial);
  const save = useMutation({
    mutationFn: () => (id ? api.put(`/api/redirects/${id}`, f) : api.post('/api/redirects', f)),
    onSuccess: () => {
      toast.success('Redirección aplicada');
      qc.invalidateQueries({ queryKey: ['redirects'] });
      onClose();
    },
  });
  const set = <K extends keyof RedirectForm>(k: K, v: RedirectForm[K]) => setF({ ...f, [k]: v });
  return (
    <Modal
      open
      onClose={onClose}
      title={id ? 'Editar redirección' : 'Nueva redirección'}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Guardar
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {save.error && <ErrorBox error={save.error} />}
        <div className="grid grid-cols-3 gap-3">
          <Field label="Desde (hostname)" className="col-span-2">
            <Input value={f.hostname} onChange={(e) => set('hostname', e.target.value.trim().toLowerCase())} placeholder="antiguo.com" />
          </Field>
          <Field label="Ruta">
            <Input value={f.path} onChange={(e) => set('path', e.target.value.trim())} placeholder="todas" />
          </Field>
        </div>
        <Field label="Hacia (URL)">
          <Input value={f.target} onChange={(e) => set('target', e.target.value.trim())} placeholder="https://nuevo.com" />
        </Field>
        <Field label="Código">
          <Select value={f.code} onChange={(e) => set('code', Number(e.target.value))}>
            <option value={301}>301 · Permanente</option>
            <option value={302}>302 · Temporal</option>
            <option value={308}>308 · Permanente (mantiene método)</option>
            <option value={307}>307 · Temporal (mantiene método)</option>
          </Select>
        </Field>
        <Toggle checked={f.preserve_path} onChange={(v) => set('preserve_path', v)} label="Conservar la ruta y los parámetros" description="antiguo.com/blog?id=1 → nuevo.com/blog?id=1" />
      </div>
    </Modal>
  );
}

export default function Proxy() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'routes' | 'redirects' | 'engine'>('routes');
  const routes = useQuery({ queryKey: ['proxy'], queryFn: () => api.get<ProxyRoute[]>('/api/proxy') });
  const redirects = useQuery({ queryKey: ['redirects'], queryFn: () => api.get<Redirect[]>('/api/redirects') });
  const status = useQuery({ queryKey: ['proxy-status'], queryFn: () => api.get<{ lastError: string; lastSync: number; certificates: string[] }>('/api/proxy/status'), enabled: tab === 'engine' });
  const config = useQuery({ queryKey: ['proxy-config'], queryFn: () => api.get<unknown>('/api/proxy/config'), enabled: tab === 'engine' });
  const [editing, setEditing] = useState<{ id?: number; form: ProxyForm } | null>(null);
  const [editingRedirect, setEditingRedirect] = useState<{ id?: number; form: RedirectForm } | null>(null);
  const del = useMutation({
    mutationFn: (path: string) => api.del(path),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['proxy'] });
      qc.invalidateQueries({ queryKey: ['redirects'] });
      toast.success('Eliminado');
    },
  });
  const sync = useMutation({
    mutationFn: () => api.post('/api/proxy/sync'),
    onSuccess: () => {
      toast.success('Configuración reaplicada');
      qc.invalidateQueries({ queryKey: ['proxy-status'] });
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <>
      <PageHeader
        title="Proxy inverso"
        description="Publica cualquier servicio interno o externo con SSL, balanceo y la protección del WAF."
        actions={
          tab === 'redirects' ? (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditingRedirect({ form: emptyRedirect })}>
              Nueva redirección
            </Button>
          ) : (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing({ form: emptyProxy })}>
              Nueva ruta
            </Button>
          )
        }
      />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'routes', label: 'Rutas' },
          { id: 'redirects', label: 'Redirecciones' },
          { id: 'engine', label: 'Motor y certificados' },
        ]}
      />

      {tab === 'routes' && (
        <Card padded={false}>
          {routes.isLoading ? (
            <Spinner />
          ) : routes.error ? (
            <div className="p-4"><ErrorBox error={routes.error} /></div>
          ) : routes.data!.length === 0 ? (
            <Empty icon={<ArrowLeftRight className="size-6" />} title="Sin rutas" description="Ej.: grafana.midominio.com → 127.0.0.1:3001, o app.midominio.com → servidor en otra máquina." />
          ) : (
            <Table head={['Origen', '', 'Destino', 'Estado', '']}>
              {routes.data!.map((r) => (
                <tr key={r.id} className="group">
                  <Td>
                    <div className="flex items-center gap-1.5 font-medium">
                      <Lock className="size-3.5 text-ok" />
                      {r.hostname}
                      <span className="text-muted">{r.path_prefix}</span>
                    </div>
                    {r.note && <div className="text-xs text-muted">{r.note}</div>}
                  </Td>
                  <Td className="w-6 text-muted"><ArrowRight className="size-4" /></Td>
                  <Td>
                    <div className="space-y-0.5 font-mono text-[12.5px]">
                      {r.upstreams.map((u) => <div key={u}>{u}</div>)}
                    </div>
                    {r.upstreams.length > 1 && <div className="text-xs text-muted">{r.lb_policy}</div>}
                  </Td>
                  <Td>{r.enabled ? <Badge tone="ok" dot>Activa</Badge> : <Badge>Pausada</Badge>}</Td>
                  <Td className="w-24">
                    <div className="flex justify-end gap-0.5 opacity-60 group-hover:opacity-100">
                      <Button size="sm" variant="ghost" aria-label="Editar" onClick={() => setEditing({ id: r.id, form: { ...r } })}><Pencil className="size-3.5" /></Button>
                      <Button size="sm" variant="ghost" aria-label="Eliminar" onClick={() => del.mutate(`/api/proxy/${r.id}`)}><Trash2 className="size-3.5" /></Button>
                    </div>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}

      {tab === 'redirects' && (
        <Card padded={false}>
          {redirects.isLoading ? (
            <Spinner />
          ) : redirects.data!.length === 0 ? (
            <Empty title="Sin redirecciones" description="Redirige dominios antiguos, rutas o fuerza el uso de un dominio canónico." />
          ) : (
            <Table head={['Desde', '', 'Hacia', 'Código', '']}>
              {redirects.data!.map((r) => (
                <tr key={r.id} className="group">
                  <Td className="font-medium">{r.hostname}<span className="text-muted">{r.path}</span></Td>
                  <Td className="w-6 text-muted"><ArrowRight className="size-4" /></Td>
                  <Td className="font-mono text-[12.5px]">{r.target}{r.preserve_path && <span className="text-muted">/…</span>}</Td>
                  <Td><Badge>{r.code}</Badge></Td>
                  <Td className="w-24">
                    <div className="flex justify-end gap-0.5 opacity-60 group-hover:opacity-100">
                      <Button size="sm" variant="ghost" aria-label="Editar" onClick={() => setEditingRedirect({ id: r.id, form: { ...r } })}><Pencil className="size-3.5" /></Button>
                      <Button size="sm" variant="ghost" aria-label="Eliminar" onClick={() => del.mutate(`/api/redirects/${r.id}`)}><Trash2 className="size-3.5" /></Button>
                    </div>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}

      {tab === 'engine' && (
        <div className="space-y-4">
          <Card
            title="Estado de Caddy"
            actions={<Button size="sm" loading={sync.isPending} onClick={() => sync.mutate()}>Reaplicar configuración</Button>}
          >
            {status.data?.lastError ? (
              <ErrorBox error={status.data.lastError} />
            ) : (
              <p className="text-[13px] text-muted">
                {status.data?.lastSync ? `Última sincronización: ${new Date(status.data.lastSync).toLocaleString()}` : 'Sin sincronizar todavía.'}
              </p>
            )}
            <div className="mt-4">
              <div className="mb-2 text-[13px] font-medium">Certificados SSL emitidos ({status.data?.certificates.length ?? 0})</div>
              <div className="flex flex-wrap gap-1.5">
                {status.data?.certificates.map((c) => <Badge key={c} tone="ok"><Lock className="size-3" />{c}</Badge>)}
              </div>
            </div>
          </Card>
          <Card title={<span className="flex items-center gap-2"><Code className="size-4" /> Configuración generada (solo lectura)</span>}>
            <pre className="max-h-[480px] overflow-auto rounded-md bg-surface-2 p-3 font-mono text-[11.5px]">{config.data ? JSON.stringify(config.data, null, 2) : '…'}</pre>
          </Card>
        </div>
      )}

      {editing && <ProxyModal key={editing.id ?? 'new'} id={editing.id} initial={editing.form} onClose={() => setEditing(null)} />}
      {editingRedirect && <RedirectModal key={editingRedirect.id ?? 'new'} id={editingRedirect.id} initial={editingRedirect.form} onClose={() => setEditingRedirect(null)} />}
    </>
  );
}
