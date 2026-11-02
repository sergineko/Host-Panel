import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Clock, ExternalLink, Eye, Inbox, KeyRound, Pause, Play, Plus, Rocket, RotateCcw, Send, Trash2, X } from 'lucide-react';
import { api, type BindingType, type DeployResult, type Worker, type WorkerEvent } from '../lib/api';
import { compact, timeAgo } from '../lib/format';
import { BarChart } from '../components/BarChart';
import { Badge, Button, Card, ConfirmButton, ErrorBox, Input, Modal, PageHeader, Select, Spinner, StickyActions, Table, Tabs, Td, Textarea, Toggle, cx } from '../components/ui';
import { WorkerStatus } from './Workers';

const CodeEditor = lazy(() => import('../components/CodeEditor'));

type Tab = 'code' | 'metrics' | 'triggers' | 'settings' | 'logs' | 'versions';
interface Settings {
  routes: string[];
  subdomain: boolean;
  crons: string[];
  vars: Record<string, string>;
  bindings: { type: BindingType; name: string; id: number }[];
  memory_mb: number;
  enabled: boolean;
}
const settingsOf = (w: Worker): Settings => ({
  routes: w.routes,
  subdomain: w.subdomain,
  crons: w.crons.map((c) => c.cron),
  vars: w.vars,
  bindings: w.bindings.map(({ type, name, id }) => ({ type, name, id })),
  memory_mb: w.memory_mb,
  enabled: w.enabled,
});

function useSaveSettings(w: Worker) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<Settings>) => api.put<Worker & { deploy: DeployResult }>(`/api/workers/${w.id}/settings`, { ...settingsOf(w), ...patch }),
    onSuccess: (r) => {
      qc.setQueryData(['worker', w.id], (old: Worker | undefined) => ({ ...r, code: old?.code }));
      qc.invalidateQueries({ queryKey: ['workers'] });
      if (r.deploy && !r.deploy.ok) toast.error('Guardado, pero el Worker no arrancó: revisa los logs');
      else toast.success('Guardado y aplicado');
    },
    onError: (e) => toast.error(e.message),
  });
}

// --- live console ------------------------------------------------------------------------

const levelColor: Record<string, string> = { error: 'text-[#ff8a8a]', warn: 'text-[#f0c060]', info: 'text-[#9ec5ff]', debug: 'text-[#8d95a5]', log: 'text-[#cfd5df]' };

function EventRow({ e }: { e: WorkerEvent }) {
  const time = new Date(e.ts).toLocaleTimeString('es', { hour12: false });
  const failed = !!e.exception || (e.status ?? 0) >= 500;
  return (
    <div className="border-b border-white/5 px-3 py-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[#6b7385]">{time}</span>
        {e.type === 'fetch' && (
          <>
            <span className={cx('rounded px-1 text-[11px] font-semibold', failed ? 'bg-[#ff8a8a]/20 text-[#ff8a8a]' : (e.status ?? 0) >= 400 ? 'bg-[#f0c060]/20 text-[#f0c060]' : 'bg-[#6ee7a0]/15 text-[#6ee7a0]')}>{e.status}</span>
            <span className="text-[#f6a35c]">{e.method}</span>
            <span className="min-w-0 flex-1 truncate">{e.url?.replace(/^https?:\/\/[^/]+/, '')}</span>
            <span className="text-[#6b7385]">{e.duration} ms</span>
          </>
        )}
        {e.type === 'queue' && (
          <span className="flex-1">
            <span className="text-[#c4a7ff]">cola</span> {e.queue} · {e.count} mensajes · {e.duration} ms
          </span>
        )}
        {e.type === 'scheduled' && (
          <span className="flex-1">
            <span className="text-[#c4a7ff]">cron</span> {e.cron} · {e.duration} ms
          </span>
        )}
        {(e.type === 'log' || e.type === 'system') && e.logs?.[0] && (
          <span className={cx('flex-1 whitespace-pre-wrap', e.type === 'system' ? 'text-[#8d95a5] italic' : levelColor[e.logs[0].level])}>{e.logs[0].message}</span>
        )}
      </div>
      {e.type !== 'log' && e.type !== 'system' &&
        e.logs?.map((l, i) => (
          <div key={i} className={cx('mt-0.5 pl-[72px] whitespace-pre-wrap', levelColor[l.level] ?? levelColor.log)}>
            {l.message}
          </div>
        ))}
      {e.exception && <pre className="mt-1 ml-[72px] whitespace-pre-wrap text-[#ff8a8a]">{e.exception}</pre>}
    </div>
  );
}

function LogStream({ workerId, className, compactView }: { workerId: number; className?: string; compactView?: boolean }) {
  const [events, setEvents] = useState<WorkerEvent[]>([]);
  const [paused, setPaused] = useState(false);
  const after = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    if (paused) return;
    let stop = false;
    const tick = async () => {
      try {
        const list = await api.get<WorkerEvent[]>(`/api/workers/${workerId}/events?after=${after.current}`);
        if (stop || !list.length) return;
        after.current = list.at(-1)!.seq;
        setEvents((prev) => [...prev, ...list].slice(-300));
      } catch {
        /* ignore transient errors */
      }
    };
    void tick();
    const t = setInterval(tick, 1000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [workerId, paused]);

  useEffect(() => {
    if (box.current && stick.current) box.current.scrollTop = box.current.scrollHeight;
  }, [events]);

  return (
    <div className={cx('flex min-h-0 flex-col overflow-hidden rounded-md border border-border bg-[#0b0d11]', className)}>
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-1.5 text-xs text-[#8d95a5]">
        <span className={cx('size-1.5 rounded-full', paused ? 'bg-[#6b7385]' : 'animate-pulse bg-[#6ee7a0]')} />
        {compactView ? 'Consola' : 'Logs en tiempo real'}
        <span className="ml-auto flex gap-1">
          <button className="rounded p-1 hover:bg-white/10" onClick={() => setPaused(!paused)} aria-label={paused ? 'Reanudar' : 'Pausar'}>
            {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
          </button>
          <button className="rounded p-1 hover:bg-white/10" onClick={() => setEvents([])} aria-label="Limpiar">
            <X className="size-3.5" />
          </button>
        </span>
      </div>
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="min-h-0 flex-1 overflow-auto font-mono text-[12px] leading-relaxed text-[#cfd5df]"
      >
        {events.length === 0 ? <p className="p-3 text-[#6b7385]">Esperando peticiones… Los console.log del Worker aparecen aquí.</p> : events.map((e) => <EventRow key={e.seq} e={e} />)}
      </div>
    </div>
  );
}

// --- editor + tester ---------------------------------------------------------------------

interface TestResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  duration: number;
  size: number;
  body: string | null;
  truncated: boolean;
}

function Tester({ w }: { w: Worker }) {
  const [method, setMethod] = useState('GET');
  const [path, setPath] = useState('/');
  const [body, setBody] = useState('');
  const [showHeaders, setShowHeaders] = useState(false);
  const send = useMutation({
    mutationFn: () =>
      api.post<TestResult>(`/api/workers/${w.id}/test`, {
        method,
        path,
        body: ['GET', 'HEAD'].includes(method) ? undefined : body,
        headers: body.trim().startsWith('{') ? { 'content-type': 'application/json' } : {},
      }),
  });
  const r = send.data;
  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-md border border-border bg-surface">
      <form
        className="flex gap-1.5 border-b border-border p-2"
        onSubmit={(e) => {
          e.preventDefault();
          send.mutate();
        }}
      >
        <Select className="!w-24 !px-2 font-mono text-[12.5px]" value={method} onChange={(e) => setMethod(e.target.value)}>
          {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
            <option key={m}>{m}</option>
          ))}
        </Select>
        <Input className="font-mono text-[12.5px]" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/ruta?x=1" />
        <Button variant="primary" type="submit" loading={send.isPending} aria-label="Enviar" icon={<Send className="size-3.5" />} />
      </form>
      {!['GET', 'HEAD'].includes(method) && (
        <Textarea className="min-h-16 rounded-none border-0 border-b !ring-0" value={body} onChange={(e) => setBody(e.target.value)} placeholder='{"nombre": "valor"}' />
      )}
      <div className="min-h-0 flex-1 overflow-auto p-3 text-[13px]">
        {send.error ? (
          <ErrorBox error={send.error} />
        ) : r ? (
          <>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Badge tone={r.status >= 500 ? 'danger' : r.status >= 400 ? 'warn' : 'ok'}>
                {r.status} {r.statusText}
              </Badge>
              <span className="tabular text-xs text-muted">
                {r.duration} ms · {r.size} B
              </span>
              <button className="ml-auto text-xs text-muted hover:text-fg" onClick={() => setShowHeaders(!showHeaders)}>
                {showHeaders ? 'Ocultar' : 'Ver'} cabeceras
              </button>
            </div>
            {showHeaders && (
              <div className="mb-2 rounded bg-surface-2 p-2 font-mono text-[11.5px]">
                {Object.entries(r.headers).map(([k, v]) => (
                  <div key={k}>
                    <span className="text-muted">{k}:</span> {v}
                  </div>
                ))}
              </div>
            )}
            <pre className="font-mono text-[12px] whitespace-pre-wrap">{r.body === null ? '(respuesta binaria)' : prettyBody(r.body) || '(vacío)'}</pre>
          </>
        ) : (
          <p className="text-muted">Envía una petición para probar el Worker desplegado.</p>
        )}
      </div>
    </div>
  );
}

function prettyBody(text: string) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function EditorTab({ w }: { w: Worker }) {
  const qc = useQueryClient();
  const [code, setCode] = useState(w.code ?? '');
  const [deployError, setDeployError] = useState<string | null>(null);
  const dirty = code !== w.code;
  const deploy = useMutation({
    mutationFn: () => api.put<DeployResult>(`/api/workers/${w.id}/code`, { code }),
    onSuccess: (r) => {
      if (r.ok) {
        setDeployError(null);
        toast.success(`Versión ${r.version} desplegada`);
        qc.setQueryData(['worker', w.id], (old: Worker | undefined) => (old ? { ...old, code, version: r.version ?? old.version, status: 'running', last_error: '' } : old));
        qc.invalidateQueries({ queryKey: ['worker-versions', w.id] });
      } else {
        setDeployError(r.error ?? 'Error');
        toast.error(r.stage === 'syntax' ? 'Error de sintaxis: no se desplegó' : 'La nueva versión no arrancó: sigue activa la anterior');
      }
    },
    onError: (e) => toast.error(e.message),
  });
  const save = () => dirty && !deploy.isPending && deploy.mutate();

  return (
    <div className="grid gap-4 lg:h-[calc(100vh-230px)] lg:min-h-[560px] lg:grid-cols-[minmax(0,1fr)_400px]">
      <div className="flex min-h-[480px] flex-col overflow-hidden rounded-lg border border-border">
        <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2">
          <span className="font-mono text-[13px]">worker.js</span>
          {dirty ? <Badge tone="warn">Sin desplegar</Badge> : <Badge>v{w.version}</Badge>}
          <span className="ml-auto hidden text-xs text-muted sm:inline">Ctrl + S para desplegar</span>
          <Button size="sm" disabled={!dirty} onClick={() => setCode(w.code ?? '')}>
            Descartar
          </Button>
          <Button size="sm" variant="primary" icon={<Rocket className="size-3.5" />} disabled={!dirty} loading={deploy.isPending} onClick={save}>
            Desplegar
          </Button>
        </div>
        {deployError && (
          <div className="flex items-start gap-2 border-b border-danger/30 bg-danger-soft px-3 py-2">
            <pre className="min-w-0 flex-1 overflow-x-auto font-mono text-[12px] whitespace-pre-wrap text-danger">{deployError}</pre>
            <button onClick={() => setDeployError(null)} className="text-danger" aria-label="Cerrar">
              <X className="size-4" />
            </button>
          </div>
        )}
        <Suspense fallback={<Spinner className="flex-1 bg-[#282c34]" />}>
          <CodeEditor value={code} onChange={setCode} onSave={save} className="min-h-0 flex-1 overflow-hidden bg-[#282c34]" />
        </Suspense>
      </div>
      <div className="grid min-h-[480px] grid-rows-2 gap-4 lg:min-h-0">
        <Tester w={w} />
        <LogStream workerId={w.id} compactView />
      </div>
    </div>
  );
}

// --- metrics ----------------------------------------------------------------------------

interface Metrics {
  series: { hour: number; requests: number; errors: number; avg_ms: number; queue_messages: number; cron_runs: number }[];
  total: { requests: number; errors: number; avg_ms: number; queue_messages: number; cron_runs: number };
}

function MetricsTab({ w }: { w: Worker }) {
  const [hours, setHours] = useState(24);
  const q = useQuery({ queryKey: ['worker-metrics', w.id, hours], queryFn: () => api.get<Metrics>(`/api/workers/${w.id}/metrics?hours=${hours}`), refetchInterval: 15_000 });
  if (q.isLoading) return <Spinner />;
  const m = q.data!;
  const tiles = [
    ['Peticiones', compact(m.total.requests)],
    ['Errores', compact(m.total.errors)],
    ['Tasa de error', m.total.requests ? `${((m.total.errors / m.total.requests) * 100).toFixed(1)} %` : '0 %'],
    ['Duración media', `${m.total.avg_ms} ms`],
    ['Mensajes de cola', compact(m.total.queue_messages)],
    ['Ejecuciones cron', compact(m.total.cron_runs)],
  ];
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Select className="!w-40" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
          <option value={24}>Últimas 24 h</option>
          <option value={168}>Últimos 7 días</option>
          <option value={720}>Últimos 30 días</option>
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {tiles.map(([label, value]) => (
          <div key={label} className="rounded-lg border border-border bg-surface p-3">
            <div className="text-xs text-muted">{label}</div>
            <div className="tabular mt-1 text-xl font-semibold">{value}</div>
          </div>
        ))}
      </div>
      <Card title="Peticiones">
        <BarChart series={m.series.map((s) => ({ hour: s.hour, value: s.requests, bad: s.errors }))} label="peticiones" badLabel="errores" />
      </Card>
    </div>
  );
}

// --- triggers -----------------------------------------------------------------------------

const CRON_PRESETS = [
  ['Cada minuto', '* * * * *'],
  ['Cada 5 minutos', '*/5 * * * *'],
  ['Cada hora', '0 * * * *'],
  ['Cada día a las 03:00 UTC', '0 3 * * *'],
  ['Lunes a las 09:00 UTC', '0 9 * * 1'],
];

function TriggersTab({ w }: { w: Worker }) {
  const save = useSaveSettings(w);
  const [route, setRoute] = useState('');
  const [cron, setCron] = useState('');
  const runCron = useMutation({
    mutationFn: (c: string) => api.post(`/api/workers/${w.id}/cron`, { cron: c }),
    onSuccess: () => toast.success('Ejecutado: mira los logs'),
    onError: (e) => toast.error(e.message),
  });
  return (
    <div className="space-y-4">
      <Card title="Dominios y rutas">
        <div className="divide-y divide-border">
          <Toggle
            checked={w.subdomain}
            onChange={(v) => save.mutate({ subdomain: v })}
            label="Subdominio del Worker"
            description={w.url ? <a className="font-mono hover:text-accent" href={w.url} target="_blank" rel="noreferrer">{w.url}</a> : 'Configura HP_WORKERS_DOMAIN para tener nombre.workers.tu-dominio.'}
          />
          <div className="py-3">
            <div className="font-medium">Rutas</div>
            <p className="mb-3 text-[13px] text-muted">
              El Worker responde en estas rutas de tus dominios antes que el sitio web. Usa <code className="font-mono">*</code> al final: <code className="font-mono">ejemplo.com/api/*</code>.
            </p>
            {w.routes.length > 0 && (
              <ul className="mb-3 divide-y divide-border rounded-md border border-border">
                {w.routes.map((r) => (
                  <li key={r} className="flex items-center gap-2 px-3 py-2 font-mono text-[13px]">
                    <span className="flex-1">{r}</span>
                    <Button size="sm" variant="ghost" aria-label="Quitar ruta" onClick={() => save.mutate({ routes: w.routes.filter((x) => x !== r) })}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (route) save.mutate({ routes: [...w.routes, route] }, { onSuccess: () => setRoute('') });
              }}
            >
              <Input className="font-mono" value={route} onChange={(e) => setRoute(e.target.value.trim())} placeholder="ejemplo.com/api/*" />
              <Button type="submit" icon={<Plus className="size-4" />} loading={save.isPending} disabled={!route}>
                Añadir
              </Button>
            </form>
          </div>
        </div>
      </Card>

      <Card title="Disparadores cron">
        <p className="mb-3 text-[13px] text-muted">
          Ejecutan el manejador <code className="font-mono">scheduled()</code> del Worker. Las horas son UTC, como en Cloudflare.
        </p>
        {w.crons.length > 0 && (
          <ul className="mb-3 divide-y divide-border rounded-md border border-border">
            {w.crons.map((c) => (
              <li key={c.cron} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <Clock className="size-4 text-muted" />
                <code className="font-mono text-[13px]">{c.cron}</code>
                <span className="flex-1 text-xs text-muted">próxima: {c.next[0] ? new Date(c.next[0]).toLocaleString('es') : '—'}</span>
                <Button size="sm" icon={<Play className="size-3.5" />} loading={runCron.isPending && runCron.variables === c.cron} onClick={() => runCron.mutate(c.cron)}>
                  Ejecutar ahora
                </Button>
                <Button size="sm" variant="ghost" aria-label="Quitar cron" onClick={() => save.mutate({ crons: w.crons.map((x) => x.cron).filter((x) => x !== c.cron) })}>
                  <Trash2 className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (cron) save.mutate({ crons: [...w.crons.map((x) => x.cron), cron] }, { onSuccess: () => setCron('') });
          }}
        >
          <Input className="font-mono" value={cron} onChange={(e) => setCron(e.target.value)} placeholder="*/5 * * * *" />
          <Button type="submit" icon={<Plus className="size-4" />} loading={save.isPending} disabled={!cron}>
            Añadir
          </Button>
        </form>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {CRON_PRESETS.map(([label, expr]) => (
            <button key={expr} className="rounded-full border border-border px-2.5 py-0.5 text-xs hover:border-accent hover:text-accent" onClick={() => setCron(expr!)}>
              {label}
            </button>
          ))}
        </div>
      </Card>

      <Card title="Colas">
        {w.consumes.length ? (
          <p className="text-[13px]">
            Consume:{' '}
            {w.consumes.map((c, i) => (
              <span key={c.id}>
                {i > 0 && ', '}
                <Link to={`/queues/${c.id}`} className="font-mono text-accent hover:underline">
                  {c.name}
                </Link>
              </span>
            ))}
          </p>
        ) : (
          <p className="flex items-center gap-2 text-[13px] text-muted">
            <Inbox className="size-4" /> Para que procese mensajes, asígnalo como consumidor en <Link to="/queues" className="text-accent hover:underline">Colas</Link>.
          </p>
        )}
      </Card>
    </div>
  );
}

// --- settings: bindings, variables, secrets ----------------------------------------

const BINDING_TYPES: { id: BindingType; label: string; hint: string }[] = [
  { id: 'sql', label: 'Base de datos SQL', hint: 'env.DB.prepare(sql).bind(…).all()' },
  { id: 'nosql', label: 'Base de datos NoSQL', hint: "env.DOCS.collection('pedidos').find({ … })" },
  { id: 'kv', label: 'Clave-valor (KV)', hint: 'env.KV.get(clave) / put(clave, valor)' },
  { id: 'bucket', label: 'Almacenamiento', hint: 'env.BUCKET.get(clave) / put(clave, datos)' },
  { id: 'queue', label: 'Cola (productor)', hint: 'env.QUEUE.send(mensaje)' },
];

interface Resources {
  sql: { id: number; name: string }[];
  nosql: { id: number; name: string }[];
  kv: { id: number; name: string }[];
  bucket: { id: number; name: string }[];
  queue: { id: number; name: string }[];
}

function SettingsTab({ w }: { w: Worker }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const save = useSaveSettings(w);
  const resources = useQuery({ queryKey: ['worker-resources'], queryFn: () => api.get<Resources>('/api/workers/resources') });
  const [bindings, setBindings] = useState(settingsOf(w).bindings);
  const [vars, setVars] = useState(() => Object.entries(w.vars).map(([k, v]) => ({ k, v })));
  const [memory, setMemory] = useState(w.memory_mb);
  const [enabled, setEnabled] = useState(w.enabled);
  const [secret, setSecret] = useState({ name: '', value: '' });

  const addSecret = useMutation({
    mutationFn: () => api.put<{ ok: boolean }>(`/api/workers/${w.id}/secrets`, secret),
    onSuccess: () => {
      toast.success(`Secreto ${secret.name} guardado`);
      setSecret({ name: '', value: '' });
      qc.invalidateQueries({ queryKey: ['worker', w.id] });
    },
    onError: (e) => toast.error(e.message),
  });
  const delSecret = useMutation({
    mutationFn: (name: string) => api.del(`/api/workers/${w.id}/secrets/${name}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['worker', w.id] }),
  });

  const varsObj = Object.fromEntries(vars.filter((x) => x.k).map((x) => [x.k, x.v]));
  const dirty =
    JSON.stringify(bindings) !== JSON.stringify(settingsOf(w).bindings) || JSON.stringify(varsObj) !== JSON.stringify(w.vars) || memory !== w.memory_mb || enabled !== w.enabled;

  return (
    <div className="space-y-4">
      <Card title="Bindings">
        <p className="mb-3 text-[13px] text-muted">Conectan el Worker con tus bases de datos SQL y NoSQL, espacios KV, almacenamiento y colas. Disponibles como <code className="font-mono">env.NOMBRE</code>.</p>
        <div className="space-y-2">
          {bindings.map((b, i) => {
            const list = resources.data?.[b.type] ?? [];
            return (
              <div key={i} className="grid gap-2 sm:grid-cols-[180px_160px_1fr_auto]">
                <Select value={b.type} onChange={(e) => setBindings(bindings.map((x, j) => (j === i ? { ...x, type: e.target.value as BindingType, id: 0 } : x)))}>
                  {BINDING_TYPES.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </Select>
                <Input className="font-mono" value={b.name} placeholder="NOMBRE" onChange={(e) => setBindings(bindings.map((x, j) => (j === i ? { ...x, name: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') } : x)))} />
                <Select value={b.id || ''} onChange={(e) => setBindings(bindings.map((x, j) => (j === i ? { ...x, id: Number(e.target.value) } : x)))}>
                  <option value="">{list.length ? 'Elige…' : 'No hay ninguno: créalo primero'}</option>
                  {list.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </Select>
                <Button variant="ghost" aria-label="Quitar binding" onClick={() => setBindings(bindings.filter((_, j) => j !== i))}>
                  <Trash2 className="size-4" />
                </Button>
                <p className="-mt-1 text-xs text-muted sm:col-span-4">
                  <code className="font-mono">{BINDING_TYPES.find((t) => t.id === b.type)?.hint.replace(/^env\.\w+/, `env.${b.name || 'NOMBRE'}`)}</code>
                </p>
              </div>
            );
          })}
        </div>
        <Button size="sm" className="mt-2" icon={<Plus className="size-3.5" />} onClick={() => setBindings([...bindings, { type: 'sql', name: '', id: 0 }])}>
          Añadir binding
        </Button>
      </Card>

      <Card title="Variables de entorno">
        <p className="mb-3 text-[13px] text-muted">Texto plano disponible como <code className="font-mono">env.NOMBRE</code>. Para claves de API usa secretos.</p>
        <div className="space-y-2">
          {vars.map((r, i) => (
            <div key={i} className="flex gap-2">
              <Input className="!w-2/5 font-mono" placeholder="NOMBRE" value={r.k} onChange={(e) => setVars(vars.map((x, j) => (j === i ? { ...x, k: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') } : x)))} />
              <Input className="min-w-0 !flex-1 font-mono" placeholder="valor" value={r.v} onChange={(e) => setVars(vars.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} />
              <Button variant="ghost" aria-label="Quitar variable" onClick={() => setVars(vars.filter((_, j) => j !== i))}>
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
        </div>
        <Button size="sm" className="mt-2" icon={<Plus className="size-3.5" />} onClick={() => setVars([...vars, { k: '', v: '' }])}>
          Añadir variable
        </Button>
      </Card>

      <Card title="Secretos">
        <p className="mb-3 text-[13px] text-muted">Cifrados en el panel; el Worker los recibe como <code className="font-mono">env.NOMBRE</code>. No se pueden volver a leer desde aquí.</p>
        {w.secrets.length > 0 && (
          <ul className="mb-3 divide-y divide-border rounded-md border border-border">
            {w.secrets.map((s) => (
              <li key={s} className="flex items-center gap-2 px-3 py-2">
                <KeyRound className="size-4 text-muted" />
                <code className="flex-1 font-mono text-[13px]">{s}</code>
                <span className="text-xs text-muted">••••••••</span>
                <Button size="sm" variant="ghost" aria-label="Borrar secreto" onClick={() => delSecret.mutate(s)}>
                  <Trash2 className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            addSecret.mutate();
          }}
        >
          <Input className="!w-48 font-mono" placeholder="API_KEY" value={secret.name} onChange={(e) => setSecret({ ...secret, name: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') })} />
          <Input className="min-w-48 flex-1" type="password" placeholder="valor" autoComplete="off" value={secret.value} onChange={(e) => setSecret({ ...secret, value: e.target.value })} />
          <Button type="submit" loading={addSecret.isPending} disabled={!secret.name || !secret.value}>
            Guardar secreto
          </Button>
        </form>
      </Card>

      <Card title="Ejecución">
        <div className="divide-y divide-border">
          <Toggle checked={enabled} onChange={setEnabled} label="Worker activo" description="Desactivado deja de responder peticiones, crons y colas." />
          <div className="flex flex-wrap items-center justify-between gap-4 py-3">
            <div>
              <div className="font-medium">Memoria máxima</div>
              <div className="text-[13px] text-muted">Si la supera, el proceso se reinicia.</div>
            </div>
            <Select className="!w-40" value={memory} onChange={(e) => setMemory(Number(e.target.value))}>
              {[64, 128, 256, 512, 1024].map((m) => (
                <option key={m} value={m}>
                  {m} MB
                </option>
              ))}
            </Select>
          </div>
        </div>
      </Card>

      <StickyActions>
        {dirty && <span className="mr-auto self-center text-[13px] text-muted">Cambios sin guardar</span>}
        <Button
          variant="primary"
          disabled={!dirty || bindings.some((b) => !b.name || !b.id)}
          loading={save.isPending}
          onClick={() => save.mutate({ bindings, vars: varsObj, memory_mb: memory, enabled })}
        >
          Guardar y aplicar
        </Button>
      </StickyActions>

      <Card title="Zona peligrosa">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[13px] text-muted">Elimina el Worker, sus versiones, rutas y crons. Las colas que consumía quedan sin consumidor.</p>
          <ConfirmButton
            variant="danger"
            title={`Eliminar ${w.name}`}
            message="No se puede deshacer."
            onConfirm={async () => {
              await api.del(`/api/workers/${w.id}`);
              qc.invalidateQueries({ queryKey: ['workers'] });
              navigate('/workers');
            }}
          >
            Eliminar Worker
          </ConfirmButton>
        </div>
      </Card>
    </div>
  );
}

// --- versions ---------------------------------------------------------------------------

interface Version {
  id: number;
  version: number;
  message: string;
  created_by: string;
  created_at: string;
  size: number;
}

function VersionsTab({ w }: { w: Worker }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['worker-versions', w.id], queryFn: () => api.get<Version[]>(`/api/workers/${w.id}/versions`) });
  const [view, setView] = useState<{ version: number; code: string } | null>(null);
  const rollback = useMutation({
    mutationFn: (version: number) => api.post<DeployResult>(`/api/workers/${w.id}/rollback`, { version }),
    onSuccess: (r) => {
      if (r.ok) toast.success(`Restaurada como versión ${r.version}`);
      else toast.error('No arrancó: sigue la versión actual');
      qc.invalidateQueries({ queryKey: ['worker', w.id] });
      qc.invalidateQueries({ queryKey: ['worker-versions', w.id] });
    },
  });
  if (q.isLoading) return <Spinner />;
  return (
    <>
      <Card padded={false}>
        <Table head={['Versión', 'Descripción', 'Por', 'Cuándo', '']}>
          {q.data?.map((v) => (
            <tr key={v.id}>
              <Td>
                <span className="font-mono font-medium">v{v.version}</span> {v.version === w.version && <Badge tone="accent">Activa</Badge>}
              </Td>
              <Td className="text-muted">{v.message || '—'}</Td>
              <Td className="text-muted">{v.created_by}</Td>
              <Td className="text-muted">{timeAgo(v.created_at)}</Td>
              <Td className="w-56 text-right">
                <div className="flex justify-end gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Eye className="size-3.5" />}
                    onClick={async () => setView({ version: v.version, code: (await api.get<{ code: string }>(`/api/workers/${w.id}/versions/${v.version}`)).code })}
                  >
                    Ver
                  </Button>
                  {v.version !== w.version && (
                    <Button size="sm" icon={<RotateCcw className="size-3.5" />} loading={rollback.isPending && rollback.variables === v.version} onClick={() => rollback.mutate(v.version)}>
                      Restaurar
                    </Button>
                  )}
                </div>
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
      <Modal open={!!view} onClose={() => setView(null)} wide title={`Código de la versión ${view?.version}`}>
        <Suspense fallback={<Spinner />}>{view && <CodeEditor value={view.code} readOnly className="h-[60vh] overflow-hidden rounded-md" />}</Suspense>
      </Modal>
    </>
  );
}

export default function WorkerDetail() {
  const id = Number(useParams().id);
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') ?? 'code') as Tab;
  const q = useQuery({ queryKey: ['worker', id], queryFn: () => api.get<Worker>(`/api/workers/${id}`) });
  const tabs = useMemo(
    () =>
      [
        { id: 'code', label: 'Editor' },
        { id: 'metrics', label: 'Métricas' },
        { id: 'triggers', label: 'Disparadores' },
        { id: 'settings', label: 'Configuración' },
        { id: 'logs', label: 'Logs' },
        { id: 'versions', label: 'Versiones' },
      ] as { id: Tab; label: string }[],
    [],
  );
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  const w = q.data!;
  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            {w.name} <WorkerStatus w={w} />
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-x-3">
            <span className="font-mono">v{w.version}</span>
            {w.url && (
              <a href={w.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono hover:text-accent">
                {w.url.replace('https://', '')} <ExternalLink className="size-3" />
              </a>
            )}
            {w.routes.map((r) => (
              <span key={r} className="font-mono">
                {r}
              </span>
            ))}
          </span>
        }
      />
      {w.status === 'error' && w.last_error && (
        <div className="mb-4 rounded-md border border-danger/30 bg-danger-soft px-3 py-2">
          <div className="text-[13px] font-medium text-danger">El Worker no arranca</div>
          <pre className="mt-1 overflow-x-auto font-mono text-[12px] whitespace-pre-wrap text-danger">{w.last_error}</pre>
        </div>
      )}
      <Tabs value={tab} onChange={(t) => setParams({ tab: t })} tabs={tabs} />
      {tab === 'code' && <EditorTab key={w.id} w={w} />}
      {tab === 'metrics' && <MetricsTab w={w} />}
      {tab === 'triggers' && <TriggersTab w={w} />}
      {tab === 'settings' && <SettingsTab key={`${w.id}-${w.version}`} w={w} />}
      {tab === 'logs' && <LogStream workerId={w.id} className="h-[calc(100vh-260px)] min-h-[420px]" />}
      {tab === 'versions' && <VersionsTab w={w} />}
    </>
  );
}
