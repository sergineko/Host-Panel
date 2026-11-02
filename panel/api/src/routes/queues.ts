import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.ts';
import { all, audit, get, run, type QueueRow, type WorkerRow } from '../db.ts';
import { badRequest, idParam, notFound, parse } from '../lib/validate.ts';
import { ackMessages, peekMessages, pullMessages, purgeQueue, QUEUE_NAME_RE, queueBacklog, queueStats, sendMessages } from '../services/queues.ts';
import { createToken, deleteScopeTokens, deleteToken, listTokens, requireToken } from '../services/tokens.ts';
import { workerBindings, type Binding } from '../services/workers.ts';

function getQueue(id: number) {
  const q = get<QueueRow>('SELECT * FROM queues WHERE id = ?', id);
  if (!q) throw notFound('Cola');
  return q;
}

/** Workers that produce into (are bound to) a resource. */
export function boundBy(type: Binding['type'], id: number) {
  return all<WorkerRow>('SELECT id, name, bindings FROM workers')
    .filter((w) => workerBindings(w).some((b) => b.type === type && b.id === id))
    .map((w) => ({ id: w.id, name: w.name }));
}

const panelBase = () => (config.panelDomain ? `https://${config.panelDomain}` : `https://${config.serverIp}:${config.panelPort}`);

function present(q: QueueRow) {
  const consumer = q.consumer_worker_id ? get<{ id: number; name: string; status: string }>('SELECT id, name, status FROM workers WHERE id = ?', q.consumer_worker_id) : null;
  const dlq = q.dead_letter_queue_id ? get<{ id: number; name: string }>('SELECT id, name FROM queues WHERE id = ?', q.dead_letter_queue_id) : null;
  const totals = queueStats(q.id, 24).reduce(
    (a, s) => ({ sent: a.sent + s.sent, acked: a.acked + s.acked, retried: a.retried + s.retried, dead: a.dead + s.dead }),
    { sent: 0, acked: 0, retried: 0, dead: 0 },
  );
  return {
    ...q,
    delivery_paused: !!q.delivery_paused,
    consumer,
    dead_letter_queue: dlq,
    producers: boundBy('queue', q.id),
    backlog: queueBacklog(q.id),
    totals_24h: totals,
    api_url: `${panelBase()}/api/queues/v1/${q.name}/messages`,
  };
}

const settingsInput = z.object({
  consumer_worker_id: z.number().int().positive().nullable(),
  max_batch_size: z.number().int().min(1).max(100),
  max_batch_timeout: z.number().int().min(0).max(60),
  max_retries: z.number().int().min(0).max(100),
  retry_delay: z.number().int().min(0).max(43200),
  dead_letter_queue_id: z.number().int().positive().nullable(),
  delivery_paused: z.boolean(),
});

const messageInput = z.object({ body: z.unknown(), content_type: z.enum(['json', 'text']).optional(), delay_seconds: z.number().int().min(0).max(43200).optional() });

export default async function queueRoutes(app: FastifyInstance) {
  app.get('/api/queues', async () => all<QueueRow>('SELECT * FROM queues ORDER BY name').map(present));

  app.post('/api/queues', async (req) => {
    const { name } = parse(z.object({ name: z.string().trim().toLowerCase().regex(QUEUE_NAME_RE, 'Nombre: minúsculas, números y guiones') }), req.body);
    if (get('SELECT 1 FROM queues WHERE name = ?', name)) throw badRequest('Ya existe una cola con ese nombre');
    const { id } = run('INSERT INTO queues (name) VALUES (?)', name);
    audit(req.user!.username, 'queue.create', name, req.ip);
    return present(getQueue(id));
  });

  app.get('/api/queues/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    return { ...present(getQueue(id)), stats: queueStats(id, 24) };
  });

  app.put('/api/queues/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const q = getQueue(id);
    const body = parse(settingsInput, req.body);
    if (body.consumer_worker_id && !get('SELECT 1 FROM workers WHERE id = ?', body.consumer_worker_id)) throw badRequest('Ese Worker no existe');
    if (body.dead_letter_queue_id === id) throw badRequest('La cola de mensajes fallidos debe ser otra');
    if (body.dead_letter_queue_id && !get('SELECT 1 FROM queues WHERE id = ?', body.dead_letter_queue_id)) throw badRequest('Esa cola no existe');
    run(
      `UPDATE queues SET consumer_worker_id = ?, max_batch_size = ?, max_batch_timeout = ?, max_retries = ?, retry_delay = ?,
         dead_letter_queue_id = ?, delivery_paused = ? WHERE id = ?`,
      body.consumer_worker_id,
      body.max_batch_size,
      body.max_batch_timeout,
      body.max_retries,
      body.retry_delay,
      body.dead_letter_queue_id,
      Number(body.delivery_paused),
      id,
    );
    audit(req.user!.username, 'queue.update', q.name, req.ip);
    return present(getQueue(id));
  });

  app.delete('/api/queues/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const q = getQueue(id);
    const producers = boundBy('queue', id);
    if (producers.length) throw badRequest(`Antes quita el binding de: ${producers.map((p) => p.name).join(', ')}`);
    run('DELETE FROM queues WHERE id = ?', id);
    deleteScopeTokens('queue', id);
    audit(req.user!.username, 'queue.delete', q.name, req.ip);
    return { ok: true };
  });

  app.get('/api/queues/:id/messages', async (req) => {
    const { id } = parse(idParam, req.params);
    getQueue(id);
    return peekMessages(id, 100);
  });

  app.post('/api/queues/:id/messages', async (req) => {
    const { id } = parse(idParam, req.params);
    getQueue(id);
    const m = parse(messageInput, req.body);
    sendMessages(id, [{ body: m.body, contentType: m.content_type, delaySeconds: m.delay_seconds }]);
    return { ok: true };
  });

  app.delete('/api/queues/:id/messages', async (req) => {
    const { id } = parse(idParam, req.params);
    const q = getQueue(id);
    const n = purgeQueue(id);
    audit(req.user!.username, 'queue.purge', `${q.name} (${n})`, req.ip);
    return { deleted: n };
  });

  // --- tokens -----------------------------------------------------------------------------
  app.get('/api/queues/:id/tokens', async (req) => {
    const { id } = parse(idParam, req.params);
    getQueue(id);
    return listTokens('queue', id);
  });
  app.post('/api/queues/:id/tokens', async (req) => {
    const { id } = parse(idParam, req.params);
    const q = getQueue(id);
    const body = parse(z.object({ name: z.string().trim().min(1).max(80), can_write: z.boolean().default(true) }), req.body);
    audit(req.user!.username, 'queue.token', `${q.name}: ${body.name}`, req.ip);
    return { token: createToken(body.name, 'queue', id, body.can_write) };
  });
  app.delete('/api/queues/:id/tokens/:tokenId', async (req) => {
    const { id, tokenId } = parse(idParam.extend({ tokenId: z.coerce.number().int() }), req.params);
    deleteToken(tokenId, 'queue', id);
    return { ok: true };
  });

  // --- public HTTP API (producers and pull consumers) ---------------------------------
  const byName = (name: string) => {
    const q = get<QueueRow>('SELECT * FROM queues WHERE name = ?', name);
    if (!q) throw notFound('Cola');
    return q;
  };

  // POST /api/queues/v1/<cola>/messages  { "body": … }  or  { "messages": [{ "body": … }] }
  app.post('/api/queues/v1/:name/messages', async (req) => {
    const q = byName((req.params as { name: string }).name);
    requireToken(req, 'queue', q.id, true);
    const body = parse(z.union([z.object({ messages: z.array(messageInput).min(1).max(100) }), messageInput]), req.body);
    const list = 'messages' in body ? body.messages : [body];
    const sent = sendMessages(q.id, list.map((m) => ({ body: m.body, contentType: m.content_type, delaySeconds: m.delay_seconds })));
    return { success: true, sent };
  });

  // Pull consumers: lease a batch, then ack/retry it.
  app.post('/api/queues/v1/:name/messages/pull', async (req) => {
    const q = byName((req.params as { name: string }).name);
    requireToken(req, 'queue', q.id, true);
    const o = parse(z.object({ batch_size: z.number().int().default(10), visibility_timeout_ms: z.number().int().default(30_000) }), req.body ?? {});
    return { success: true, messages: pullMessages(q.id, o.batch_size, o.visibility_timeout_ms) };
  });

  app.post('/api/queues/v1/:name/messages/ack', async (req) => {
    const q = byName((req.params as { name: string }).name);
    requireToken(req, 'queue', q.id, true);
    const o = parse(
      z.object({
        acks: z.array(z.object({ lease_id: z.string() })).default([]),
        retries: z.array(z.object({ lease_id: z.string(), delay_seconds: z.number().int().min(0).optional() })).default([]),
      }),
      req.body,
    );
    return { success: true, ...ackMessages(q, o.acks.map((a) => a.lease_id), o.retries) };
  });
}
