import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { all, audit, get, run } from './db.ts';
import { hashPassword, newTotpSecret, randomToken, sha256, totpUri, verifyPassword, verifyTotp } from './lib/crypto.ts';
import { HttpError, parse } from './lib/validate.ts';
import { config } from './config.ts';

declare module 'fastify' {
  interface FastifyRequest {
    user?: { id: number; username: string };
  }
}

const COOKIE = 'hp_session';
const SESSION_TTL = 12 * 3600 * 1000;
// Token APIs (storage, databases) check their own Bearer tokens.
const PUBLIC_PREFIXES = ['/api/auth/login', '/api/webhooks/', '/api/health', '/api/storage/v1/', '/api/d1/v1/'];
const pendingTotp = new Map<number, string>();

// Brute-force protection: 8 failed attempts per IP in 15 minutes.
const failures = new Map<string, { count: number; until: number }>();
function checkThrottle(ip: string) {
  const f = failures.get(ip);
  if (f && f.count >= 8 && f.until > Date.now()) {
    throw new HttpError(429, 'Demasiados intentos. Espera unos minutos.');
  }
}
function registerFailure(ip: string) {
  const f = failures.get(ip);
  const fresh = !f || f.until < Date.now();
  failures.set(ip, { count: fresh ? 1 : f.count + 1, until: Date.now() + 15 * 60_000 });
}

export async function ensureAdminUser() {
  const existing = get<{ n: number }>('SELECT COUNT(*) n FROM users');
  if (existing && existing.n > 0) return;
  const password = config.adminPassword || (config.dev ? 'admin' : '');
  if (!password) {
    console.warn('No hay usuarios y HP_ADMIN_PASSWORD está vacío. Usa: hostpanel reset-password');
    return;
  }
  run('INSERT INTO users (username, password_hash) VALUES (?, ?)', config.adminUser, await hashPassword(password));
  console.log(`Usuario administrador "${config.adminUser}" creado.`);
}

export async function setUserPassword(username: string, password: string) {
  const hash = await hashPassword(password);
  const r = run('UPDATE users SET password_hash = ? WHERE username = ?', hash, username);
  if (!r.changes) run('INSERT INTO users (username, password_hash) VALUES (?, ?)', username, hash);
  run('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE username = ?)', username);
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
    const session = get<{ user_id: number; expires_at: number; username: string }>(
      'SELECT s.user_id, s.expires_at, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?',
      sha256(token),
    );
    if (!session || session.expires_at < Date.now()) throw new HttpError(401, 'Sesión caducada');
    req.user = { id: session.user_id, username: session.username };
    // Sliding expiration.
    if (session.expires_at - Date.now() < SESSION_TTL / 2) {
      run('UPDATE sessions SET expires_at = ? WHERE id = ?', Date.now() + SESSION_TTL, sha256(token));
    }
  });

  app.post('/api/auth/login', async (req, reply) => {
    const ip = req.ip;
    checkThrottle(ip);
    const body = parse(z.object({ username: z.string().min(1), password: z.string().min(1), code: z.string().max(10).optional() }), req.body);
    const user = get<{ id: number; password_hash: string; totp_secret: string }>('SELECT id, password_hash, totp_secret FROM users WHERE username = ?', body.username);
    if (!user || !(await verifyPassword(body.password, user.password_hash))) {
      registerFailure(ip);
      audit(body.username, 'login.failed', '', ip);
      throw new HttpError(401, 'Usuario o contraseña incorrectos');
    }
    if (user.totp_secret) {
      // Second step: the password was right, now the authenticator code.
      if (!body.code) return { totp_required: true };
      if (!verifyTotp(user.totp_secret, body.code)) {
        registerFailure(ip);
        audit(body.username, 'login.2fa_failed', '', ip);
        throw new HttpError(401, 'Código de verificación incorrecto');
      }
    }
    failures.delete(ip);
    const token = randomToken();
    run(
      'INSERT INTO sessions (id, user_id, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?)',
      sha256(token),
      user.id,
      Date.now() + SESSION_TTL,
      ip,
      String(req.headers['user-agent'] ?? '').slice(0, 200),
    );
    run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
    audit(body.username, 'login', '', ip);
    setSessionCookie(req, reply, token, SESSION_TTL / 1000);
    return { username: body.username };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[COOKIE];
    if (token) run('DELETE FROM sessions WHERE id = ?', sha256(token));
    setSessionCookie(req, reply, '', 0);
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    const u = get<{ totp_secret: string }>('SELECT totp_secret FROM users WHERE id = ?', req.user!.id);
    return { username: req.user!.username, totp: !!u?.totp_secret };
  });

  // --- two-factor authentication (TOTP) -------------------------------------------------
  app.post('/api/auth/2fa/setup', async (req) => {
    const secret = newTotpSecret();
    pendingTotp.set(req.user!.id, secret);
    return { secret, uri: totpUri(secret, req.user!.username) };
  });

  app.post('/api/auth/2fa/enable', async (req) => {
    const { code } = parse(z.object({ code: z.string().min(6).max(10) }), req.body);
    const secret = pendingTotp.get(req.user!.id);
    if (!secret) throw new HttpError(400, 'Vuelve a empezar la configuración');
    if (!verifyTotp(secret, code)) throw new HttpError(400, 'El código no es correcto. Revisa la hora del móvil.');
    run('UPDATE users SET totp_secret = ? WHERE id = ?', secret, req.user!.id);
    pendingTotp.delete(req.user!.id);
    audit(req.user!.username, '2fa.enable', '', req.ip);
    return { ok: true };
  });

  app.post('/api/auth/2fa/disable', async (req) => {
    const { password } = parse(z.object({ password: z.string().min(1) }), req.body);
    const user = get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', req.user!.id)!;
    if (!(await verifyPassword(password, user.password_hash))) throw new HttpError(400, 'Contraseña incorrecta');
    run("UPDATE users SET totp_secret = '' WHERE id = ?", req.user!.id);
    audit(req.user!.username, '2fa.disable', '', req.ip);
    return { ok: true };
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
      z.object({ current: z.string(), password: z.string().min(10, 'Mínimo 10 caracteres') }),
      req.body,
    );
    const user = get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', req.user!.id)!;
    if (!(await verifyPassword(body.current, user.password_hash))) throw new HttpError(400, 'La contraseña actual no es correcta');
    run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(body.password), req.user!.id);
    audit(req.user!.username, 'password.change', '', req.ip);
    return { ok: true };
  });
}
