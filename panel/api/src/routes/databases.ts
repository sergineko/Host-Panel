import type { FastifyInstance } from 'fastify';
import type { Readable } from 'node:stream';
import { isIP } from 'node:net';
import { z } from 'zod';
import { config } from '../config.ts';
import { all, audit, get, run, type DatabaseRow } from '../db.ts';
import { encrypt, randomPassword } from '../lib/crypto.ts';
import { badRequest, idParam, notFound, parse } from '../lib/validate.ts';
import {
  browseTable,
  createDatabase,
  databaseSizes,
  dropDatabase,
  exportDatabase,
  importDatabase,
  listTables,
  resetDatabasePassword,
  runBatch,
  runQuery,
  setRemoteHosts,
} from '../services/databases.ts';
import { createToken, deleteScopeTokens, deleteToken, listTokens, requireToken } from '../services/tokens.ts';

const RESERVED = new Set(['mysql', 'information_schema', 'performance_schema', 'sys', 'root', 'roundcube', 'hostpanel']);
const identifier = (max: number) =>
  z
    .string()
    .trim()
    .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'Solo letras, números y _ (empezando por letra)')
    .max(max)
    .refine((v) => !RESERVED.has(v.toLowerCase()), 'Nombre reservado');

const param = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const statement = z.object({ sql: z.string().trim().min(1).max(1_000_000), params: z.array(param).max(1000).default([]) });

function getDb(id: number) {
  const row = get<DatabaseRow>('SELECT * FROM databases WHERE id = ?', id);
  if (!row) throw notFound('Base de datos');
  return row;
}

function present(r: DatabaseRow, size = 0) {
  const { password_enc, remote_hosts, ...rest } = r;
  return { ...rest, size, has_password: !!password_enc, remote_hosts: JSON.parse(remote_hosts) as string[] };
}

const panelBase = () => (config.panelDomain ? `https://${config.panelDomain}` : `https://${config.serverIp}:${config.panelPort}`);

/** Uploads (SQL import) arrive as raw streams. */
async function rawRoutes(app: FastifyInstance) {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', (_req, payload, done) => done(null, payload));
  app.post('/api/databases/:id/import', async (req) => {
    const { id } = parse(idParam, req.params);
    const db = getDb(id);
    await importDatabase(db, (req.body as Readable | undefined) ?? req.raw);
    audit(req.user!.username, 'database.import', db.name, req.ip);
    return { ok: true };
  });
}

export default async function databaseRoutes(app: FastifyInstance) {
  await app.register(rawRoutes);

  app.get('/api/databases', async () => {
    const rows = all<DatabaseRow>('SELECT * FROM databases ORDER BY name');
    const sizes = await databaseSizes().catch(() => ({}) as Record<string, number>);
    return rows.map((r) => present(r, sizes[r.name] ?? 0));
  });

  app.get('/api/databases/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const db = getDb(id);
    return { ...present(db), api_url: `${panelBase()}/api/d1/v1/${db.name}/query`, host: config.serverIp };
  });

  app.post('/api/databases', async (req) => {
    const body = parse(
      z.object({ name: identifier(64), username: identifier(32).optional(), note: z.string().max(200).default('') }),
      req.body,
    );
    if (get('SELECT 1 FROM databases WHERE name = ?', body.name)) throw badRequest('Ya existe una base de datos con ese nombre');
    const username = body.username ?? body.name.slice(0, 32);
    const password = randomPassword(24);
    await createDatabase(body.name, username, password);
    run('INSERT INTO databases (name, username, note, password_enc) VALUES (?, ?, ?, ?)', body.name, username, body.note, encrypt(password));
    audit(req.user!.username, 'database.create', body.name, req.ip);
    return { name: body.name, username, password, host: 'localhost', port: 3306 };
  });

  app.post('/api/databases/:id/password', async (req) => {
    const { id } = parse(idParam, req.params);
    const row = getDb(id);
    const password = randomPassword(24);
    await resetDatabasePassword(row.username, password, JSON.parse(row.remote_hosts) as string[]);
    run('UPDATE databases SET password_enc = ? WHERE id = ?', encrypt(password), id);
    audit(req.user!.username, 'database.password', row.name, req.ip);
    return { username: row.username, password };
  });

  app.put('/api/databases/:id/remote', async (req) => {
    const { id } = parse(idParam, req.params);
    const row = getDb(id);
    const { hosts } = parse(
      z.object({ hosts: z.array(z.string().trim().refine((h) => isIP(h) !== 0, 'IP no válida')).max(50) }),
      req.body,
    );
    const unique = [...new Set(hosts)];
    await setRemoteHosts(row, unique);
    run('UPDATE databases SET remote_hosts = ? WHERE id = ?', JSON.stringify(unique), id);
    audit(req.user!.username, 'database.remote', `${row.name}: ${unique.join(', ') || '—'}`, req.ip);
    return present(getDb(id));
  });

  app.delete('/api/databases/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const row = getDb(id);
    await dropDatabase(row.name, row.username, JSON.parse(row.remote_hosts) as string[]);
    run('DELETE FROM databases WHERE id = ?', id);
    deleteScopeTokens('database', id);
    audit(req.user!.username, 'database.delete', row.name, req.ip);
    return { ok: true };
  });

  // --- console / browser ----------------------------------------------------------------
  app.get('/api/databases/:id/tables', async (req) => {
    const { id } = parse(idParam, req.params);
    return listTables(getDb(id));
  });

  app.get('/api/databases/:id/tables/:table', async (req) => {
    const { id, table } = parse(idParam.extend({ table: z.string().regex(/^[\w$-]{1,64}$/) }), req.params);
    const { page } = parse(z.object({ page: z.coerce.number().int().min(0).default(0) }), req.query);
    return browseTable(getDb(id), table, page);
  });

  app.post('/api/databases/:id/query', async (req) => {
    const { id } = parse(idParam, req.params);
    const db = getDb(id);
    const body = parse(statement, req.body);
    const result = await runQuery(db, body.sql, body.params);
    audit(req.user!.username, 'database.query', `${db.name}: ${body.sql.slice(0, 120)}`, req.ip);
    return result;
  });

  app.get('/api/databases/:id/export', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const db = getDb(id);
    audit(req.user!.username, 'database.export', db.name, req.ip);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    return reply
      .header('Content-Type', 'application/sql; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${db.name}-${stamp}.sql"`)
      .send(exportDatabase(db.name));
  });

  // --- API tokens -------------------------------------------------------------------------
  app.get('/api/databases/:id/tokens', async (req) => {
    const { id } = parse(idParam, req.params);
    getDb(id);
    return listTokens('database', id);
  });
  app.post('/api/databases/:id/tokens', async (req) => {
    const { id } = parse(idParam, req.params);
    const db = getDb(id);
    const body = parse(z.object({ name: z.string().trim().min(1).max(80), can_write: z.boolean().default(true) }), req.body);
    const token = createToken(body.name, 'database', id, body.can_write);
    audit(req.user!.username, 'database.token', `${db.name}: ${body.name}`, req.ip);
    return { token };
  });
  app.delete('/api/databases/:id/tokens/:tokenId', async (req) => {
    const { id, tokenId } = parse(idParam.extend({ tokenId: z.coerce.number().int() }), req.params);
    deleteToken(tokenId, 'database', id);
    return { ok: true };
  });

  // --- public HTTP API (D1 style) -----------------------------------------------------------
  // POST /api/d1/v1/<database>/query  { "sql": "...", "params": [] }  or  [{ sql, params }, …]
  app.post('/api/d1/v1/:name/query', async (req) => {
    const { name } = parse(z.object({ name: z.string().max(64) }), req.params);
    const db = get<DatabaseRow>('SELECT * FROM databases WHERE name = ?', name);
    if (!db) throw notFound('Base de datos');
    const body = parse(z.union([statement, z.array(statement).min(1).max(100)]), req.body);
    const statements = Array.isArray(body) ? body : [body];
    // Read-only tokens: only reading statements, and the MariaDB session itself is read-only.
    const reading = statements.every((s) => /^\s*(select|show|describe|desc|explain)\b/i.test(s.sql));
    const token = requireToken(req, 'database', db.id, !reading);
    const readOnly = !token.can_write;
    const results =
      statements.length === 1
        ? [await runQuery(db, statements[0]!.sql, statements[0]!.params, 1000, readOnly)]
        : await runBatch(db, statements, readOnly);
    return {
      success: true,
      result: results.map((r) => ({
        results: r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]]))),
        meta: { changes: r.affectedRows, last_row_id: r.insertId, rows_read: r.rowCount, duration: r.durationMs },
      })),
    };
  });
}
