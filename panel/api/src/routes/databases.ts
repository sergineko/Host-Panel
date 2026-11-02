import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, audit, get, run } from '../db.ts';
import { randomPassword } from '../lib/crypto.ts';
import { badRequest, idParam, notFound, parse } from '../lib/validate.ts';
import { createDatabase, databaseSizes, dropDatabase, resetDatabasePassword } from '../services/databases.ts';

const RESERVED = new Set(['mysql', 'information_schema', 'performance_schema', 'sys', 'root', 'roundcube', 'hostpanel']);
const identifier = (max: number) =>
  z
    .string()
    .trim()
    .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'Solo letras, números y _ (empezando por letra)')
    .max(max)
    .refine((v) => !RESERVED.has(v.toLowerCase()), 'Nombre reservado');

interface DbRow {
  id: number;
  name: string;
  username: string;
  note: string;
  created_at: string;
}

export default async function databaseRoutes(app: FastifyInstance) {
  app.get('/api/databases', async () => {
    const rows = all<DbRow>('SELECT * FROM databases ORDER BY name');
    const sizes = await databaseSizes().catch(() => ({}) as Record<string, number>);
    return rows.map((r) => ({ ...r, size: sizes[r.name] ?? 0 }));
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
    run('INSERT INTO databases (name, username, note) VALUES (?, ?, ?)', body.name, username, body.note);
    audit(req.user!.username, 'database.create', body.name, req.ip);
    // The password is only shown once.
    return { name: body.name, username, password, host: 'localhost', port: 3306 };
  });

  app.post('/api/databases/:id/password', async (req) => {
    const { id } = parse(idParam, req.params);
    const row = get<DbRow>('SELECT * FROM databases WHERE id = ?', id);
    if (!row) throw notFound('Base de datos');
    const password = randomPassword(24);
    await resetDatabasePassword(row.username, password);
    audit(req.user!.username, 'database.password', row.name, req.ip);
    return { username: row.username, password };
  });

  app.delete('/api/databases/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const row = get<DbRow>('SELECT * FROM databases WHERE id = ?', id);
    if (!row) throw notFound('Base de datos');
    await dropDatabase(row.name, row.username);
    run('DELETE FROM databases WHERE id = ?', id);
    audit(req.user!.username, 'database.delete', row.name, req.ip);
    return { ok: true };
  });
}
