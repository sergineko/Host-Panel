import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import { config } from '../config.ts';
import { all, audit, get, run, type BucketRow } from '../db.ts';
import { badRequest, hostname, idParam, notFound, parse } from '../lib/validate.ts';
import { scheduleCaddySync } from '../services/caddy.ts';
import {
  BUCKET_RE,
  bucketUsage,
  createBucketDir,
  deleteObject,
  deletePrefix,
  getObject,
  listObjects,
  putObject,
  removeBucketDir,
} from '../services/storage.ts';
import { createToken, deleteScopeTokens, deleteToken, listTokens, requireToken } from '../services/tokens.ts';
import { boundBy } from './queues.ts';

const bucketInput = z.object({
  public: z.boolean().default(false),
  hostname: z.union([hostname, z.literal('')]).default(''),
  cors_origins: z
    .string()
    .trim()
    .max(1000)
    .refine((v) => v === '' || v === '*' || v.split(',').every((o) => /^https?:\/\/[\w.-]+(:\d+)?$/.test(o.trim())), 'Orígenes CORS no válidos (ej: https://misitio.com)')
    .default(''),
  cache_ttl: z.number().int().min(0).max(31536000).default(86400),
});

function getBucket(id: number) {
  const b = get<BucketRow>('SELECT * FROM buckets WHERE id = ?', id);
  if (!b) throw notFound('Bucket');
  return b;
}

function present(b: BucketRow) {
  const base = config.panelDomain ? `https://${config.panelDomain}` : `https://${config.serverIp}:${config.panelPort}`;
  return {
    ...b,
    public: !!b.public,
    public_url: b.public ? (b.hostname ? `https://${b.hostname}` : `${base}/api/storage/v1/${b.name}`) : null,
    api_url: `${base}/api/storage/v1/${b.name}`,
  };
}

function assertHostFree(host: string, exceptId?: number) {
  if (!host) return;
  const sites = all<{ name: string; hostnames: string }>('SELECT name, hostnames FROM sites');
  const site = sites.find((s) => (JSON.parse(s.hostnames) as string[]).includes(host));
  if (site) throw badRequest(`${host} ya lo usa el sitio "${site.name}"`);
  const other = get<{ name: string }>('SELECT name FROM buckets WHERE hostname = ? AND id != ?', host, exceptId ?? 0);
  if (other) throw badRequest(`${host} ya lo usa el bucket "${other.name}"`);
}

const keyQuery = z.object({ key: z.string().min(1).max(1024) });

async function sendObject(reply: FastifyReply, bucket: string, key: string, download = false) {
  const obj = await getObject(bucket, key);
  reply
    .header('Content-Type', obj.type)
    .header('Content-Length', obj.size)
    .header('Last-Modified', obj.modified.toUTCString())
    .header('X-Content-Type-Options', 'nosniff');
  if (download) reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(key.split('/').pop()!)}`);
  return reply.send(obj.stream);
}

/** Routes that receive raw bodies (uploads): no JSON parsing, streamed to disk. */
async function rawRoutes(app: FastifyInstance) {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', (_req, payload, done) => done(null, payload));

  // Panel upload.
  app.put('/api/buckets/:id/objects', async (req) => {
    const { id } = parse(idParam, req.params);
    const { key } = parse(keyQuery, req.query);
    const b = getBucket(id);
    const result = await putObject(b.name, key, (req.body as Readable | undefined) ?? req.raw);
    audit(req.user!.username, 'storage.put', `${b.name}/${key}`, req.ip);
    return result;
  });

  // Public API (token): PUT /api/storage/v1/<bucket>/<key>
  app.put('/api/storage/v1/:bucket/*', async (req) => {
    const { bucket } = req.params as { bucket: string; '*': string };
    const key = (req.params as { '*': string })['*'];
    const b = get<BucketRow>('SELECT * FROM buckets WHERE name = ?', bucket);
    if (!b) throw notFound('Bucket');
    requireToken(req, 'bucket', b.id, true);
    return putObject(b.name, key, (req.body as Readable | undefined) ?? req.raw);
  });
}

export default async function storageRoutes(app: FastifyInstance) {
  await app.register(rawRoutes);

  app.get('/api/buckets', async () => {
    const buckets = all<BucketRow>('SELECT * FROM buckets ORDER BY name');
    return Promise.all(buckets.map(async (b) => ({ ...present(b), usage: await bucketUsage(b.name) })));
  });

  app.post('/api/buckets', async (req) => {
    const body = parse(
      bucketInput.extend({ name: z.string().trim().toLowerCase().regex(BUCKET_RE, '3-63 caracteres: minúsculas, números y guiones') }),
      req.body,
    );
    if (get('SELECT 1 FROM buckets WHERE name = ?', body.name)) throw badRequest('Ya existe un bucket con ese nombre');
    assertHostFree(body.hostname);
    await createBucketDir(body.name);
    const { id } = run(
      'INSERT INTO buckets (name, public, hostname, cors_origins, cache_ttl) VALUES (?, ?, ?, ?, ?)',
      body.name,
      Number(body.public),
      body.hostname,
      body.cors_origins,
      body.cache_ttl,
    );
    if (body.hostname) scheduleCaddySync();
    audit(req.user!.username, 'bucket.create', body.name, req.ip);
    return present(getBucket(id));
  });

  app.put('/api/buckets/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const b = getBucket(id);
    const body = parse(bucketInput, req.body);
    assertHostFree(body.hostname, id);
    run('UPDATE buckets SET public = ?, hostname = ?, cors_origins = ?, cache_ttl = ? WHERE id = ?', Number(body.public), body.hostname, body.cors_origins, body.cache_ttl, id);
    scheduleCaddySync();
    audit(req.user!.username, 'bucket.update', b.name, req.ip);
    return present(getBucket(id));
  });

  app.delete('/api/buckets/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const b = getBucket(id);
    const workers = boundBy('bucket', id);
    if (workers.length) throw badRequest(`Antes quita el binding de los Workers: ${workers.map((w) => w.name).join(', ')}`);
    run('DELETE FROM buckets WHERE id = ?', id);
    deleteScopeTokens('bucket', id);
    await removeBucketDir(b.name);
    scheduleCaddySync();
    audit(req.user!.username, 'bucket.delete', b.name, req.ip);
    return { ok: true };
  });

  app.get('/api/buckets/:id/objects', async (req) => {
    const { id } = parse(idParam, req.params);
    const { prefix } = parse(z.object({ prefix: z.string().max(1024).default('') }), req.query);
    const b = getBucket(id);
    return listObjects(b.name, prefix);
  });

  app.get('/api/buckets/:id/object', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const { key } = parse(keyQuery, req.query);
    return sendObject(reply, getBucket(id).name, key, true);
  });

  app.delete('/api/buckets/:id/objects', async (req) => {
    const { id } = parse(idParam, req.params);
    const q = parse(z.object({ key: z.string().max(1024).optional(), prefix: z.string().max(1024).optional() }), req.query);
    const b = getBucket(id);
    if (q.prefix) await deletePrefix(b.name, q.prefix);
    else if (q.key) await deleteObject(b.name, q.key);
    else throw badRequest('Indica key o prefix');
    audit(req.user!.username, 'storage.delete', `${b.name}/${q.prefix ?? q.key}`, req.ip);
    return { ok: true };
  });

  // --- tokens ------------------------------------------------------------------------
  app.get('/api/buckets/:id/tokens', async (req) => {
    const { id } = parse(idParam, req.params);
    getBucket(id);
    return listTokens('bucket', id);
  });
  app.post('/api/buckets/:id/tokens', async (req) => {
    const { id } = parse(idParam, req.params);
    const b = getBucket(id);
    const body = parse(z.object({ name: z.string().trim().min(1).max(80), can_write: z.boolean().default(true) }), req.body);
    const token = createToken(body.name, 'bucket', id, body.can_write);
    audit(req.user!.username, 'bucket.token', `${b.name}: ${body.name}`, req.ip);
    return { token };
  });
  app.delete('/api/buckets/:id/tokens/:tokenId', async (req) => {
    const { id, tokenId } = parse(idParam.extend({ tokenId: z.coerce.number().int() }), req.params);
    deleteToken(tokenId, 'bucket', id);
    return { ok: true };
  });

  // --- public API ----------------------------------------------------------------------
  const publicBucket = (name: string) => {
    const b = get<BucketRow>('SELECT * FROM buckets WHERE name = ?', name);
    if (!b) throw notFound('Bucket');
    return b;
  };

  // List: GET /api/storage/v1/<bucket>?prefix=
  app.get('/api/storage/v1/:bucket', async (req) => {
    const { bucket } = req.params as { bucket: string };
    const b = publicBucket(bucket);
    requireToken(req, 'bucket', b.id, false);
    const { prefix } = parse(z.object({ prefix: z.string().max(1024).default('') }), req.query);
    return listObjects(b.name, prefix);
  });

  app.get('/api/storage/v1/:bucket/*', async (req, reply) => {
    const { bucket } = req.params as { bucket: string };
    const key = (req.params as { '*': string })['*'];
    const b = publicBucket(bucket);
    if (!b.public) requireToken(req, 'bucket', b.id, false);
    if (b.public) reply.header('Cache-Control', `public, max-age=${b.cache_ttl}`);
    return sendObject(reply, b.name, key);
  });

  app.delete('/api/storage/v1/:bucket/*', async (req) => {
    const { bucket } = req.params as { bucket: string };
    const key = (req.params as { '*': string })['*'];
    const b = publicBucket(bucket);
    requireToken(req, 'bucket', b.id, true);
    await deleteObject(b.name, key);
    return { ok: true };
  });
}
