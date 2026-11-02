import type { FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { config } from '../config.ts';
import { all, audit, get, run, type NosqlDatabaseRow } from '../db.ts';
import { badRequest, idParam, notFound, parse } from '../lib/validate.ts';
import {
  createCollection,
  createIndex,
  createNosqlDatabase,
  dropCollection,
  dropIndex,
  dropNosqlDatabase,
  exportLines,
  importLines,
  isReadAction,
  listCollections,
  NOSQL_NAME_RE,
  nosqlByIdOr404,
  nosqlSize,
  runNosqlAction,
} from '../services/nosql.ts';
import { createToken, deleteScopeTokens, deleteToken, listTokens, requireToken } from '../services/tokens.ts';
import { boundBy } from './queues.ts';

const panelBase = () => (config.panelDomain ? `https://${config.panelDomain}` : `https://${config.serverIp}:${config.panelPort}`);

function present(db: NosqlDatabaseRow) {
  const collections = listCollections(db);
  return {
    ...db,
    size: nosqlSize(db.name),
    collections: collections.length,
    documents: collections.reduce((a, c) => a + c.count, 0),
    workers: boundBy('nosql', db.id),
    api_url: `${panelBase()}/api/nosql/v1/${db.name}`,
  };
}

const collParam = idParam.extend({ collection: z.string().max(64) });

/** Imports arrive as raw streams (one JSON object per line). */
async function rawRoutes(app: FastifyInstance) {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', (_req, payload, done) => done(null, payload));
  app.post('/api/nosql/:id/import', async (req) => {
    const db = nosqlByIdOr404(parse(idParam, req.params).id);
    const result = await importLines(db, (req.body as Readable | undefined) ?? req.raw);
    audit(req.user!.username, 'nosql.import', `${db.name}: ${result.documents} documentos`, req.ip);
    return result;
  });
}

export default async function nosqlRoutes(app: FastifyInstance) {
  await app.register(rawRoutes);

  app.get('/api/nosql', async () => all<NosqlDatabaseRow>('SELECT * FROM nosql_databases ORDER BY name').map(present));

  app.post('/api/nosql', async (req) => {
    const body = parse(
      z.object({
        name: z.string().trim().regex(NOSQL_NAME_RE, 'Empieza por letra; solo letras, números, _ y - (máx. 63)'),
        note: z.string().max(200).default(''),
      }),
      req.body,
    );
    if (get('SELECT 1 FROM nosql_databases WHERE name = ?', body.name)) throw badRequest('Ya existe una base de datos NoSQL con ese nombre');
    createNosqlDatabase(body.name);
    const { id } = run('INSERT INTO nosql_databases (name, note) VALUES (?, ?)', body.name, body.note);
    audit(req.user!.username, 'nosql.create', body.name, req.ip);
    return present(nosqlByIdOr404(id));
  });

  app.get('/api/nosql/:id', async (req) => present(nosqlByIdOr404(parse(idParam, req.params).id)));

  app.delete('/api/nosql/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const db = nosqlByIdOr404(id);
    const workers = boundBy('nosql', id);
    if (workers.length) throw badRequest(`Antes quita el binding de los Workers: ${workers.map((w) => w.name).join(', ')}`);
    await dropNosqlDatabase(db.name);
    run('DELETE FROM nosql_databases WHERE id = ?', id);
    deleteScopeTokens('nosql', id);
    audit(req.user!.username, 'nosql.delete', db.name, req.ip);
    return { ok: true };
  });

  // --- collections and indexes ------------------------------------------------------------
  app.get('/api/nosql/:id/collections', async (req) => listCollections(nosqlByIdOr404(parse(idParam, req.params).id)));

  app.post('/api/nosql/:id/collections', async (req) => {
    const db = nosqlByIdOr404(parse(idParam, req.params).id);
    const { name } = parse(z.object({ name: z.string().trim().min(1).max(64) }), req.body);
    createCollection(db, name);
    audit(req.user!.username, 'nosql.collection.create', `${db.name}.${name}`, req.ip);
    return { ok: true };
  });

  app.delete('/api/nosql/:id/collections/:collection', async (req) => {
    const p = parse(collParam, req.params);
    const db = nosqlByIdOr404(p.id);
    dropCollection(db, p.collection);
    audit(req.user!.username, 'nosql.collection.delete', `${db.name}.${p.collection}`, req.ip);
    return { ok: true };
  });

  app.post('/api/nosql/:id/collections/:collection/indexes', async (req) => {
    const p = parse(collParam, req.params);
    const db = nosqlByIdOr404(p.id);
    const body = parse(z.object({ field: z.string().trim().min(1).max(200), unique: z.boolean().default(false) }), req.body);
    createIndex(db, p.collection, body.field, body.unique);
    audit(req.user!.username, 'nosql.index.create', `${db.name}.${p.collection}.${body.field}`, req.ip);
    return { ok: true };
  });

  app.delete('/api/nosql/:id/collections/:collection/indexes/:field', async (req) => {
    const p = parse(collParam.extend({ field: z.string().max(200) }), req.params);
    dropIndex(nosqlByIdOr404(p.id), p.collection, p.field);
    return { ok: true };
  });

  // --- documents (panel console) ----------------------------------------------------------
  app.post('/api/nosql/:id/collections/:collection/:action', async (req) => {
    const p = parse(collParam.extend({ action: z.string().max(20) }), req.params);
    const db = nosqlByIdOr404(p.id);
    const started = performance.now();
    const result = runNosqlAction(db, p.collection, p.action, req.body ?? {});
    if (!isReadAction(p.action)) audit(req.user!.username, `nosql.${p.action}`, `${db.name}.${p.collection}`, req.ip);
    return { ...result, durationMs: Math.round((performance.now() - started) * 10) / 10 };
  });

  app.get('/api/nosql/:id/export', async (req, reply) => {
    const db = nosqlByIdOr404(parse(idParam, req.params).id);
    audit(req.user!.username, 'nosql.export', db.name, req.ip);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    return reply
      .header('Content-Type', 'application/x-ndjson; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${db.name}-${stamp}.jsonl"`)
      .send(Readable.from(exportLines(db)));
  });

  // --- API tokens -------------------------------------------------------------------------
  app.get('/api/nosql/:id/tokens', async (req) => {
    const { id } = parse(idParam, req.params);
    nosqlByIdOr404(id);
    return listTokens('nosql', id);
  });
  app.post('/api/nosql/:id/tokens', async (req) => {
    const { id } = parse(idParam, req.params);
    const db = nosqlByIdOr404(id);
    const body = parse(z.object({ name: z.string().trim().min(1).max(80), can_write: z.boolean().default(true) }), req.body);
    const token = createToken(body.name, 'nosql', id, body.can_write);
    audit(req.user!.username, 'nosql.token', `${db.name}: ${body.name}`, req.ip);
    return { token };
  });
  app.delete('/api/nosql/:id/tokens/:tokenId', async (req) => {
    const { id, tokenId } = parse(idParam.extend({ tokenId: z.coerce.number().int() }), req.params);
    deleteToken(tokenId, 'nosql', id);
    return { ok: true };
  });

  // --- public HTTP API ----------------------------------------------------------------------
  // POST /api/nosql/v1/<database>/<collection>/<action>   (find, insertOne, updateMany…)
  app.post('/api/nosql/v1/:name/:collection/:action', async (req) => {
    const p = parse(z.object({ name: z.string().max(64), collection: z.string().max(64), action: z.string().max(20) }), req.params);
    const db = get<NosqlDatabaseRow>('SELECT * FROM nosql_databases WHERE name = ?', p.name);
    if (!db) throw notFound('Base de datos');
    requireToken(req, 'nosql', db.id, !isReadAction(p.action));
    return { success: true, ...runNosqlAction(db, p.collection, p.action, req.body ?? {}) };
  });
}
