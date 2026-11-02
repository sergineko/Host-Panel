import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit, get, run } from './db.ts';
import { hashPassword, randomToken, sha256, verifyPassword } from './lib/crypto.ts';
import { HttpError, parse } from './lib/validate.ts';
import { config } from './config.ts';

declare module 'fastify' {
  interface FastifyRequest {
    user?: { id: number; username: string };
  }
}

const COOKIE = 'hp_session';
const SESSION_TTL = 12 * 3600 * 1000;
const PUBLIC_PREFIXES = ['/api/auth/login', '/api/webhooks/', '/api/health'];

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
    const body = parse(z.object({ username: z.string().min(1), password: z.string().min(1) }), req.body);
    const user = get<{ id: number; password_hash: string }>('SELECT id, password_hash FROM users WHERE username = ?', body.username);
    if (!user || !(await verifyPassword(body.password, user.password_hash))) {
      registerFailure(ip);
      audit(body.username, 'login.failed', '', ip);
      throw new HttpError(401, 'Usuario o contraseña incorrectos');
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

  app.get('/api/auth/me', async (req) => ({ username: req.user!.username }));

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
