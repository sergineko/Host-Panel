import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowRight, Cookie, Globe, HeartPulse, Network, Pencil, Plus, RefreshCw, Server, Shuffle, Trash2, Zap } from 'lucide-react';
import { api, type LbOrigin, type LbPolicy, type LbStatus, type LoadBalancer } from '../lib/api';
import { HostnamesInput } from '../components/SiteForm';
import { Badge, Button, Callout, Card, ChoiceCard, ConfirmButton, Empty, ErrorBox, Field, Input, Modal, PageHeader, Spinner, Toggle, cx } from '../components/ui';

type LbForm = Omit<LoadBalancer, 'id' | 'created_at'>;

const emptyOrigin: LbOrigin = { address: '', weight: 1, enabled: true, label: '', server_id: null };
const emptyLb: LbForm = {
  name: '',
  hostnames: [],
  path_prefix: '',
  origins: [{ ...emptyOrigin }, { ...emptyOrigin }],
  policy: 'round_robin',
  sticky_cookie: '',
  health_enabled: true,
  health_path: '/',
  health_interval: 10,
  health_timeout: 5,
  health_status: 200,
  max_fails: 3,
  fail_duration: 30,
  retries: 2,
  preserve_host: true,
  tls_skip_verify: false,
  enabled: true,
  note: '',
};

export const POLICIES: { id: LbPolicy; label: string; description: string }[] = [
  { id: 'round_robin', label: 'Por turnos', description: 'Reparte las visitas una a una entre los orígenes. Lo más habitual.' },
  { id: 'weighted_round_robin', label: 'Por turnos con peso', description: 'Como por turnos, pero los orígenes con más peso reciben más visitas.' },
  { id: 'least_conn', label: 'Menos conexiones', description: 'Envía cada visita al origen con menos peticiones en curso.' },
  { id: 'ip_hash', label: 'Por IP del visitante', description: 'Cada visitante va siempre al mismo origen (útil con sesiones locales).' },
  { id: 'cookie', label: 'Sesión fija con cookie', description: 'Una cookie mantiene a cada visitante en el mismo origen.' },
  { id: 'first', label: 'Principal y reserva', description: 'Todo va al primer origen sano; los demás solo si cae.' },
  { id: 'random', label: 'Aleatorio', description: 'Elige un origen al azar en cada visita.' },
  { id: 'uri_hash', label: 'Por URL', description: 'La misma URL va siempre al mismo origen (mejora las cachés).' },
];
const policyLabel = (p: string) => POLICIES.find((x) => x.id === p)?.label ?? p;

interface Sources {
  local: { id: number; name: string; host: string };
  servers: { id: number; name: string; host: string; status: string }[];
}

function OriginsEditor({ origins, weighted, onChange }: { origins: LbOrigin[]; weighted: boolean; onChange: (v: LbOrigin[]) => void }) {
  const sources = useQuery({ queryKey: ['lb-sources'], queryFn: () => api.get<Sources>('/api/load-balancers-sources') });
  const set = (i: number, patch: Partial<LbOrigin>) => onChange(origins.map((o, j) => (j === i ? { ...o, ...patch } : o)));
  const addServer = (s: { id: number; name: string; host: string }) => {
    const blank = origins.findIndex((o) => !o.address.trim());
    const entry: LbOrigin = { ...emptyOrigin, address: `${s.host}:80`, label: s.name, server_id: s.id };
    onChange(blank >= 0 ? origins.map((o, j) => (j === blank ? entry : o)) : [...origins, entry]);
  };
  const known = sources.data ? [sources.data.local, ...sources.data.servers] : [];
  return (
    <div className="space-y-2">
      <div className="hidden grid-cols-[1fr_140px_70px_36px_36px] gap-2 px-1 text-[11.5px] text-muted uppercase sm:grid">
        <span>Dirección</span>
        <span>Nombre</span>
        <span>{weighted ? 'Peso' : ''}</span>
        <span>Activo</span>
        <span />
      </div>
      {origins.map((o, i) => (
        <div key={i} className={cx('grid grid-cols-[1fr_auto] gap-2 rounded-lg sm:grid-cols-[1fr_140px_70px_36px_36px]', !o.enabled && 'opacity-60')}>
          <Input className="font-mono text-[13px]" value={o.address} placeholder="10.0.0.5:8080 o https://app2.interno" onChange={(e) => set(i, { address: e.target.value })} />
          <Input className="col-span-2 sm:col-span-1" value={o.label} placeholder="web-2" onChange={(e) => set(i, { label: e.target.value })} />
          {weighted ? (
            <Input type="number" min={1} max={100} value={o.weight} onChange={(e) => set(i, { weight: Math.max(1, Number(e.target.value) || 1) })} aria-label="Peso" />
          ) : (
            <span className="hidden sm:block" />
          )}
          <label className="grid place-items-center">
            <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={o.enabled} onChange={(e) => set(i, { enabled: e.target.checked })} aria-label="Activo" />
          </label>
          <Button type="button" variant="ghost" aria-label="Quitar origen" disabled={origins.length <= 1} onClick={() => onChange(origins.filter((_, j) => j !== i))}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button type="button" size="sm" icon={<Plus className="size-3.5" />} onClick={() => onChange([...origins, { ...emptyOrigin }])}>
          Añadir origen
        </Button>
        {known.length > 0 && <span className="text-xs text-muted">o añade un servidor del panel:</span>}
        {known.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => addServer(s)}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-2 px-2 py-1 text-xs hover:border-accent/40 hover:text-accent"
          >
            <Server className="size-3" /> {s.name} <span className="font-mono text-muted">{s.host}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function LbModal({ initial, id, onClose }: { initial: LbForm; id?: number; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState<LbForm>(initial);
  const [advanced, setAdvanced] = useState(false);
  const set = <K extends keyof LbForm>(k: K, v: LbForm[K]) => setF((prev) => ({ ...prev, [k]: v }));
  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, origins: f.origins.map((o) => ({ ...o, address: o.address.trim() })).filter((o) => o.address) };
      return id ? api.put<LoadBalancer>(`/api/load-balancers/${id}`, body) : api.post<LoadBalancer>('/api/load-balancers', body);
    },
    onSuccess: () => {
      toast.success('Balanceador aplicado');
      qc.invalidateQueries({ queryKey: ['load-balancers'] });
      onClose();
    },
  });
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={id ? `Editar ${initial.name}` : 'Nuevo balanceador de carga'}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={save.isPending} disabled={!f.name || !f.hostnames.length} onClick={() => save.mutate()}>
            Guardar y aplicar
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        {save.error && <ErrorBox error={save.error} />}

        <section className="space-y-3">
          <h3 className="flex items-center gap-2 font-semibold">
            <Globe className="size-4 text-muted" /> Entrada
          </h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Nombre">
              <Input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="API de la tienda" autoFocus />
            </Field>
            <Field label="Ruta (opcional)" hint="Solo balancea esta parte de la web, por ejemplo /api.">
              <Input value={f.path_prefix} onChange={(e) => set('path_prefix', e.target.value.trim())} placeholder="/" className="font-mono" />
            </Field>
          </div>
          <Field label="Dominios" hint="Apunta su DNS a este servidor. El certificado SSL se emite solo.">
            <HostnamesInput value={f.hostnames} onChange={(v) => set('hostnames', v)} />
          </Field>
        </section>

        <section className="space-y-3">
          <h3 className="flex items-center gap-2 font-semibold">
            <Server className="size-4 text-muted" /> Servidores de origen
          </h3>
          <OriginsEditor origins={f.origins} weighted={f.policy === 'weighted_round_robin'} onChange={(v) => set('origins', v)} />
        </section>

        <section className="space-y-3">
          <h3 className="flex items-center gap-2 font-semibold">
            <Shuffle className="size-4 text-muted" /> Reparto de las visitas
          </h3>
          <div className="grid gap-2 sm:grid-cols-2">
            {POLICIES.map((p) => (
              <ChoiceCard key={p.id} selected={f.policy === p.id} onClick={() => set('policy', p.id)} title={p.label} description={p.description} />
            ))}
          </div>
          {f.policy === 'cookie' && (
            <Field label="Nombre de la cookie" hint="Por defecto, hp_lb.">
              <Input value={f.sticky_cookie} onChange={(e) => set('sticky_cookie', e.target.value.trim())} placeholder="hp_lb" className="font-mono" />
            </Field>
          )}
        </section>

        <section className="space-y-1">
          <h3 className="flex items-center gap-2 font-semibold">
            <HeartPulse className="size-4 text-muted" /> Comprobación de salud
          </h3>
          <Toggle
            checked={f.health_enabled}
            onChange={(v) => set('health_enabled', v)}
            label="Comprobar los orígenes periódicamente"
            description="Los que no respondan bien dejan de recibir visitas hasta que se recuperen."
          />
          {f.health_enabled && (
            <div className="grid gap-3 pb-2 sm:grid-cols-4">
              <Field label="Ruta" className="sm:col-span-2">
                <Input value={f.health_path} onChange={(e) => set('health_path', e.target.value.trim())} className="font-mono" placeholder="/health" />
              </Field>
              <Field label="Cada (s)">
                <Input type="number" min={2} value={f.health_interval} onChange={(e) => set('health_interval', Number(e.target.value))} />
              </Field>
              <Field label="Código esperado">
                <Input type="number" min={100} max={599} value={f.health_status} onChange={(e) => set('health_status', Number(e.target.value))} />
              </Field>
            </div>
          )}
        </section>

        <div>
          <button type="button" className="text-[13px] font-medium text-accent hover:underline" onClick={() => setAdvanced(!advanced)}>
            {advanced ? 'Ocultar opciones avanzadas' : 'Mostrar opciones avanzadas'}
          </button>
          {advanced && (
            <div className="mt-3 space-y-1">
              <div className="grid gap-3 sm:grid-cols-4">
                <Field label="Espera máx. (s)" hint="Por comprobación">
                  <Input type="number" min={1} value={f.health_timeout} onChange={(e) => set('health_timeout', Number(e.target.value))} />
                </Field>
                <Field label="Fallos para apartar" hint="Errores seguidos">
                  <Input type="number" min={1} value={f.max_fails} onChange={(e) => set('max_fails', Number(e.target.value))} />
                </Field>
                <Field label="Apartado durante (s)">
                  <Input type="number" min={1} value={f.fail_duration} onChange={(e) => set('fail_duration', Number(e.target.value))} />
                </Field>
                <Field label="Reintentos" hint="En otro origen">
                  <Input type="number" min={0} max={10} value={f.retries} onChange={(e) => set('retries', Number(e.target.value))} />
                </Field>
              </div>
              <Toggle checked={f.preserve_host} onChange={(v) => set('preserve_host', v)} label="Mantener el dominio original" description="Los orígenes reciben la cabecera Host del visitante." />
              <Toggle
                checked={f.tls_skip_verify}
                onChange={(v) => set('tls_skip_verify', v)}
                label="No verificar el certificado de los orígenes"
                description="Solo para orígenes https con certificado propio en una red privada."
              />
              <Toggle checked={f.enabled} onChange={(v) => set('enabled', v)} label="Activo" description="Si lo desactivas, se deja de servir sin borrar la configuración." />
              <Field label="Nota">
                <Input value={f.note} onChange={(e) => set('note', e.target.value)} />
              </Field>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

const stateStyle = {
  healthy: { dot: 'bg-ok', label: 'Sano', tone: 'ok' as const },
  unhealthy: { dot: 'bg-danger', label: 'Caído', tone: 'danger' as const },
  disabled: { dot: 'bg-border-strong', label: 'Desactivado', tone: 'neutral' as const },
};

function LbCard({ lb, onEdit }: { lb: LoadBalancer; onEdit: () => void }) {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ['lb-status', lb.id],
    queryFn: () => api.get<LbStatus>(`/api/load-balancers/${lb.id}/status`),
    enabled: lb.enabled,
    refetchInterval: 15_000,
  });
  const byAddress = new Map(status.data?.origins.map((o) => [o.address, o]));
  const healthy = status.data?.origins.filter((o) => o.state === 'healthy').length;
  const active = lb.origins.filter((o) => o.enabled).length;
  const toggle = useMutation({
    mutationFn: () => api.put(`/api/load-balancers/${lb.id}`, { ...lb, enabled: !lb.enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['load-balancers'] }),
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Card
      padded={false}
      icon={<Network />}
      title={lb.name}
      description={
        <span className="flex flex-wrap items-center gap-x-1.5">
          {lb.hostnames.map((h) => (
            <a key={h} href={`https://${h}${lb.path_prefix}`} target="_blank" rel="noreferrer" className="font-mono hover:text-accent">
              {h}
              {lb.path_prefix}
            </a>
          ))}
        </span>
      }
      actions={
        <>
          {!lb.enabled ? (
            <Badge>Desactivado</Badge>
          ) : status.data ? (
            <Badge tone={healthy === active ? 'ok' : healthy ? 'warn' : 'danger'} dot>
              {healthy}/{active} sanos
            </Badge>
          ) : null}
          <Button size="sm" variant="ghost" aria-label="Comprobar ahora" loading={status.isFetching} onClick={() => status.refetch()} disabled={!lb.enabled}>
            <RefreshCw className="size-3.5" />
          </Button>
          <Button size="sm" variant="ghost" aria-label="Editar" onClick={onEdit}>
            <Pencil className="size-3.5" />
          </Button>
          <ConfirmButton
            size="sm"
            variant="ghost"
            aria-label="Eliminar"
            title={`Eliminar ${lb.name}`}
            message="Los dominios dejarán de responder a través de este balanceador. Los servidores de origen no se tocan."
            onConfirm={async () => {
              await api.del(`/api/load-balancers/${lb.id}`);
              qc.invalidateQueries({ queryKey: ['load-balancers'] });
            }}
          >
            <Trash2 className="size-3.5" />
          </ConfirmButton>
        </>
      }
    >
      <div className="flex flex-wrap gap-x-5 gap-y-1 border-b border-border px-4 py-2 text-xs text-muted">
        <span className="inline-flex items-center gap-1">
          {lb.policy === 'cookie' ? <Cookie className="size-3.5" /> : <Shuffle className="size-3.5" />} {policyLabel(lb.policy)}
        </span>
        <span className="inline-flex items-center gap-1">
          <HeartPulse className="size-3.5" /> {lb.health_enabled ? `Comprobación ${lb.health_path} cada ${lb.health_interval} s` : 'Sin comprobación activa'}
        </span>
        <span className="inline-flex items-center gap-1">
          <Zap className="size-3.5" /> {lb.retries} reintento{lb.retries === 1 ? '' : 's'}
        </span>
        <button className="ml-auto font-medium text-accent hover:underline" disabled={toggle.isPending} onClick={() => toggle.mutate()}>
          {lb.enabled ? 'Desactivar' : 'Activar'}
        </button>
      </div>
      <ul className="divide-y divide-border">
        {lb.origins.map((o) => {
          const s = byAddress.get(o.address);
          const st = stateStyle[!o.enabled || !lb.enabled ? 'disabled' : (s?.state ?? 'disabled')];
          return (
            <li key={o.address} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
              <span className={cx('size-2 shrink-0 rounded-full', s || !o.enabled || !lb.enabled ? st.dot : 'animate-pulse bg-border-strong')} />
              <span className="min-w-0 flex-1">
                <span className="font-mono text-[13px]">{o.address}</span>
                {o.label && <span className="ml-2 text-xs text-muted">{o.label}</span>}
                {s?.error && <span className="block truncate text-xs text-danger">{s.error}</span>}
              </span>
              {lb.policy === 'weighted_round_robin' && <Badge>peso {o.weight}</Badge>}
              {s && s.state !== 'disabled' && (
                <span className="tabular text-xs text-muted">
                  {s.status ?? '—'} · {s.ms ?? '—'} ms · {s.requests} en curso
                </span>
              )}
              {(s || !o.enabled || !lb.enabled) && <Badge tone={st.tone}>{st.label}</Badge>}
            </li>
          );
        })}
      </ul>
      {status.error && (
        <div className="p-3">
          <ErrorBox error={status.error} />
        </div>
      )}
    </Card>
  );
}

export default function LoadBalancers() {
  const q = useQuery({ queryKey: ['load-balancers'], queryFn: () => api.get<LoadBalancer[]>('/api/load-balancers') });
  const [editing, setEditing] = useState<{ form: LbForm; id?: number } | null>(null);
  const create = () => setEditing({ form: { ...emptyLb, origins: emptyLb.origins.map((o) => ({ ...o })) } });
  return (
    <>
      <PageHeader
        title="Balanceadores de carga"
        description="Reparte las visitas de un dominio entre varios servidores, aparta los que fallan y los vuelve a usar cuando se recuperan."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={create}>
            Nuevo balanceador
          </Button>
        }
      />
      {q.isLoading ? (
        <Spinner />
      ) : q.error ? (
        <ErrorBox error={q.error} />
      ) : q.data!.length === 0 ? (
        <Card>
          <Empty
            icon={<Network className="size-6" />}
            title="Sin balanceadores"
            description="Pon varios servidores detrás de un mismo dominio para repartir la carga y seguir en línea si uno cae."
            action={
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={create}>
                Crear balanceador
              </Button>
            }
          />
          <div className="mx-auto mb-8 flex max-w-md items-center justify-center gap-3 text-xs text-muted">
            <span className="rounded-lg border border-border px-2.5 py-1.5">Visitantes</span>
            <ArrowRight className="size-4" />
            <span className="rounded-lg border border-accent/40 bg-accent-soft px-2.5 py-1.5 text-accent">Balanceador</span>
            <ArrowRight className="size-4" />
            <span className="flex flex-col gap-1">
              <span className="rounded-lg border border-border px-2.5 py-1">Servidor 1</span>
              <span className="rounded-lg border border-border px-2.5 py-1">Servidor 2</span>
            </span>
          </div>
        </Card>
      ) : (
        <div className="space-y-4">
          <Callout tone="info" title="Cómo funciona">
            El balanceador recibe las visitas en este servidor (con SSL automático) y las reenvía a los orígenes. Un sitio web del panel con varios servidores ya se balancea solo; usa esto para
            aplicaciones externas o servidores que no gestiona el panel.
          </Callout>
          {q.data!.map((lb) => (
            <LbCard key={lb.id} lb={lb} onEdit={() => setEditing({ form: lb, id: lb.id })} />
          ))}
        </div>
      )}
      {editing && <LbModal initial={editing.form} id={editing.id} onClose={() => setEditing(null)} />}
    </>
  );
}
