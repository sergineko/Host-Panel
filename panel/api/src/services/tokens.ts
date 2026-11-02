/** API tokens for the storage and database HTTP APIs (only a hash is stored). */
import type { FastifyRequest } from 'fastify';
import { all, get, run, type ApiTokenRow } from '../db.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import { HttpError } from '../lib/validate.ts';

export type Scope = 'bucket' | 'database' | 'queue';

export function createToken(name: string, scopeType: Scope, scopeId: number, canWrite: boolean) {
  const token = `hp_${randomToken(30)}`;
  run(
    'INSERT INTO api_tokens (name, token_hash, prefix, scope_type, scope_id, can_write) VALUES (?, ?, ?, ?, ?, ?)',
    name,
    sha256(token),
    token.slice(0, 10),
    scopeType,
    scopeId,
    Number(canWrite),
  );
  return token;
}

export function listTokens(scopeType: Scope, scopeId: number) {
  return all<ApiTokenRow>('SELECT * FROM api_tokens WHERE scope_type = ? AND scope_id = ? ORDER BY id DESC', scopeType, scopeId).map(
    ({ token_hash: _h, ...t }) => ({ ...t, can_write: !!t.can_write }),
  );
}

export function deleteToken(id: number, scopeType: Scope, scopeId: number) {
  run('DELETE FROM api_tokens WHERE id = ? AND scope_type = ? AND scope_id = ?', id, scopeType, scopeId);
}

export function deleteScopeTokens(scopeType: Scope, scopeId: number) {
  run('DELETE FROM api_tokens WHERE scope_type = ? AND scope_id = ?', scopeType, scopeId);
}

/** Reads "Authorization: Bearer hp_…" and checks it grants access to the scope. */
export function requireToken(req: FastifyRequest, scopeType: Scope, scopeId: number, write: boolean) {
  const header = String(req.headers.authorization ?? '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new HttpError(401, 'Falta el token (Authorization: Bearer …)');
  const row = get<ApiTokenRow>('SELECT * FROM api_tokens WHERE token_hash = ?', sha256(token));
  if (!row || row.scope_type !== scopeType || row.scope_id !== scopeId) throw new HttpError(403, 'Token no válido para este recurso');
  if (write && !row.can_write) throw new HttpError(403, 'El token es de solo lectura');
  run("UPDATE api_tokens SET last_used = datetime('now') WHERE id = ?", row.id);
  return row;
}
