import { useEffect, useState, type ChangeEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, Send, Trash2 } from 'lucide-react';
import { api, type Queue, type Worker } from '../lib/api';
import { compact, timeAgo } from '../lib/format';
import { BarChart } from '../components/BarChart';
import { CodeBlock, TokensPanel } from '../components/TokensPanel';
import { Badge, Button, Card, ConfirmButton, Copyable, Empty, ErrorBox, Field, Input, PageHeader, Select, Spinner, StickyActions, Table, Tabs, Td, Textarea, Toggle } from '../components/ui';

interface Message {
  id: number;
  body: unknown;
  content_type: string;
  attempts: number;
  created_at: number;
  visible_at: number;
  state: 'ready' | 'inflight' | 'delayed';
}

function Overview({ q }: { q: Queue }) {
  const tiles: [string, number, string?][] = [
    ['Pendientes', q.backlog.total],
    ['Listos', q.backlog.ready],
    ['En proceso', q.backlog.inflight],
    ['Retrasados', q.backlog.delayed],
    ['Procesados 24 h', q.totals_24h.acked],
    ['Fallidos 24 h', q.totals_24h.dead, q.totals_24h.dead ? 'text-danger' : ''],
  ];
  return (
    <div className="mb-5 space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {tiles.map(([label, value, cls]) => (
          <div key={label} className="rounded-lg border border-border bg-surface p-3">
            <div className="text-xs text-muted">{label}</div>
            <div className={`tabular mt-1 text-xl font-semibold ${cls ?? ''}`}>{compact(value)}</div>
          </div>
        ))}
      </div>
      {q.stats && (
        <Card title="Mensajes enviados · 24 h">
          <BarChart series={q.stats.map((s) => ({ hour: s.hour, value: s.sent, bad: s.dead }))} label="enviados" badLabel="fallidos definitivamente" height={90} />
        </Card>
      )}
    </div>
  );
}

function Messages({ q }: { q: Queue }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['queue-messages', q.id], queryFn: () => api.get<Message[]>(`/api/queues/${q.id}/messages`), refetchInterval: 3000 });
  const [body, setBody] = useState('{\n  "ejemplo": true\n}');
  const [delay, setDelay] = useState(0);
  const send = useMutation({
    mutationFn: () => {
      let parsed: unknown = body;
      let type: 'json' | 'text' = 'text';
      try {
        parsed = JSON.parse(body);
        type = 'json';
      } catch {
        /* plain text message */
      }
      return api.post(`/api/queues/${q.id}/messages`, { body: parsed, content_type: type, delay_seconds: delay || undefined });
    },
    onSuccess: () => {
      toast.success('Mensaje enviado');
      qc.invalidateQueries({ queryKey: ['queue-messages', q.id] });
      qc.invalidateQueries({ queryKey: ['queue', q.id] });
    },
    onError: (e) => toast.error(e.message),
  });
  const stateBadge = { ready: <Badge tone="ok">Listo</Badge>, inflight: <Badge tone="info">En proceso</Badge>, delayed: <Badge>Retrasado</Badge> };
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
      <Card
        padded={false}
        title="Mensajes pendientes"
        actions={
          <ConfirmButton
            size="sm"
            variant="danger"
            title="Vaciar la cola"
            message="Se borrarán todos los mensajes pendientes. No se puede deshacer."
            label="Vaciar"
            onConfirm={async () => {
              const r = await api.del<{ deleted: number }>(`/api/queues/${q.id}/messages`);
              toast.success(`${r.deleted} mensajes borrados`);
              qc.invalidateQueries({ queryKey: ['queue-messages', q.id] });
            }}
          >
            Vaciar cola
          </ConfirmButton>
        }
      >
        {!list.data?.length ? (
          <Empty title="La cola está vacía" description={q.consumer ? `${q.consumer.name} procesa los mensajes en cuanto llegan.` : 'Los mensajes se acumulan hasta que asignes un consumidor.'} />
        ) : (
          <Table head={['ID', 'Contenido', 'Estado', 'Intentos', 'Recibido']}>
            {list.data.map((m) => (
              <tr key={m.id}>
                <Td className="font-mono text-xs text-muted">{m.id}</Td>
                <Td className="max-w-md">
                  <code className="block truncate font-mono text-[12px]">{typeof m.body === 'string' ? m.body : JSON.stringify(m.body)}</code>
                </Td>
                <Td>{stateBadge[m.state]}</Td>
                <Td className="tabular">{m.attempts}</Td>
                <Td className="text-xs whitespace-nowrap text-muted">{timeAgo(Math.floor(m.created_at / 1000))}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Card title="Enviar un mensaje">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            send.mutate();
          }}
        >
          <Field label="Contenido" hint="JSON o texto.">
            <Textarea className="min-h-32" value={body} onChange={(e) => setBody(e.target.value)} />
          </Field>
          <Field label="Retraso (segundos)">
            <Input type="number" min={0} value={delay} onChange={(e) => setDelay(Number(e.target.value))} />
          </Field>
          <Button type="submit" variant="primary" className="w-full" icon={<Send className="size-4" />} loading={send.isPending}>
            Enviar
          </Button>
        </form>
      </Card>
    </div>
  );
}

function ConsumerSettings({ q }: { q: Queue }) {
  const qc = useQueryClient();
  const workers = useQuery({ queryKey: ['workers'], queryFn: () => api.get<Worker[]>('/api/workers') });
  const queues = useQuery({ queryKey: ['queues'], queryFn: () => api.get<Queue[]>('/api/queues') });
  const pick = (x: Queue) => ({
    consumer_worker_id: x.consumer_worker_id,
    max_batch_size: x.max_batch_size,
    max_batch_timeout: x.max_batch_timeout,
    max_retries: x.max_retries,
    retry_delay: x.retry_delay,
    dead_letter_queue_id: x.dead_letter_queue_id,
    delivery_paused: x.delivery_paused,
  });
  const [s, setS] = useState(pick(q));
  useEffect(() => setS(pick(q)), [q]);
  const save = useMutation({
    mutationFn: () => api.put<Queue>(`/api/queues/${q.id}`, s),
    onSuccess: () => {
      toast.success('Consumidor actualizado');
      qc.invalidateQueries({ queryKey: ['queue', q.id] });
      qc.invalidateQueries({ queryKey: ['queues'] });
      qc.invalidateQueries({ queryKey: ['workers'] });
    },
    onError: (e) => toast.error(e.message),
  });
  const num = (k: keyof typeof s) => (e: ChangeEvent<HTMLInputElement>) => setS({ ...s, [k]: Number(e.target.value) });
  const dirty = JSON.stringify(s) !== JSON.stringify(pick(q));
  return (
    <div className="space-y-4">
      <Card title="Consumidor">
        <div className="space-y-4">
          <Field label="Worker que procesa los mensajes" hint="Su manejador queue(batch, env, ctx) recibe los mensajes por lotes.">
            <Select value={s.consumer_worker_id ?? ''} onChange={(e) => setS({ ...s, consumer_worker_id: e.target.value ? Number(e.target.value) : null })}>
              <option value="">Ninguno (los mensajes se acumulan o se leen por HTTP)</option>
              {workers.data?.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Tamaño del lote" hint="Mensajes por entrega (1-100).">
              <Input type="number" min={1} max={100} value={s.max_batch_size} onChange={num('max_batch_size')} />
            </Field>
            <Field label="Espera máxima del lote (s)" hint="Entrega aunque el lote no esté lleno.">
              <Input type="number" min={0} max={60} value={s.max_batch_timeout} onChange={num('max_batch_timeout')} />
            </Field>
            <Field label="Reintentos" hint="Entregas fallidas antes de descartar el mensaje.">
              <Input type="number" min={0} max={100} value={s.max_retries} onChange={num('max_retries')} />
            </Field>
            <Field label="Espera entre reintentos (s)">
              <Input type="number" min={0} value={s.retry_delay} onChange={num('retry_delay')} />
            </Field>
          </div>
          <Field label="Cola de mensajes fallidos" hint="Recibe los mensajes que agotan los reintentos, para revisarlos después.">
            <Select value={s.dead_letter_queue_id ?? ''} onChange={(e) => setS({ ...s, dead_letter_queue_id: e.target.value ? Number(e.target.value) : null })}>
              <option value="">Ninguna (se descartan)</option>
              {queues.data
                ?.filter((x) => x.id !== q.id)
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
            </Select>
          </Field>
          <div className="border-t border-border">
            <Toggle checked={s.delivery_paused} onChange={(v) => setS({ ...s, delivery_paused: v })} label="Pausar entregas" description="Los mensajes se siguen aceptando pero no se entregan al consumidor." />
          </div>
        </div>
      </Card>
      <StickyActions>
        <Button variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
          Guardar
        </Button>
      </StickyActions>
    </div>
  );
}

function ApiTab({ q }: { q: Queue }) {
  return (
    <TokensPanel basePath={`/api/queues/${q.id}`}>
      <Card title="Enviar desde un Worker">
        <p className="mb-3 text-[13px] text-muted">
          Añade al Worker un binding de tipo <em>Cola</em> con esta cola (Configuración → Bindings).
        </p>
        <CodeBlock>{`await env.QUEUE.send({ pedido: 42 });
await env.QUEUE.sendBatch([{ body: 'a' }, { body: 'b', delaySeconds: 60 }]);`}</CodeBlock>
      </Card>
      <Card title="API HTTP">
        <Field label="Endpoint">
          <Copyable value={q.api_url} />
        </Field>
        <div className="mt-4 space-y-3">
          <CodeBlock>{`# Enviar mensajes
curl -X POST ${q.api_url} -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" -d '{"body": {"pedido": 42}, "delay_seconds": 0}'`}</CodeBlock>
          <CodeBlock>{`# Consumidor por HTTP (pull): pedir un lote y confirmarlo
curl -X POST ${q.api_url}/pull -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" -d '{"batch_size": 10, "visibility_timeout_ms": 30000}'

curl -X POST ${q.api_url}/ack -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" -d '{"acks": [{"lease_id": "…"}], "retries": []}'`}</CodeBlock>
        </div>
      </Card>
    </TokensPanel>
  );
}

export default function QueueDetail() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') ?? 'messages') as 'messages' | 'consumer' | 'api';
  const q = useQuery({ queryKey: ['queue', id], queryFn: () => api.get<Queue>(`/api/queues/${id}`), refetchInterval: 4000 });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  const queue = q.data!;
  return (
    <>
      <Link to="/queues" className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted hover:text-fg">
        <ArrowLeft className="size-3.5" /> Colas
      </Link>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <span className="font-mono">{queue.name}</span>
            {queue.delivery_paused && <Badge tone="warn">Pausada</Badge>}
          </span>
        }
        description={
          <span className="flex flex-wrap gap-x-3">
            <span>
              Productores: {queue.producers.length ? queue.producers.map((p) => <Link key={p.id} to={`/workers/${p.id}`} className="font-mono hover:text-accent">{p.name} </Link>) : 'HTTP / panel'}
            </span>
            <span>
              Consumidor:{' '}
              {queue.consumer ? (
                <Link to={`/workers/${queue.consumer.id}`} className="font-mono hover:text-accent">
                  {queue.consumer.name}
                </Link>
              ) : (
                'ninguno'
              )}
            </span>
            {queue.dead_letter_queue && <span>Fallidos → {queue.dead_letter_queue.name}</span>}
          </span>
        }
        actions={
          <ConfirmButton
            variant="danger"
            icon={<Trash2 className="size-4" />}
            title={`Eliminar ${queue.name}`}
            message="Se borrarán la cola y sus mensajes pendientes."
            onConfirm={async () => {
              await api.del(`/api/queues/${id}`);
              qc.invalidateQueries({ queryKey: ['queues'] });
              navigate('/queues');
            }}
          >
            Eliminar
          </ConfirmButton>
        }
      />
      <Overview q={queue} />
      <Tabs
        value={tab}
        onChange={(t) => setParams({ tab: t })}
        tabs={[
          { id: 'messages', label: 'Mensajes' },
          { id: 'consumer', label: 'Consumidor y reintentos' },
          { id: 'api', label: 'Productores y API' },
        ]}
      />
      {tab === 'messages' && <Messages q={queue} />}
      {tab === 'consumer' && <ConsumerSettings q={queue} />}
      {tab === 'api' && <ApiTab q={queue} />}
    </>
  );
}
