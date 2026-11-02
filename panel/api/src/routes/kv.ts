import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, audit, get, run } from '../db.ts';
import { badRequest, idParam, notFound, parse } from '../lib/validate.ts';
import { kvDelete, kvGet, kvList, kvPut, kvStats } from '../services/kv.ts';
import { boundBy } from './queues.ts';

interface NsRow {
  id: number;
  name: string;
  created_at: string;
}

function getNs(id: number) {
  const ns = get<NsRow>('SELECT * FROM kv_namespaces WHERE id = ?', id);
  if (!ns) throw notFound('Espacio KV');
  return ns;
}

const present = (ns: NsRow) => ({ ...ns, ...kvStats(ns.id), workers: boundBy('kv', ns.id) });

export default async function kvRoutes(app: FastifyInstance) {
  app.get('/api/kv', async () => all<NsRow>('SELECT * FROM kv_namespaces ORDER BY name').map(present));

  app.post('/api/kv', async (req) => {
    const { name } = parse(z.object({ name: z.string().trim().min(1).max(64).regex(/^[\w-]+$/, 'Letras, números, _ y -') }), req.body);
    if (get('SELECT 1 FROM kv_namespaces WHERE name = ?', name)) throw badRequest('Ya existe un espacio KV con ese nombre');
    const { id } = run('INSERT INTO kv_namespaces (name) VALUES (?)', name);
    audit(req.user!.username, 'kv.create', name, req.ip);
    return present(getNs(id));
  });

  app.get('/api/kv/:id', async (req) => present(getNs(parse(idParam, req.params).id)));

  app.delete('/api/kv/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const ns = getNs(id);
    const workers = boundBy('kv', id);
    if (workers.length) throw badRequest(`Antes quita el binding de: ${workers.map((w) => w.name).join(', ')}`);
    run('DELETE FROM kv_namespaces WHERE id = ?', id);
    audit(req.user!.username, 'kv.delete', ns.name, req.ip);
    return { ok: true };
  });

  app.get('/api/kv/:id/keys', async (req) => {
    const { id } = parse(idParam, req.params);
    getNs(id);
    const q = parse(z.object({ prefix: z.string().max(512).optional(), cursor: z.string().optional(), limit: z.coerce.number().int().default(100) }), req.query);
    return kvList(id, q);
  });

  app.get('/api/kv/:id/value', async (req) => {
    const { id } = parse(idParam, req.params);
    const { key } = parse(z.object({ key: z.string().min(1).max(512) }), req.query);
    const entry = kvGet(id, key);
    if (!entry) throw notFound('Clave');
    const text = entry.value.toString('utf8');
    const binary = Buffer.compare(Buffer.from(text, 'utf8'), entry.value) !== 0;
    return {
      key,
      value: binary ? entry.value.toString('base64') : text.slice(0, 1_000_000),
      encoding: binary ? 'base64' : 'utf8',
      size: entry.value.length,
      metadata: entry.metadata,
      expiration: entry.expiration,
    };
  });

  app.put('/api/kv/:id/value', async (req) => {
    const { id } = parse(idParam, req.params);
    const ns = getNs(id);
    const body = parse(
      z.object({ key: z.string().min(1).max(512), value: z.string().max(25 * 1024 * 1024), ttl: z.number().int().min(60).optional(), metadata: z.unknown().optional() }),
      req.body,
    );
    kvPut(id, body.key, Buffer.from(body.value, 'utf8'), { ttl: body.ttl, metadata: body.metadata });
    audit(req.user!.username, 'kv.put', `${ns.name}: ${body.key}`, req.ip);
    return { ok: true };
  });

  app.delete('/api/kv/:id/value', async (req) => {
    const { id } = parse(idParam, req.params);
    const ns = getNs(id);
    const { key } = parse(z.object({ key: z.string().min(1).max(512) }), req.query);
    kvDelete(id, key);
    audit(req.user!.username, 'kv.delete_key', `${ns.name}: ${key}`, req.ip);
    return { ok: true };
  });
}
