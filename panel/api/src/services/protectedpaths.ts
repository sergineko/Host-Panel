/**
 * Password-protected paths (cPanel's "Directory Privacy"), enforced by Caddy's
 * `authentication` handler with HTTP basic auth.
 *
 * Caddy expects bcrypt. Since 2.8 it reads a hash starting with "$" as-is, and before that
 * only base64-encoded hashes, so we store base64(bcrypt) — accepted by every Caddy version.
 */
import bcrypt from 'bcryptjs';
import type { ProtectedPathRow } from '../db.ts';

const BCRYPT_COST = 11;

export async function hashForCaddy(password: string) {
  const hash = await bcrypt.hash(password, BCRYPT_COST);
  return Buffer.from(hash, 'utf8').toString('base64');
}

/** "admin/", "/admin//x/" → "/admin/x"; "" or "/" → "/". Returns null when not allowed. */
export function normalizeProtectedPath(input: string): string | null {
  let p = input.trim();
  if (!p.startsWith('/')) p = `/${p}`;
  p = p.replace(/\/{2,}/g, '/');
  if (p.length > 1) p = p.replace(/\/$/, '');
  if (!/^\/[A-Za-z0-9._~\-/@+]*$/.test(p)) return null;
  if (p.split('/').some((s) => s === '.' || s === '..')) return null;
  return p;
}

type Json = Record<string, unknown>;

const pathPatterns = (p: string) => (p === '/' ? null : [p, `${p}/*`]);

/**
 * Caddy routes for a site's protected paths. Like nested .htaccess files, the most
 * specific path wins: a request under /a/b only asks for /a/b's users, not /a's.
 */
export function protectedPathRoutes(rows: ProtectedPathRow[]): { match?: Json[]; handle: Json[] }[] {
  const byPath = new Map<string, ProtectedPathRow[]>();
  for (const r of rows) byPath.set(r.path, [...(byPath.get(r.path) ?? []), r]);
  const paths = [...byPath.keys()];
  return paths.map((path) => {
    const deeper = paths.filter((o) => o !== path && (path === '/' || o.toLowerCase().startsWith(`${path.toLowerCase()}/`)));
    const matcher: Json = {};
    const own = pathPatterns(path);
    if (own) matcher.path = own;
    if (deeper.length) matcher.not = [{ path: deeper.flatMap((d) => pathPatterns(d)!) }];
    const handler = {
      handler: 'authentication',
      providers: {
        http_basic: {
          hash: { algorithm: 'bcrypt' },
          accounts: byPath.get(path)!.map((r) => ({ username: r.username, password: r.password_hash })),
          realm: 'Zona protegida',
          hash_cache: {},
        },
      },
    };
    return Object.keys(matcher).length ? { match: [matcher], handle: [handler] } : { handle: [handler] };
  });
}
