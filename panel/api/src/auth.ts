import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { all, audit, get, getSetting, run, setSetting } from './db.ts';
import { passwordProblem } from './lib/accounts.ts';
import {
  hashPassword,
  hashRecoveryCode,
  newRecoveryCodes,
  newTotpSecret,
  randomToken,
  sha256,
  totpStep,
  totpUri,
  verifyPassword,
} from './lib/crypto.ts';
import { badRequest, HttpError, parse } from './lib/validate.ts';
import { config } from './config.ts';

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

export type Role = 'owner' | 'admin' | 'client';
export interface SessionUser {
  id: number;
  username: string;
  role: Role;
  /** Client account the user belongs to (only for role "client"). */
  clientId: number | null;
}

const COOKIE = 'hp_session';
const SESSION_TTL = 12 * 3600 * 1000;
// Token APIs (storage, databases) check their own Bearer tokens.
// The first-run setup endpoints check the one-time setup token themselves.
const PUBLIC_PREFIXES = ['/api/auth/login', '/api/setup/status', '/api/setup/verify', '/api/setup/account', '/api/webhooks/', '/api/health', '/api/storage/v1/', '/api/sql/v1/', '/api/nosql/v1/', '/api/queues/v1/'];
const pendingTotp = new Map<number, string>();

// Brute-force protection: 8 failed attempts per IP in 15 minutes.
const failures = new Map<string, { count: number; until: number }>();
export function checkThrottle(ip: string) {
  const f = failures.get(ip);
  if (f && f.count >= 8 && f.until > Date.now()) {
    throw new HttpError(429, 'Demasiados intentos. Espera unos minutos.');
  }
}
export function registerFailure(ip: string) {
  const f = failures.get(ip);
  const fresh = !f || f.until < Date.now();
  failures.set(ip, { count: fresh ? 1 : f.count + 1, until: Date.now() + 15 * 60_000 });
}

export async function setUserPassword(username: string, password: string) {
  const hash = await hashPassword(password);
  const r = run('UPDATE users SET password_hash = ? WHERE username = ?', hash, username);
  if (!r.changes) run('INSERT INTO users (username, password_hash) VALUES (?, ?)', username, hash);
  run('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE username = ?)', username);
}

/** Ten new recovery codes for a user; returns them in clear (shown once). */
function issueRecoveryCodes(userId: number) {
  const codes = newRecoveryCodes();
  run('UPDATE users SET recovery_codes = ? WHERE id = ?', JSON.stringify(codes.map(hashRecoveryCode)), userId);
  return codes;
}

type SecondFactorUser = { id: number; totp_secret: string; totp_last_step: number; recovery_codes: string };

/**
 * Second login step. Accepts a 6-digit code from the authenticator app (each code works once)
 * or one of the recovery codes (which is then crossed out).
 */
function checkSecondFactor(user: SecondFactorUser, code: string) {
  const step = totpStep(user.totp_secret, code);
  if (step !== -1) {
    if (step <= user.totp_last_step) return { ok: false as const, reason: 'Ese código ya se ha usado. Espera al siguiente.' };
    run('UPDATE users SET totp_last_step = ? WHERE id = ?', step, user.id);
    return { ok: true as const, left: undefined };
  }
  const hashes = JSON.parse(user.recovery_codes || '[]') as string[];
  const hash = hashRecoveryCode(code);
  if (code.replace(/[^a-z0-9]/gi, '').length === 12 && hashes.includes(hash)) {
    run('UPDATE users SET recovery_codes = ? WHERE id = ?', JSON.stringify(hashes.filter((h) => h !== hash)), user.id);
    return { ok: true as const, left: hashes.length - 1 };
  }
  return { ok: false as const, reason: 'Código de verificación incorrecto' };
}

/** Why a user can't use the panel right now, or null. */
function loginBlocked(u: { disabled: number; role: Role; client_id: number | null; client_status: string | null }) {
  if (u.disabled) return 'Esta cuenta está desactivada. Contacta con el administrador del servidor.';
  if (u.role === 'client' && (!u.client_id || u.client_status !== 'active')) return 'El acceso de esta cuenta de cliente está suspendido. Contacta con tu proveedor.';
  return null;
}

/** Opens a session for a user and sets the cookie. */
export function startSession(req: FastifyRequest, reply: FastifyReply, userId: number) {
  const token = randomToken();
  run(
    'INSERT INTO sessions (id, user_id, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?)',
    sha256(token),
    userId,
    Date.now() + SESSION_TTL,
    req.ip,
    String(req.headers['user-agent'] ?? '').slice(0, 200),
  );
  run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
  setSessionCookie(req, reply, token, SESSION_TTL / 1000);
}

/** Name shown in the authenticator app next to "HostPanel". */
function totpAccount(username: string) {
  const host = config.panelDomain || config.baseDomain || config.serverIp;
  return username.includes('@') ? `${username} (${host})` : `${username}@${host}`;
}

function setSessionCookie(req: FastifyRequest, reply: FastifyReply, token: string, maxAge: number) {
  reply.setCookie(COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: req.protocol === 'https',
    maxAge,
  });
}

export async function authPlugin(app: FastifyInstance) {
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    if (PUBLIC_PREFIXES.some((p) => req.url.startsWith(p))) return;
    const token = req.cookies[COOKIE];
    if (!token) throw new HttpError(401, 'No autenticado');
    const session = get<{ user_id: number; expires_at: number; username: string; role: Role; client_id: number | null; disabled: number; client_status: string | null }>(
      `SELECT s.user_id, s.expires_at, u.username, u.role, u.client_id, u.disabled, c.status client_status
       FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN clients c ON c.id = u.client_id WHERE s.id = ?`,
      sha256(token),
    );
    if (!session || session.expires_at < Date.now()) throw new HttpError(401, 'Sesión caducada');
    const blocked = loginBlocked(session);
    if (blocked) {
      run('DELETE FROM sessions WHERE id = ?', sha256(token));
      throw new HttpError(401, blocked);
    }
    req.user = { id: session.user_id, username: session.username, role: session.role, clientId: session.role === 'client' ? session.client_id : null };
    // Sliding expiration.
    if (session.expires_at - Date.now() < SESSION_TTL / 2) {
      run('UPDATE sessions SET expires_at = ? WHERE id = ?', Date.now() + SESSION_TTL, sha256(token));
    }
  });

  app.post('/api/auth/login', async (req, reply) => {
    const ip = req.ip;
    checkThrottle(ip);
    const body = parse(z.object({ username: z.string().min(1).max(200), password: z.string().min(1).max(512), code: z.string().max(40).optional() }), req.body);
    const username = body.username.trim().toLowerCase();
    const user = get<SecondFactorUser & { username: string; password_hash: string; role: Role; client_id: number | null; disabled: number; client_status: string | null }>(
      `SELECT u.id, u.username, u.password_hash, u.totp_secret, u.totp_last_step, u.recovery_codes, u.role, u.client_id, u.disabled, c.status client_status
       FROM users u LEFT JOIN clients c ON c.id = u.client_id WHERE lower(u.username) = ?`,
      username,
    );
    if (!user || !(await verifyPassword(body.password, user.password_hash))) {
      registerFailure(ip);
      audit(username, 'login.failed', '', ip);
      throw new HttpError(401, 'Usuario o contraseña incorrectos');
    }
    const blocked = loginBlocked(user);
    if (blocked) {
      audit(user.username, 'login.blocked', blocked, ip);
      throw new HttpError(403, blocked);
    }
    let recoveryLeft: number | undefined;
    if (user.totp_secret) {
      // Second step: the password was right, now the authenticator (or recovery) code.
      if (!body.code) return { totp_required: true };
      const second = checkSecondFactor(user, body.code);
      if (!second.ok) {
        registerFailure(ip);
        audit(user.username, 'login.2fa_failed', '', ip);
        throw new HttpError(401, second.reason);
      }
      if (second.left !== undefined) {
        recoveryLeft = second.left;
        audit(user.username, 'login.recovery_code', `quedan ${second.left}`, ip);
      }
    }
    failures.delete(ip);
    startSession(req, reply, user.id);
    run("UPDATE users SET last_login_at = datetime('now') WHERE id = ?", user.id);
    audit(user.username, 'login', '', ip);
    return { username: user.username, recovery_codes_left: recoveryLeft };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[COOKIE];
    if (token) run('DELETE FROM sessions WHERE id = ?', sha256(token));
    setSessionCookie(req, reply, '', 0);
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    const u = get<{ totp_secret: string; email: string; recovery_codes: string }>('SELECT totp_secret, email, recovery_codes FROM users WHERE id = ?', req.user!.id);
    return {
      username: req.user!.username,
      email: u?.email ?? '',
      totp: !!u?.totp_secret,
      recovery_codes_left: (JSON.parse(u?.recovery_codes || '[]') as string[]).length,
      role: req.user!.role,
      client: req.user!.clientId ? (get<{ id: number; name: string }>('SELECT id, name FROM clients WHERE id = ?', req.user!.clientId) ?? null) : null,
      /** First-run wizard not finished yet: the interface sends the owner to /setup. */
      setup_pending: req.user!.role === 'owner' && getSetting('setup_completed') === '0',
    };
  });

  // --- two-factor authentication (TOTP) -------------------------------------------------
  app.post('/api/auth/2fa/setup', async (req) => {
    const secret = newTotpSecret();
    pendingTotp.set(req.user!.id, secret);
    return { secret, uri: totpUri(secret, totpAccount(req.user!.username)) };
  });

  app.post('/api/auth/2fa/enable', async (req) => {
    const { code } = parse(z.object({ code: z.string().min(6).max(10) }), req.body);
    const secret = pendingTotp.get(req.user!.id);
    if (!secret) throw new HttpError(400, 'Vuelve a empezar la configuración');
    const step = totpStep(secret, code);
    if (step === -1) throw new HttpError(400, 'El código no es correcto. Comprueba que la hora del móvil es automática.');
    run('UPDATE users SET totp_secret = ?, totp_last_step = ? WHERE id = ?', secret, step, req.user!.id);
    pendingTotp.delete(req.user!.id);
    setSetting('setup_2fa_done', '1');
    audit(req.user!.username, '2fa.enable', '', req.ip);
    return { ok: true, recovery_codes: issueRecoveryCodes(req.user!.id) };
  });

  app.post('/api/auth/2fa/disable', async (req) => {
    const { password } = parse(z.object({ password: z.string().min(1) }), req.body);
    const user = get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', req.user!.id)!;
    if (!(await verifyPassword(password, user.password_hash))) throw new HttpError(400, 'Contraseña incorrecta');
    run("UPDATE users SET totp_secret = '', recovery_codes = '[]', totp_last_step = 0 WHERE id = ?", req.user!.id);
    audit(req.user!.username, '2fa.disable', '', req.ip);
    return { ok: true };
  });

  app.post('/api/auth/2fa/recovery-codes', async (req) => {
    const { password } = parse(z.object({ password: z.string().min(1) }), req.body);
    const user = get<{ password_hash: string; totp_secret: string }>('SELECT password_hash, totp_secret FROM users WHERE id = ?', req.user!.id)!;
    if (!user.totp_secret) throw badRequest('Activa primero la verificación en dos pasos');
    if (!(await verifyPassword(password, user.password_hash))) throw badRequest('Contraseña incorrecta');
    audit(req.user!.username, '2fa.recovery_codes', '', req.ip);
    return { recovery_codes: issueRecoveryCodes(req.user!.id) };
  });

  // --- active sessions --------------------------------------------------------------------
  app.get('/api/auth/sessions', async (req) => {
    const current = sha256(req.cookies[COOKIE] ?? '');
    return all<{ id: string; expires_at: number; ip: string; user_agent: string }>(
      'SELECT id, expires_at, ip, user_agent FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY expires_at DESC',
      req.user!.id,
      Date.now(),
    ).map((s) => ({ id: s.id.slice(0, 16), ip: s.ip, user_agent: s.user_agent, expires_at: s.expires_at, current: s.id === current }));
  });

  app.delete('/api/auth/sessions/:id', async (req) => {
    const { id } = parse(z.object({ id: z.string().regex(/^[a-f0-9]{16}$/) }), req.params);
    run("DELETE FROM sessions WHERE user_id = ? AND substr(id, 1, 16) = ?", req.user!.id, id);
    audit(req.user!.username, 'session.revoke', id, req.ip);
    return { ok: true };
  });

  app.post('/api/auth/password', async (req) => {
    const body = parse(
      z.object({ current: z.string(), password: z.string().max(256) }),
      req.body,
    );
    const problem = passwordProblem(body.password, req.user!.username);
    if (problem) throw badRequest(problem);
    const user = get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', req.user!.id)!;
    if (!(await verifyPassword(body.current, user.password_hash))) throw new HttpError(400, 'La contraseña actual no es correcta');
    run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(body.password), req.user!.id);
    audit(req.user!.username, 'password.change', '', req.ip);
    return { ok: true };
  });
}
