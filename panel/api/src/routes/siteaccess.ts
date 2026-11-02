/**
 * Access to a site: SFTP accounts (cPanel "FTP Accounts") and password-protected
 * paths (cPanel "Directory Privacy"). Passwords are returned once and never stored in clear.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, audit, get, run, type ProtectedPathRow, type ServerRow, type SftpAccountRow, type SiteRow } from '../db.ts';
import { config } from '../config.ts';
import { randomPassword } from '../lib/crypto.ts';
import { badRequest, idParam, notFound, parse } from '../lib/validate.ts';
import { syncCaddy } from '../services/caddy.ts';
import { syncNodeCaddy } from '../services/deploy.ts';
import { hashForCaddy, normalizeProtectedPath } from '../services/protectedpaths.ts';
import { LOCAL_SERVER_ID, siteIsLocalOnly, siteServerIds } from '../services/servers.ts';
import {
  KEY_LINE_RE,
  createSftpUser,
  normalizeKeys,
  removeSftpUser,
  setSftpPassword,
  sftpUsernameProblem,
  sshPort,
  systemUserExists,
  writeSftpKeys,
} from '../services/sftp.ts';

function getSite(id: number) {
  const s = get<SiteRow>('SELECT * FROM sites WHERE id = ?', id);
  if (!s) throw notFound('Sitio');
  return s;
}

const password = z.string().min(10, 'La contraseña debe tener al menos 10 caracteres').max(128).optional().or(z.literal('').transform(() => undefined));

const publicKeys = z
  .string()
  .max(20_000)
  .default('')
  .transform(normalizeKeys)
  .refine((v) => !v || v.split('\n').every((l) => KEY_LINE_RE.test(l)), 'Alguna clave pública no es válida (formato OpenSSH: «ssh-ed25519 AAAA… comentario»)');

const presentAccount = (a: SftpAccountRow) => {
  const keys = a.public_keys ? a.public_keys.split('\n') : [];
  return {
    id: a.id,
    username: a.username,
    note: a.note,
    public_keys: a.public_keys,
    keys: keys.map((k) => {
      const [type, , ...comment] = k.split(' ');
      return { type: type!, comment: comment.join(' ') };
    }),
    created_at: a.created_at,
    password_changed_at: a.password_changed_at,
  };
};

/** Pushes the Caddy config here and on every remote node that serves the site. */
async function applyProtection(site: SiteRow) {
  await syncCaddy();
  for (const sid of siteServerIds(site).filter((x) => x !== LOCAL_SERVER_ID)) {
    const server = get<ServerRow>('SELECT * FROM servers WHERE id = ?', sid);
    if (server) await syncNodeCaddy(server).catch((err) => console.error(err));
  }
}

const basicUser = z
  .string()
  .trim()
  .min(1, 'Escribe el usuario')
  .max(64)
  .regex(/^[A-Za-z0-9._@-]+$/, 'Usuario: letras, números, «.», «_», «-» o «@»');

export default async function siteAccessRoutes(app: FastifyInstance) {
  // --- SFTP accounts -----------------------------------------------------------------------
  app.get('/api/sites/:id/sftp', async (req) => {
    const site = getSite(parse(idParam, req.params).id);
    return {
      host: config.serverIp,
      port: await sshPort(),
      local_only: siteIsLocalOnly(site),
      accounts: all<SftpAccountRow>('SELECT * FROM sftp_accounts WHERE site_id = ? ORDER BY id', site.id).map(presentAccount),
    };
  });

  app.post('/api/sites/:id/sftp', async (req) => {
    const site = getSite(parse(idParam, req.params).id);
    const b = parse(
      z.object({
        username: z.string().trim().toLowerCase(),
        password,
        public_keys: publicKeys,
        note: z.string().trim().max(200).default(''),
      }),
      req.body,
    );
    const problem = sftpUsernameProblem(b.username);
    if (problem) throw badRequest(problem);
    if (get('SELECT 1 FROM sftp_accounts WHERE username = ?', b.username) || (await systemUserExists(b.username))) {
      throw badRequest(`El usuario «${b.username}» ya existe en el servidor`);
    }
    if ((get<{ n: number }>('SELECT COUNT(*) n FROM sftp_accounts WHERE site_id = ?', site.id)?.n ?? 0) >= 20) throw badRequest('Máximo 20 cuentas SFTP por sitio');
    const pass = b.password ?? randomPassword(20);
    await createSftpUser(site.id, b.username, pass, b.public_keys);
    const { id } = run('INSERT INTO sftp_accounts (site_id, username, public_keys, note) VALUES (?, ?, ?, ?)', site.id, b.username, b.public_keys, b.note);
    audit(req.user!.username, 'sftp.create', `${site.name}: ${b.username}`, req.ip);
    return { account: presentAccount(get<SftpAccountRow>('SELECT * FROM sftp_accounts WHERE id = ?', id)!), password: pass };
  });

  const getAccount = (siteId: number, accountId: number) => {
    const a = get<SftpAccountRow>('SELECT * FROM sftp_accounts WHERE id = ? AND site_id = ?', accountId, siteId);
    if (!a) throw notFound('Cuenta SFTP');
    return a;
  };
  const accountParams = idParam.extend({ accountId: z.coerce.number().int() });

  app.put('/api/sites/:id/sftp/:accountId', async (req) => {
    const p = parse(accountParams, req.params);
    const site = getSite(p.id);
    const a = getAccount(site.id, p.accountId);
    const b = parse(z.object({ public_keys: publicKeys, note: z.string().trim().max(200).default('') }), req.body);
    await writeSftpKeys(a.username, b.public_keys);
    run('UPDATE sftp_accounts SET public_keys = ?, note = ? WHERE id = ?', b.public_keys, b.note, a.id);
    audit(req.user!.username, 'sftp.update', `${site.name}: ${a.username}`, req.ip);
    return presentAccount(get<SftpAccountRow>('SELECT * FROM sftp_accounts WHERE id = ?', a.id)!);
  });

  app.post('/api/sites/:id/sftp/:accountId/password', async (req) => {
    const p = parse(accountParams, req.params);
    const site = getSite(p.id);
    const a = getAccount(site.id, p.accountId);
    const b = parse(z.object({ password }), req.body ?? {});
    const pass = b.password ?? randomPassword(20);
    await setSftpPassword(a.username, pass);
    run("UPDATE sftp_accounts SET password_changed_at = datetime('now') WHERE id = ?", a.id);
    audit(req.user!.username, 'sftp.password', `${site.name}: ${a.username}`, req.ip);
    return { password: pass };
  });

  app.delete('/api/sites/:id/sftp/:accountId', async (req) => {
    const p = parse(accountParams, req.params);
    const site = getSite(p.id);
    const a = getAccount(site.id, p.accountId);
    await removeSftpUser(a.username);
    run('DELETE FROM sftp_accounts WHERE id = ?', a.id);
    audit(req.user!.username, 'sftp.delete', `${site.name}: ${a.username}`, req.ip);
    return { ok: true };
  });

  // --- password-protected paths -------------------------------------------------------------
  app.get('/api/sites/:id/protected-paths', async (req) => {
    const site = getSite(parse(idParam, req.params).id);
    const rows = all<ProtectedPathRow>('SELECT * FROM protected_paths WHERE site_id = ? ORDER BY path, username', site.id);
    const paths = new Map<string, { id: number; username: string; created_at: string }[]>();
    for (const r of rows) paths.set(r.path, [...(paths.get(r.path) ?? []), { id: r.id, username: r.username, created_at: r.created_at }]);
    return { hostnames: JSON.parse(site.hostnames) as string[], paths: [...paths].map(([path, users]) => ({ path, users })) };
  });

  app.post('/api/sites/:id/protected-paths', async (req) => {
    const site = getSite(parse(idParam, req.params).id);
    const b = parse(z.object({ path: z.string().max(500), username: basicUser, password }), req.body);
    const path = normalizeProtectedPath(b.path);
    if (!path) throw badRequest('Ruta no válida: usa algo como /admin o /privado/informes');
    if (get('SELECT 1 FROM protected_paths WHERE site_id = ? AND path = ? AND username = ?', site.id, path, b.username)) {
      throw badRequest(`«${b.username}» ya tiene acceso a ${path}`);
    }
    if ((get<{ n: number }>('SELECT COUNT(*) n FROM protected_paths WHERE site_id = ?', site.id)?.n ?? 0) >= 100) throw badRequest('Máximo 100 usuarios protegidos por sitio');
    const pass = b.password ?? randomPassword(16);
    run('INSERT INTO protected_paths (site_id, path, username, password_hash) VALUES (?, ?, ?, ?)', site.id, path, b.username, await hashForCaddy(pass));
    try {
      await applyProtection(site);
    } catch (err) {
      run('DELETE FROM protected_paths WHERE site_id = ? AND path = ? AND username = ?', site.id, path, b.username);
      throw err;
    }
    audit(req.user!.username, 'protect.create', `${site.name}: ${path} (${b.username})`, req.ip);
    return { path, username: b.username, password: pass };
  });

  const ppParams = idParam.extend({ entryId: z.coerce.number().int() });
  const getEntry = (siteId: number, entryId: number) => {
    const e = get<ProtectedPathRow>('SELECT * FROM protected_paths WHERE id = ? AND site_id = ?', entryId, siteId);
    if (!e) throw notFound('Usuario');
    return e;
  };

  app.post('/api/sites/:id/protected-paths/:entryId/password', async (req) => {
    const p = parse(ppParams, req.params);
    const site = getSite(p.id);
    const e = getEntry(site.id, p.entryId);
    const b = parse(z.object({ password }), req.body ?? {});
    const pass = b.password ?? randomPassword(16);
    run('UPDATE protected_paths SET password_hash = ? WHERE id = ?', await hashForCaddy(pass), e.id);
    await applyProtection(site);
    audit(req.user!.username, 'protect.password', `${site.name}: ${e.path} (${e.username})`, req.ip);
    return { password: pass };
  });

  app.delete('/api/sites/:id/protected-paths/:entryId', async (req) => {
    const p = parse(ppParams, req.params);
    const site = getSite(p.id);
    const e = getEntry(site.id, p.entryId);
    run('DELETE FROM protected_paths WHERE id = ?', e.id);
    await applyProtection(site);
    audit(req.user!.username, 'protect.delete', `${site.name}: ${e.path} (${e.username})`, req.ip);
    return { ok: true };
  });
}
