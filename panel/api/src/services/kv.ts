/** Workers KV: key-value namespaces stored in the panel database (with TTL and metadata). */
import { all, get, run } from '../db.ts';
import { HttpError } from '../lib/validate.ts';

export const KV_MAX_VALUE = 25 * 1024 * 1024;
export const KV_MAX_KEY = 512;

const now = () => Math.floor(Date.now() / 1000);

export function kvGet(ns: number, key: string) {
  const row = get<{ value: Uint8Array; metadata: string | null; expires_at: number | null }>(
    'SELECT value, metadata, expires_at FROM kv_entries WHERE namespace_id = ? AND key = ?',
    ns,
    key,
  );
  if (!row) return null;
  if (row.expires_at && row.expires_at <= now()) {
    run('DELETE FROM kv_entries WHERE namespace_id = ? AND key = ?', ns, key);
    return null;
  }
  return { value: Buffer.from(row.value), metadata: row.metadata ? (JSON.parse(row.metadata) as unknown) : null, expiration: row.expires_at };
}

export function kvPut(ns: number, key: string, value: Buffer, opts: { ttl?: number; expiration?: number; metadata?: unknown } = {}) {
  if (!key || Buffer.byteLength(key) > KV_MAX_KEY) throw new HttpError(400, `La clave debe tener entre 1 y ${KV_MAX_KEY} bytes`);
  if (value.length > KV_MAX_VALUE) throw new HttpError(413, 'El valor supera 25 MB');
  if (opts.ttl !== undefined && opts.ttl < 60) throw new HttpError(400, 'expirationTtl mínimo: 60 segundos');
  const expires = opts.expiration ?? (opts.ttl ? now() + opts.ttl : null);
  const metadata = opts.metadata === undefined ? null : JSON.stringify(opts.metadata);
  if (metadata && metadata.length > 1024) throw new HttpError(400, 'Los metadatos superan 1024 bytes');
  run(
    `INSERT INTO kv_entries (namespace_id, key, value, metadata, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(namespace_id, key) DO UPDATE SET value = excluded.value, metadata = excluded.metadata, expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
    ns,
    key,
    value,
    metadata,
    expires,
    Date.now(),
  );
}

export function kvDelete(ns: number, key: string) {
  run('DELETE FROM kv_entries WHERE namespace_id = ? AND key = ?', ns, key);
}

/** Cursor-based listing, ordered by key (like Workers KV list()). */
export function kvList(ns: number, opts: { prefix?: string; limit?: number; cursor?: string } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 1000, 1), 1000);
  const prefix = opts.prefix ?? '';
  const after = opts.cursor ? Buffer.from(opts.cursor, 'base64url').toString('utf8') : '';
  const rows = all<{ key: string; metadata: string | null; expires_at: number | null; size: number; updated_at: number }>(
    `SELECT key, metadata, expires_at, length(value) AS size, updated_at FROM kv_entries
     WHERE namespace_id = ? AND key > ? AND substr(key, 1, ?) = ? AND (expires_at IS NULL OR expires_at > ?)
     ORDER BY key LIMIT ?`,
    ns,
    after,
    prefix.length,
    prefix,
    now(),
    limit + 1,
  );
  const page = rows.slice(0, limit);
  const complete = rows.length <= limit;
  return {
    keys: page.map((r) => ({
      name: r.key,
      expiration: r.expires_at ?? undefined,
      metadata: r.metadata ? (JSON.parse(r.metadata) as unknown) : undefined,
      size: r.size,
      updated_at: r.updated_at,
    })),
    list_complete: complete,
    cursor: complete ? undefined : Buffer.from(page.at(-1)!.key).toString('base64url'),
  };
}

export function kvStats(ns: number) {
  return get<{ keys: number; size: number }>(
    'SELECT COUNT(*) AS keys, COALESCE(SUM(length(value)), 0) AS size FROM kv_entries WHERE namespace_id = ? AND (expires_at IS NULL OR expires_at > ?)',
    ns,
    now(),
  )!;
}

/** Removes expired entries every 10 minutes. */
export function startKvJanitor() {
  return setInterval(() => run('DELETE FROM kv_entries WHERE expires_at IS NOT NULL AND expires_at <= ?', now()), 10 * 60_000);
}
