/**
 * Internal API used by Worker processes for their bindings. It listens on its own port
 * (127.0.0.1:HP_INTERNAL_PORT) which Caddy never exposes. Every request carries the
 * Worker's token and may only touch resources bound to that Worker.
 */
import Fastify, { type FastifyRequest } from 'fastify';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import { config } from './config.ts';
import { get, type BucketRow, type DatabaseRow, type WorkerRow } from './db.ts';
import { HttpError, parse } from './lib/validate.ts';
import { runBatch } from './services/databases.ts';
import { KV_MAX_VALUE, kvDelete, kvGet, kvList, kvPut } from './services/kv.ts';
import { sendMessages } from './services/queues.ts';
import { deleteObject, getObject, listObjects, putObject } from './services/storage.ts';
import { getWorkerByToken, pushEvents, workerBindings, type Binding } from './services/workers.ts';

declare module 'fastify' {
  interface FastifyRequest {
    worker?: WorkerRow;
  }
}

/** The resource must be bound to the calling Worker with that type. */
function bound(req: FastifyRequest, type: Binding['type'], id: number) {
  const ok = workerBindings(req.worker!).some((b) => b.type === type && b.id === id);
  if (!ok) throw new HttpError(403, `Este Worker no tiene acceso a ese recurso (${type} ${id})`);
}

const idParam = z.object({ id: z.coerce.number().int().positive() });
const keyQuery = z.object({ key: z.string().min(1).max(1024) });

async function readBody(stream: Readable, max: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += (chunk as Buffer).length;
    if (size > max) throw new HttpError(413, 'Valor demasiado grande');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function startInternalServer() {
  const app = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024 });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    reply.code(err instanceof HttpError ? err.statusCode : (err.statusCode ?? 500)).send({ error: err.message });
  });

  app.addHook('onRequest', async (req) => {
    const header = String(req.headers.authorization ?? '');
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const worker = token ? getWorkerByToken(token) : undefined;
    if (!worker) throw new HttpError(401, 'Token de Worker no válido');
    req.worker = worker;
  });

  const bucketOf = (req: FastifyRequest) => {
    const { id } = parse(idParam, req.params);
    bound(req, 'r2', id);
    const b = get<BucketRow>('SELECT * FROM buckets WHERE id = ?', id);
    if (!b) throw new HttpError(404, 'Bucket no encontrado');
    return b;
  };

  // Raw bodies for KV / R2 writes (whatever their content type, even JSON files).
  await app.register(async (raw) => {
    raw.removeAllContentTypeParsers();
    raw.addContentTypeParser('*', (_req, payload, done) => done(null, payload));
    raw.put('/kv/:id/value', async (req) => {
      const { id } = parse(idParam, req.params);
      bound(req, 'kv', id);
      const { key } = parse(keyQuery, req.query);
      const value = await readBody((req.body as Readable | undefined) ?? req.raw, KV_MAX_VALUE);
      const h = req.headers;
      kvPut(id, key, value, {
        ttl: h['x-hp-ttl'] ? Number(h['x-hp-ttl']) : undefined,
        expiration: h['x-hp-expiration'] ? Number(h['x-hp-expiration']) : undefined,
        metadata: h['x-hp-metadata'] ? (JSON.parse(String(h['x-hp-metadata'])) as unknown) : undefined,
      });
      return { ok: true };
    });
    raw.put('/r2/:id/object', async (req) => {
      const b = bucketOf(req);
      const { key } = parse(keyQuery, req.query);
      return putObject(b.name, key, (req.body as Readable | undefined) ?? req.raw);
    });
  });

  // --- logs & metrics -----------------------------------------------------------------
  app.post('/events', async (req) => {
    const { events } = req.body as { events: Parameters<typeof pushEvents>[1] };
    if (Array.isArray(events)) pushEvents(req.worker!.id, events.slice(0, 1000));
    return { ok: true };
  });

  // --- D1 -------------------------------------------------------------------------------
  app.post('/d1/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    bound(req, 'd1', id);
    const body = parse(
      z.object({
        statements: z.array(z.object({ sql: z.string().min(1).max(1_000_000), params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).default([]) })).min(1).max(100),
        raw: z.boolean().default(false),
      }),
      req.body,
    );
    const db = get<DatabaseRow>('SELECT * FROM databases WHERE id = ?', id);
    if (!db) throw new HttpError(404, 'Base de datos no encontrada');
    const results = await runBatch(db, body.statements);
    return {
      results: results.map((r) => ({
        results: r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]]))),
        columns: r.columns,
        rows: body.raw ? r.rows : undefined,
        meta: { changes: r.affectedRows, last_row_id: r.insertId, rows_read: r.rowCount, duration: r.durationMs, changed_db: r.affectedRows > 0 },
      })),
    };
  });

  // --- KV -------------------------------------------------------------------------------
  app.get('/kv/:id/value', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    bound(req, 'kv', id);
    const { key } = parse(keyQuery, req.query);
    const entry = kvGet(id, key);
    if (!entry) return reply.code(404).send({ error: 'not found' });
    if (entry.metadata !== null) reply.header('x-hp-metadata', JSON.stringify(entry.metadata));
    return reply.header('content-type', 'application/octet-stream').send(entry.value);
  });
  app.delete('/kv/:id/value', async (req) => {
    const { id } = parse(idParam, req.params);
    bound(req, 'kv', id);
    kvDelete(id, parse(keyQuery, req.query).key);
    return { ok: true };
  });
  app.post('/kv/:id/list', async (req) => {
    const { id } = parse(idParam, req.params);
    bound(req, 'kv', id);
    const o = parse(z.object({ prefix: z.string().optional(), limit: z.number().optional(), cursor: z.string().optional() }), req.body ?? {});
    return kvList(id, o);
  });

  // --- R2 -------------------------------------------------------------------------------
  const sendR2 = async (req: FastifyRequest, reply: import('fastify').FastifyReply, head: boolean) => {
    const b = bucketOf(req);
    const { key } = parse(keyQuery, req.query);
    let obj;
    try {
      obj = await getObject(b.name, key);
    } catch {
      return reply.code(404).send({ error: 'not found' });
    }
    reply.header('content-type', obj.type).header('content-length', obj.size).header('last-modified', obj.modified.toUTCString()).header('etag', `"${obj.size.toString(16)}-${obj.modified.getTime().toString(16)}"`);
    if (head) {
      obj.stream.destroy();
      return reply.send();
    }
    return reply.send(obj.stream);
  };
  // Fastify answers HEAD from this GET route (headers only).
  app.get('/r2/:id/object', (req, reply) => sendR2(req, reply, req.method === 'HEAD'));
  app.post('/r2/:id/delete', async (req) => {
    const b = bucketOf(req);
    const { keys } = parse(z.object({ keys: z.array(z.string().min(1).max(1024)).max(1000) }), req.body);
    for (const k of keys) await deleteObject(b.name, k);
    return { ok: true };
  });
  app.post('/r2/:id/list', async (req) => {
    const b = bucketOf(req);
    const o = parse(z.object({ prefix: z.string().max(1024).default(''), limit: z.number().int().min(1).max(1000).default(1000) }).passthrough(), req.body ?? {});
    const r = await listObjects(b.name, o.prefix, o.limit);
    return {
      objects: r.objects.map((x) => ({ key: x.key, size: x.size, uploaded: x.modified, httpMetadata: { contentType: x.type } })),
      delimitedPrefixes: r.folders,
      truncated: r.truncated,
    };
  });

  // --- Queues ---------------------------------------------------------------------------
  app.post('/queues/:id/send', async (req) => {
    const { id } = parse(idParam, req.params);
    bound(req, 'queue', id);
    const { messages } = parse(
      z.object({ messages: z.array(z.object({ body: z.unknown(), contentType: z.string().optional(), delaySeconds: z.number().optional() })).min(1).max(100) }),
      req.body,
    );
    return { sent: sendMessages(id, messages) };
  });

  await app.listen({ host: '127.0.0.1', port: config.internalPort });
  return app;
}
