/**
 * Queues (like Cloudflare Queues). Messages are stored in the panel database and pushed
 * in batches to the consumer Worker's queue() handler:
 *
 *   - a batch is sent when it reaches max_batch_size or the oldest message waited
 *     max_batch_timeout seconds
 *   - ack → deleted · retry (or an error in queue()) → delivered again later
 *   - after max_retries failed deliveries → dead-letter queue (if configured) or dropped
 *
 * Producers: Workers (env.QUEUE.send), the HTTP API with a token, or the panel.
 * Pull consumers can also fetch and ack messages over HTTP.
 */
import { randomUUID } from 'node:crypto';
import { all, get, run, type QueueMessageRow, type QueueRow, type WorkerRow } from '../db.ts';
import { HttpError } from '../lib/validate.ts';
import { pushEvents, triggerWorker } from './workers.ts';
import { cronMatches, parseCron } from './cron.ts';
import { workerCrons } from './workers.ts';

export const QUEUE_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const MAX_MESSAGE_BYTES = 128 * 1024;
const VISIBILITY_MS = 60_000;

export interface OutgoingMessage {
  body: unknown;
  contentType?: string;
  delaySeconds?: number;
}

const hourNow = () => Math.floor(Date.now() / 3600_000);

function stat(queueId: number, field: 'sent' | 'delivered' | 'acked' | 'retried' | 'dead', n: number) {
  if (!n) return;
  run(
    `INSERT INTO queue_stats (queue_id, hour, ${field}) VALUES (?, ?, ?)
     ON CONFLICT(queue_id, hour) DO UPDATE SET ${field} = ${field} + excluded.${field}`,
    queueId,
    hourNow(),
    n,
  );
}

export function sendMessages(queueId: number, messages: OutgoingMessage[]) {
  if (!messages.length) return 0;
  if (messages.length > 100) throw new HttpError(400, 'Máximo 100 mensajes por envío');
  const now = Date.now();
  const rows = messages.map((m) => {
    const type = m.contentType ?? 'json';
    if (!['json', 'text', 'bytes', 'v8'].includes(type)) throw new HttpError(400, `contentType no soportado: ${type}`);
    const body = type === 'text' ? String(m.body) : JSON.stringify(m.body ?? null);
    if (Buffer.byteLength(body) > MAX_MESSAGE_BYTES) throw new HttpError(413, 'Un mensaje supera 128 KB');
    const delay = Math.min(Math.max(Number(m.delaySeconds ?? 0), 0), 43200);
    return { body, type: type === 'text' ? 'text' : 'json', visible: now + delay * 1000 };
  });
  for (const r of rows) {
    run('INSERT INTO queue_messages (queue_id, body, content_type, visible_at, created_at) VALUES (?, ?, ?, ?, ?)', queueId, r.body, r.type, r.visible, now);
  }
  stat(queueId, 'sent', rows.length);
  return rows.length;
}

const decode = (m: QueueMessageRow) => (m.content_type === 'text' ? m.body : (JSON.parse(m.body) as unknown));

export function queueBacklog(queueId: number) {
  return get<{ total: number; ready: number; delayed: number; inflight: number; oldest: number | null }>(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN visible_at <= ?1 THEN 1 ELSE 0 END), 0) AS ready,
            COALESCE(SUM(CASE WHEN visible_at > ?1 AND lease_id IS NULL THEN 1 ELSE 0 END), 0) AS delayed,
            COALESCE(SUM(CASE WHEN visible_at > ?1 AND lease_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS inflight,
            MIN(created_at) AS oldest
     FROM queue_messages WHERE queue_id = ?2`,
    Date.now(),
    queueId,
  )!;
}

export function queueStats(queueId: number, hours = 24) {
  const now = hourNow();
  const rows = all<{ hour: number; sent: number; delivered: number; acked: number; retried: number; dead: number }>(
    'SELECT * FROM queue_stats WHERE queue_id = ? AND hour > ? ORDER BY hour',
    queueId,
    now - hours,
  );
  const byHour = new Map(rows.map((r) => [r.hour, r]));
  return Array.from({ length: hours }, (_, i) => {
    const hour = now - hours + 1 + i;
    const r = byHour.get(hour);
    return { hour: hour * 3600, sent: r?.sent ?? 0, delivered: r?.delivered ?? 0, acked: r?.acked ?? 0, retried: r?.retried ?? 0, dead: r?.dead ?? 0 };
  });
}

export function peekMessages(queueId: number, limit = 50) {
  return all<QueueMessageRow>('SELECT * FROM queue_messages WHERE queue_id = ? ORDER BY id LIMIT ?', queueId, limit).map((m) => ({
    id: m.id,
    body: decode(m),
    content_type: m.content_type,
    attempts: m.attempts,
    created_at: m.created_at,
    visible_at: m.visible_at,
    state: m.visible_at <= Date.now() ? 'ready' : m.lease_id ? 'inflight' : 'delayed',
  }));
}

export function purgeQueue(queueId: number) {
  return run('DELETE FROM queue_messages WHERE queue_id = ?', queueId).changes;
}

/** Applies a delivery outcome: ack, retry with backoff, or dead-letter. */
function settle(q: QueueRow, msg: QueueMessageRow, action: 'ack' | 'retry', delaySeconds?: number) {
  if (action === 'ack') {
    run('DELETE FROM queue_messages WHERE id = ?', msg.id);
    stat(q.id, 'acked', 1);
    return;
  }
  stat(q.id, 'retried', 1);
  if (msg.attempts > q.max_retries) {
    run('DELETE FROM queue_messages WHERE id = ?', msg.id);
    stat(q.id, 'dead', 1);
    if (q.dead_letter_queue_id) {
      run(
        'INSERT INTO queue_messages (queue_id, body, content_type, visible_at, created_at) VALUES (?, ?, ?, ?, ?)',
        q.dead_letter_queue_id,
        msg.body,
        msg.content_type,
        Date.now(),
        Date.now(),
      );
      stat(q.dead_letter_queue_id, 'sent', 1);
    }
    return;
  }
  const delay = (delaySeconds ?? q.retry_delay) * 1000;
  run('UPDATE queue_messages SET visible_at = ?, lease_id = NULL WHERE id = ?', Date.now() + delay, msg.id);
}

/** Takes up to `limit` ready messages and leases them (invisible while being processed). */
function lease(queueId: number, limit: number, visibilityMs = VISIBILITY_MS) {
  const now = Date.now();
  const rows = all<QueueMessageRow>('SELECT * FROM queue_messages WHERE queue_id = ? AND visible_at <= ? ORDER BY id LIMIT ?', queueId, now, limit);
  const leaseId = randomUUID();
  for (const r of rows) {
    run('UPDATE queue_messages SET visible_at = ?, attempts = attempts + 1, lease_id = ? WHERE id = ?', now + visibilityMs, leaseId, r.id);
    r.attempts += 1;
    r.lease_id = leaseId;
  }
  return rows;
}

async function deliver(q: QueueRow, worker: WorkerRow) {
  const ready = get<{ n: number; oldest: number | null }>(
    'SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM queue_messages WHERE queue_id = ? AND visible_at <= ?',
    q.id,
    Date.now(),
  )!;
  if (!ready.n) return;
  const waited = ready.oldest ? (Date.now() - ready.oldest) / 1000 : 0;
  if (ready.n < q.max_batch_size && waited < q.max_batch_timeout) return;
  const batch = lease(q.id, q.max_batch_size);
  if (!batch.length) return;
  stat(q.id, 'delivered', batch.length);
  try {
    const res = await triggerWorker(worker, '/__hp/queue', {
      queue: q.name,
      messages: batch.map((m) => ({ id: m.id, body: decode(m), timestamp: m.created_at, attempts: m.attempts })),
    });
    if (!res.ok) throw new Error(`El Worker respondió ${res.status}`);
    const { results } = (await res.json()) as { results: { id: number; action: 'ack' | 'retry'; delaySeconds?: number }[] };
    const byId = new Map(results.map((r) => [Number(r.id), r]));
    for (const m of batch) {
      const r = byId.get(m.id);
      settle(q, m, r?.action ?? 'retry', r?.delaySeconds);
    }
  } catch (err) {
    pushEvents(worker.id, [{ type: 'system', ts: Date.now(), logs: [{ level: 'error', message: `Cola ${q.name}: no se pudo entregar el lote (${(err as Error).message})` }] }]);
    for (const m of batch) settle(q, m, 'retry', Math.max(q.retry_delay, 5));
  }
}

// --- pull consumers (HTTP) ------------------------------------------------------------

export function pullMessages(queueId: number, batchSize: number, visibilityMs: number) {
  const rows = lease(queueId, Math.min(Math.max(batchSize, 1), 100), Math.min(Math.max(visibilityMs, 1000), 12 * 3600_000));
  stat(queueId, 'delivered', rows.length);
  return rows.map((m) => ({ id: String(m.id), lease_id: `${m.id}:${m.lease_id}`, body: decode(m), attempts: m.attempts, timestamp_ms: m.created_at }));
}

export function ackMessages(q: QueueRow, acks: string[], retries: { lease_id: string; delay_seconds?: number }[]) {
  const find = (leaseId: string) => {
    const [id, lid] = leaseId.split(':');
    return get<QueueMessageRow>('SELECT * FROM queue_messages WHERE id = ? AND queue_id = ? AND lease_id = ?', Number(id), q.id, lid ?? '');
  };
  let acked = 0;
  let retried = 0;
  for (const l of acks) {
    const m = find(l);
    if (m) {
      settle(q, m, 'ack');
      acked++;
    }
  }
  for (const r of retries) {
    const m = find(r.lease_id);
    if (m) {
      settle(q, m, 'retry', r.delay_seconds);
      retried++;
    }
  }
  return { acked, retried };
}

// --- background loops: queue delivery + cron triggers --------------------------------

let delivering = false;
export function startQueueDispatcher() {
  return setInterval(async () => {
    if (delivering) return;
    delivering = true;
    try {
      const queues = all<QueueRow & { w_id: number | null }>(
        `SELECT q.*, w.id AS w_id FROM queues q JOIN workers w ON w.id = q.consumer_worker_id
         WHERE q.delivery_paused = 0 AND w.enabled = 1 AND w.status = 'running'`,
      );
      await Promise.all(
        queues.map(async (q) => {
          const worker = get<WorkerRow>('SELECT * FROM workers WHERE id = ?', q.w_id!);
          if (worker) await deliver(q, worker);
        }),
      );
    } catch (err) {
      console.error('Colas:', (err as Error).message);
    } finally {
      delivering = false;
    }
  }, 1000);
}

/** Runs scheduled() of every Worker whose cron matches the current minute (UTC). */
export function startCronScheduler() {
  let lastMinute = -1;
  const tick = async () => {
    const now = new Date();
    const minute = Math.floor(now.getTime() / 60_000);
    if (minute === lastMinute) return;
    lastMinute = minute;
    const workers = all<WorkerRow>("SELECT * FROM workers WHERE enabled = 1 AND status = 'running' AND crons != '[]'");
    for (const w of workers) {
      for (const expr of workerCrons(w)) {
        try {
          if (!cronMatches(parseCron(expr), now)) continue;
        } catch {
          continue;
        }
        const scheduledTime = minute * 60_000;
        triggerWorker(w, '/__hp/scheduled', { cron: expr, scheduledTime }, 15 * 60_000).catch((err: Error) =>
          pushEvents(w.id, [{ type: 'system', ts: Date.now(), logs: [{ level: 'error', message: `Cron "${expr}": ${err.message}` }] }]),
        );
      }
    }
  };
  return setInterval(() => void tick(), 5000);
}
