/**
 * Reseller mode: client accounts, their logins and the team.
 *
 * A client account is the billing unit (one per customer); it can have several logins and owns
 * domains and databases. Only staff reach these routes (clients are denied in access.ts).
 * Team members (admin) manage clients; only the owner manages the team.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Role, SessionUser } from '../auth.ts';
import { all, audit, db, get, run, type ClientRow } from '../db.ts';
import { normalizeUsername, passwordProblem, usernameProblem } from '../lib/accounts.ts';
import { hashPassword, randomPassword } from '../lib/crypto.ts';
import { badRequest, HttpError, idParam, notFound, parse } from '../lib/validate.ts';
import { assertAccessAvailable, clientAccesses } from '../services/license.ts';

interface UserRow {
  id: number;
  username: string;
  email: string;
  role: Role;
  client_id: number | null;
  disabled: number;
  totp_secret: string;
  last_login_at: string | null;
  created_at: string;
}

const clientInput = z.object({
  name: z.string().trim().min(1, 'Escribe un nombre').max(120),
  email: z.union([z.literal(''), z.email('Email no válido')]).default(''),
  company: z.string().trim().max(120).default(''),
  notes: z.string().max(2000).default(''),
});

function getClient(id: number) {
  const c = get<ClientRow>('SELECT * FROM clients WHERE id = ?', id);
  if (!c) throw notFound('Cliente');
  return c;
}

function getUser(id: number) {
  const u = get<UserRow>('SELECT * FROM users WHERE id = ?', id);
  if (!u) throw notFound('Usuario');
  return u;
}

const presentUser = (u: UserRow & { client_name?: string | null }) => ({
  id: u.id,
  username: u.username,
  email: u.email,
  role: u.role,
  client_id: u.client_id,
  client_name: u.client_name ?? null,
  disabled: !!u.disabled,
  totp: !!u.totp_secret,
  last_login_at: u.last_login_at,
  created_at: u.created_at,
});

/** Team members manage client logins; only the owner manages the team (and nobody manages the owner but themselves). */
function assertCanManage(actor: SessionUser, target: UserRow) {
  if (target.role === 'owner') throw new HttpError(403, 'La cuenta del titular solo se gestiona desde su propia sesión');
  if (target.role === 'admin' && actor.role !== 'owner') throw new HttpError(403, 'Solo el titular gestiona el equipo');
}

function activeClients() {
  return get<{ n: number }>("SELECT COUNT(*) n FROM clients WHERE status = 'active'")!.n;
}

export default async function clientRoutes(app: FastifyInstance) {
  // --- client accounts -----------------------------------------------------------------------
  app.get('/api/clients', async () => {
    const rows = all<ClientRow & { domains: number; sites: number; users: number; databases: number }>(
      `SELECT c.*,
         (SELECT COUNT(*) FROM domains d WHERE d.client_id = c.id) domains,
         (SELECT COUNT(*) FROM sites s JOIN domains d ON d.id = s.domain_id WHERE d.client_id = c.id) sites,
         (SELECT COUNT(*) FROM users u WHERE u.client_id = c.id) users,
         (SELECT COUNT(*) FROM databases b WHERE b.client_id = c.id) databases
       FROM clients c ORDER BY c.name COLLATE NOCASE`,
    );
    // Billing unit of the licence: active client accounts.
    return { clients: rows, active: activeClients() };
  });

  app.post('/api/clients', async (req) => {
    const body = parse(clientInput, req.body);
    const { id } = run('INSERT INTO clients (name, email, company, notes) VALUES (?, ?, ?, ?)', body.name, body.email, body.company, body.notes);
    audit(req.user!.username, 'client.create', body.name, req.ip);
    return getClient(id);
  });

  app.get('/api/clients/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const client = getClient(id);
    return {
      ...client,
      domains: all<{ id: number; name: string }>('SELECT id, name FROM domains WHERE client_id = ? ORDER BY name', id),
      databases: all<{ id: number; name: string }>('SELECT id, name FROM databases WHERE client_id = ? ORDER BY name', id),
      users: all<UserRow>('SELECT * FROM users WHERE client_id = ? ORDER BY username', id).map(presentUser),
    };
  });

  app.put('/api/clients/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const before = getClient(id);
    const body = parse(clientInput.extend({ status: z.enum(['active', 'suspended']) }), req.body);
    // Re-activating brings its logins back: they must fit in the plan.
    if (body.status === 'active' && before.status === 'suspended') assertAccessAvailable(clientAccesses(id));
    run('UPDATE clients SET name = ?, email = ?, company = ?, notes = ?, status = ? WHERE id = ?', body.name, body.email, body.company, body.notes, body.status, id);
    if (body.status === 'suspended' && before.status !== 'suspended') {
      // Out right away, not at the next page load.
      run('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE client_id = ?)', id);
      audit(req.user!.username, 'client.suspend', before.name, req.ip);
    } else if (body.status === 'active' && before.status === 'suspended') {
      audit(req.user!.username, 'client.activate', before.name, req.ip);
    } else {
      audit(req.user!.username, 'client.update', body.name, req.ip);
    }
    return getClient(id);
  });

  app.delete('/api/clients/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const client = getClient(id);
    // Domains and databases go back to the holder; the client's logins are deleted.
    run('DELETE FROM clients WHERE id = ?', id);
    audit(req.user!.username, 'client.delete', client.name, req.ip);
    return { ok: true };
  });

  /** Assigns exactly these domains and databases to the client. */
  app.put('/api/clients/:id/resources', async (req) => {
    const { id } = parse(idParam, req.params);
    const client = getClient(id);
    const body = parse(z.object({ domain_ids: z.array(z.number().int()).max(5000), database_ids: z.array(z.number().int()).max(5000) }), req.body);
    for (const [table, ids, label] of [
      ['domains', body.domain_ids, 'El dominio'],
      ['databases', body.database_ids, 'La base de datos'],
    ] as const) {
      for (const rid of ids) {
        const row = get<{ name: string; client_id: number | null; owner: string | null }>(
          `SELECT t.name, t.client_id, c.name owner FROM ${table} t LEFT JOIN clients c ON c.id = t.client_id WHERE t.id = ?`,
          rid,
        );
        if (!row) throw notFound(label);
        if (row.client_id !== null && row.client_id !== id) throw badRequest(`${label} ${row.name} ya pertenece a ${row.owner}. Quítaselo primero.`);
      }
    }
    db.exec('BEGIN');
    try {
      for (const [table, ids] of [
        ['domains', body.domain_ids],
        ['databases', body.database_ids],
      ] as const) {
        run(`UPDATE ${table} SET client_id = NULL WHERE client_id = ?`, id);
        for (const rid of ids) run(`UPDATE ${table} SET client_id = ? WHERE id = ?`, id, rid);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    audit(req.user!.username, 'client.resources', `${client.name}: ${body.domain_ids.length} dominios, ${body.database_ids.length} BD`, req.ip);
    return { ok: true };
  });

  // --- logins ----------------------------------------------------------------------------------
  app.get('/api/users', async () =>
    all<UserRow & { client_name: string | null }>(
      `SELECT u.*, c.name client_name FROM users u LEFT JOIN clients c ON c.id = u.client_id
       ORDER BY CASE u.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.username`,
    ).map(presentUser),
  );

  app.post('/api/users', async (req) => {
    const body = parse(
      z.object({
        username: z.string().max(200),
        email: z.union([z.literal(''), z.email('Email no válido')]).default(''),
        role: z.enum(['admin', 'client']),
        client_id: z.number().int().optional(),
        password: z.string().max(256).optional(),
      }),
      req.body,
    );
    if (body.role === 'admin' && req.user!.role !== 'owner') throw new HttpError(403, 'Solo el titular puede añadir miembros al equipo');
    if (body.role === 'client') {
      if (!body.client_id) throw badRequest('Elige el cliente al que pertenece');
      getClient(body.client_id);
    }
    const username = normalizeUsername(body.username);
    const problem = usernameProblem(username);
    if (problem) throw badRequest(problem);
    if (get('SELECT 1 FROM users WHERE lower(username) = ?', username)) throw badRequest('Ya existe un usuario con ese nombre');
    // A login of a suspended client can't sign in, so it doesn't use an access yet.
    const clientActive = body.role !== 'client' || get<{ status: string }>('SELECT status FROM clients WHERE id = ?', body.client_id!)?.status === 'active';
    if (clientActive) assertAccessAvailable();
    const generated = !body.password;
    const password = body.password || randomPassword(20);
    if (!generated) {
      const pwProblem = passwordProblem(password, username);
      if (pwProblem) throw badRequest(pwProblem);
    }
    const { id } = run(
      'INSERT INTO users (username, password_hash, email, role, client_id) VALUES (?, ?, ?, ?, ?)',
      username,
      await hashPassword(password),
      body.email,
      body.role,
      body.role === 'client' ? body.client_id! : null,
    );
    audit(req.user!.username, 'user.create', `${username} (${body.role})`, req.ip);
    return { user: presentUser(getUser(id)), password: generated ? password : undefined };
  });

  app.put('/api/users/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const target = getUser(id);
    assertCanManage(req.user!, target);
    const body = parse(z.object({ email: z.union([z.literal(''), z.email('Email no válido')]).optional(), disabled: z.boolean().optional() }), req.body);
    if (body.email !== undefined) run('UPDATE users SET email = ? WHERE id = ?', body.email, id);
    if (body.disabled !== undefined) {
      if (target.disabled && !body.disabled) {
        const clientActive = target.role !== 'client' || get<{ status: string }>('SELECT status FROM clients WHERE id = ?', target.client_id!)?.status === 'active';
        if (clientActive) assertAccessAvailable();
      }
      run('UPDATE users SET disabled = ? WHERE id = ?', Number(body.disabled), id);
      if (body.disabled) run('DELETE FROM sessions WHERE user_id = ?', id);
      audit(req.user!.username, body.disabled ? 'user.disable' : 'user.enable', target.username, req.ip);
    }
    return presentUser(getUser(id));
  });

  app.post('/api/users/:id/password', async (req) => {
    const { id } = parse(idParam, req.params);
    const target = getUser(id);
    assertCanManage(req.user!, target);
    const password = randomPassword(20);
    run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(password), id);
    run('DELETE FROM sessions WHERE user_id = ?', id);
    audit(req.user!.username, 'user.password_reset', target.username, req.ip);
    return { username: target.username, password };
  });

  app.post('/api/users/:id/2fa/reset', async (req) => {
    const { id } = parse(idParam, req.params);
    const target = getUser(id);
    assertCanManage(req.user!, target);
    run("UPDATE users SET totp_secret = '', recovery_codes = '[]', totp_last_step = 0 WHERE id = ?", id);
    audit(req.user!.username, 'user.2fa_reset', target.username, req.ip);
    return { ok: true };
  });

  app.delete('/api/users/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const target = getUser(id);
    if (target.id === req.user!.id) throw badRequest('No puedes eliminar tu propia cuenta');
    assertCanManage(req.user!, target);
    run('DELETE FROM users WHERE id = ?', id);
    audit(req.user!.username, 'user.delete', target.username, req.ip);
    return { ok: true };
  });
}
