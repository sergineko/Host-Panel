import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.ts';
import { all, audit, get, run, type DeploymentRow, type DomainRow, type ServerRow, type SiteRow } from '../db.ts';
import { encrypt, randomPassword, randomToken } from '../lib/crypto.ts';
import { badRequest, hostname, idParam, matchDomain, notFound, parse } from '../lib/validate.ts';
import { syncCaddy } from '../services/caddy.ts';
import { deploymentLog, enqueueDeploy, releasesOnDisk, removeSiteFromNode } from '../services/deploy.ts';
import { defaultPhpVersion, installedPhpVersions, sitePhpVersion } from '../services/php.ts';
import { describeSpec, NODE_SPEC_RE, resolveNode } from '../services/nodejs.ts';
import { LOCAL_SERVER_ID, remoteScript, siteServerIds } from '../services/servers.ts';
import { removeSftpUser } from '../services/sftp.ts';
import { nodePort, nodeUnit, removePhpPool, removeSiteSystem, stopUnit, unitLogs, writeSiteEnv } from '../services/system.ts';
import { createDatabase, dropDatabase } from '../services/databases.ts';
import { deleteScopeTokens } from '../services/tokens.ts';
import { removeSiteBackups } from '../services/backups.ts';
import { phpErrorLog } from '../services/system.ts';
import { resetWordPressPassword, setPendingAdminPassword, WP_LOCALES, wpApp, type WordPressApp } from '../services/wordpress.ts';
import type { DatabaseRow } from '../db.ts';
import { forgetStaging } from '../services/wptoolkit.ts';
import { scopeOf } from '../access.ts';
import { PHP2SHELL_MESSAGE, phpAllowed } from '../services/phpsecurity.ts';

const wordpressInput = z.object({
  name: z.string().trim().min(1).max(80),
  hostnames: z.array(hostname).min(1, 'Añade al menos un dominio').max(50),
  title: z.string().trim().min(1, 'Pon un título al sitio').max(120),
  admin_user: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9_.@-]{3,60}$/, 'Usuario: 3-60 caracteres (letras, números, _ . @ -)')
    .refine((v) => v.toLowerCase() !== 'admin', 'Por seguridad, usa un usuario distinto de "admin"'),
  admin_email: z.email('Email no válido'),
  admin_password: z.string().min(10, 'La contraseña debe tener al menos 10 caracteres').max(200).optional(),
  locale: z.enum(WP_LOCALES).default('es_ES'),
  php_version: z.string().regex(/^(\d+\.\d+)?$/).default(''),
});

/** Free database name for a new WordPress (wp_<site>, wp_<site>_2…). */
function freeDbName(siteId: number) {
  let name = `wp_${siteId}`;
  for (let i = 2; get('SELECT 1 FROM databases WHERE name = ? OR username = ?', name, name); i++) name = `wp_${siteId}_${i}`;
  return name;
}

const siteInput = z.object({
  name: z.string().trim().min(1).max(80),
  hostnames: z.array(hostname).min(1, 'Añade al menos un hostname').max(50),
  type: z.enum(['static', 'php', 'node']),
  spa: z.boolean().default(false),
  repo_url: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === '' || /^(https:\/\/|git@)[\w.@:/~-]+$/.test(v), 'URL de repositorio no válida')
    .default(''),
  branch: z.string().trim().regex(/^[\w./-]+$/, 'Rama no válida').max(200).default('main'),
  repo_token: z.string().trim().max(500).optional(),
  install_command: z.string().max(1000).default(''),
  build_command: z.string().max(1000).default(''),
  output_dir: z
    .string()
    .trim()
    .max(200)
    .refine((v) => !v.includes('..') && !v.startsWith('/'), 'Directorio no válido')
    .default(''),
  start_command: z.string().max(1000).default(''),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Nombre de variable no válido'), z.string().max(10000)).default({}),
  memory_mb: z.number().int().min(64).max(65536).default(512),
  auto_deploy: z.boolean().default(true),
  php_version: z.string().regex(/^(\d+\.\d+)?$/).default(''),
  server_ids: z.array(z.number().int().min(0)).min(1, 'Elige al menos un servidor').max(20).default([0]),
  lb_policy: z.enum(['round_robin', 'least_conn', 'ip_hash', 'random', 'first']).default('round_robin'),
  node_version: z.string().trim().regex(NODE_SPEC_RE, 'Versión de Node.js no válida').default('latest'),
});

function validateTargets(body: { php_version: string; server_ids: number[]; type: string; node_version?: string }, isNew = false) {
  if (body.type === 'node' && body.node_version && !resolveNode(body.node_version)) {
    throw badRequest(`${describeSpec(body.node_version)}: no hay ninguna instalada en este servidor (Sistema → Node.js)`);
  }
  if (body.php_version && !installedPhpVersions().includes(body.php_version)) {
    throw badRequest(`PHP ${body.php_version} no está instalado en este servidor (instálalo en Sistema → PHP)`);
  }
  // Only builds with the PHP2Shell fix. A new site without a version uses the default one.
  if (body.type === 'php') {
    const v = body.php_version || (isNew ? defaultPhpVersion() : '');
    if (v && !phpAllowed(v)) throw badRequest(PHP2SHELL_MESSAGE(v));
  }
  const remote = body.server_ids.filter((id) => id !== LOCAL_SERVER_ID);
  if (remote.length) {
    const found = all<{ id: number }>(`SELECT id FROM servers WHERE id IN (${remote.map(() => '?').join(',')})`, ...remote);
    if (found.length !== new Set(remote).size) throw badRequest('Alguno de los servidores elegidos no existe');
  }
}

/** Public shape: secrets are never sent back (only whether they are set). */
function present(site: SiteRow) {
  const { repo_token, env, hostnames, ...rest } = site;
  return {
    ...rest,
    hostnames: JSON.parse(hostnames) as string[],
    env: JSON.parse(env) as Record<string, string>,
    has_repo_token: !!repo_token,
    server_ids: siteServerIds(site),
    php_effective: site.type === 'php' ? sitePhpVersion(site) : null,
    node_version: site.node_version || 'latest',
    node_effective: site.source === 'wordpress' ? null : (resolveNode(site.node_version)?.version ?? null),
    spa: !!site.spa,
    auto_deploy: !!site.auto_deploy,
    port: site.type === 'node' ? nodePort(site.id, site.active_slot) : null,
    source: site.source,
    wordpress:
      site.source === 'wordpress'
        ? (() => {
            const a = wpApp(site);
            const host = (JSON.parse(site.hostnames) as string[])[0];
            return { ...a, site_url: `https://${host}`, admin_url: `https://${host}/wp-admin/` };
          })()
        : null,
    webhook_path: `/api/webhooks/github/${site.id}`,
  };
}

function getSite(id: number) {
  const s = get<SiteRow>('SELECT * FROM sites WHERE id = ?', id);
  if (!s) throw notFound('Sitio');
  return s;
}

function assertHostsFree(hosts: string[], exceptSiteId?: number) {
  const sites = all<SiteRow>('SELECT id, name, hostnames FROM sites');
  for (const s of sites) {
    if (s.id === exceptSiteId) continue;
    const used = JSON.parse(s.hostnames) as string[];
    const clash = hosts.find((h) => used.includes(h));
    if (clash) throw badRequest(`${clash} ya lo usa el sitio "${s.name}"`);
  }
  if (config.panelDomain && hosts.includes(config.panelDomain)) throw badRequest('Ese hostname lo usa el panel');
  if (config.mailHostname && hosts.includes(config.mailHostname)) throw badRequest('Ese hostname lo usa el webmail');
}

export default async function siteRoutes(app: FastifyInstance) {
  app.get('/api/sites', async (req) => {
    const client = scopeOf(req);
    const sites =
      client === null
        ? all<SiteRow>('SELECT * FROM sites ORDER BY name')
        : all<SiteRow>('SELECT s.* FROM sites s JOIN domains d ON d.id = s.domain_id WHERE d.client_id = ? ORDER BY s.name', client);
    const last = all<DeploymentRow>(
      'SELECT d.* FROM deployments d JOIN (SELECT site_id, MAX(id) id FROM deployments GROUP BY site_id) m ON m.id = d.id',
    );
    return sites.map((s) => {
      const dep = last.find((d) => d.site_id === s.id);
      return {
        ...present(s),
        last_deployment: dep ? { id: dep.id, status: dep.status, commit_sha: dep.commit_sha, commit_message: dep.commit_message, created_at: dep.created_at } : null,
      };
    });
  });

  // One-click WordPress: site + database + install (no repository involved).
  app.post('/api/sites/wordpress', async (req) => {
    const body = parse(wordpressInput, req.body);
    assertHostsFree(body.hostnames);
    validateTargets({ php_version: body.php_version, server_ids: [LOCAL_SERVER_ID], type: 'php' }, true);
    const domain = matchDomain(body.hostnames[0]!, all<DomainRow>('SELECT * FROM domains'));
    const { id } = run(
      `INSERT INTO sites (name, domain_id, hostnames, type, webhook_secret, auto_deploy, php_version, source)
       VALUES (?, ?, ?, 'php', ?, 0, ?, 'wordpress')`,
      body.name,
      domain?.id ?? null,
      JSON.stringify(body.hostnames),
      randomToken(24),
      body.php_version,
    );
    // Its own database and user, like any other database in the panel.
    const dbName = freeDbName(id);
    const dbPassword = randomPassword(24);
    try {
      await createDatabase(dbName, dbName, dbPassword);
    } catch (err) {
      run('DELETE FROM sites WHERE id = ?', id);
      throw err;
    }
    // The database belongs to whoever owns the domain (a reseller's client, or nobody).
    const dbId = run(
      'INSERT INTO databases (name, username, note, password_enc, client_id) VALUES (?, ?, ?, ?, ?)',
      dbName,
      dbName,
      `WordPress: ${body.name}`,
      encrypt(dbPassword),
      domain?.client_id ?? null,
    ).id;
    const app: WordPressApp = {
      database_id: dbId,
      db_name: dbName,
      title: body.title,
      admin_user: body.admin_user,
      admin_email: body.admin_email,
      locale: body.locale,
    };
    run('UPDATE sites SET app = ? WHERE id = ?', JSON.stringify(app), id);
    const adminPassword = body.admin_password || randomPassword(20);
    setPendingAdminPassword(id, adminPassword);
    await syncCaddy();
    audit(req.user!.username, 'site.create', `${body.name} (WordPress)`, req.ip);
    const deploymentId = enqueueDeploy(id, 'instalación de WordPress');
    const host = body.hostnames[0];
    return {
      ...present(getSite(id)),
      deployment_id: deploymentId,
      credentials: { admin_url: `https://${host}/wp-admin/`, user: body.admin_user, password: adminPassword },
    };
  });

  app.post('/api/sites/:id/wordpress/password', async (req) => {
    const { id } = parse(idParam, req.params);
    const site = getSite(id);
    if (site.source !== 'wordpress') throw badRequest('Este sitio no es un WordPress');
    if (!site.active_release) throw badRequest('WordPress todavía no está instalado');
    const password = await resetWordPressPassword(site);
    audit(req.user!.username, 'wordpress.password', site.name, req.ip);
    return { user: wpApp(site).admin_user, password };
  });

  app.post('/api/sites', async (req) => {
    const body = parse(siteInput, req.body);
    assertHostsFree(body.hostnames);
    validateTargets(body, true);
    const domain = matchDomain(body.hostnames[0]!, all<DomainRow>('SELECT * FROM domains'));
    const { id } = run(
      `INSERT INTO sites (name, domain_id, hostnames, type, spa, repo_url, branch, repo_token, install_command, build_command,
         output_dir, start_command, env, memory_mb, webhook_secret, auto_deploy, php_version, server_ids, lb_policy, node_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      body.name,
      domain?.id ?? null,
      JSON.stringify(body.hostnames),
      body.type,
      Number(body.spa),
      body.repo_url,
      body.branch,
      body.repo_token ?? '',
      body.install_command,
      body.build_command,
      body.output_dir,
      body.start_command,
      JSON.stringify(body.env),
      body.memory_mb,
      randomToken(24),
      Number(body.auto_deploy),
      body.php_version,
      JSON.stringify([...new Set(body.server_ids)]),
      body.lb_policy,
      body.node_version,
    );
    await syncCaddy();
    audit(req.user!.username, 'site.create', body.name, req.ip);
    const deploymentId = enqueueDeploy(id, 'create');
    return { ...present(getSite(id)), deployment_id: deploymentId };
  });

  app.get('/api/sites/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const site = getSite(id);
    return { ...present(site), releases: releasesOnDisk(id) };
  });

  app.put('/api/sites/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const prev = getSite(id);
    const body = parse(siteInput, req.body);
    if (prev.source === 'wordpress') {
      // WordPress has no repository or build: only name, domains and PHP version change.
      if (body.server_ids.some((x) => x !== LOCAL_SERVER_ID)) throw badRequest('WordPress solo puede ejecutarse en este servidor');
      Object.assign(body, {
        type: 'php',
        spa: false,
        repo_url: '',
        repo_token: undefined,
        install_command: '',
        build_command: '',
        output_dir: '',
        start_command: '',
        auto_deploy: false,
        server_ids: [LOCAL_SERVER_ID],
      });
    }
    if (body.type !== prev.type && prev.active_release) throw badRequest('No se puede cambiar el tipo de un sitio ya desplegado');
    assertHostsFree(body.hostnames, id);
    validateTargets(body);
    const domain = matchDomain(body.hostnames[0]!, all<DomainRow>('SELECT * FROM domains'));
    run(
      `UPDATE sites SET name = ?, domain_id = ?, hostnames = ?, type = ?, spa = ?, repo_url = ?, branch = ?, repo_token = ?,
         install_command = ?, build_command = ?, output_dir = ?, start_command = ?, env = ?, memory_mb = ?, auto_deploy = ?,
         php_version = ?, server_ids = ?, lb_policy = ?, node_version = ?
       WHERE id = ?`,
      body.name,
      domain?.id ?? null,
      JSON.stringify(body.hostnames),
      body.type,
      Number(body.spa),
      body.repo_url,
      body.branch,
      body.repo_token === undefined ? prev.repo_token : body.repo_token,
      body.install_command,
      body.build_command,
      body.output_dir,
      body.start_command,
      JSON.stringify(body.env),
      body.memory_mb,
      Number(body.auto_deploy),
      body.php_version,
      JSON.stringify([...new Set(body.server_ids)]),
      body.lb_policy,
      body.node_version,
      id,
    );
    const site = getSite(id);
    const before = siteServerIds(prev);
    const after = siteServerIds(site);
    // Servers the site no longer runs on are cleaned up (files, units, pools).
    for (const sid of before.filter((x) => !after.includes(x))) {
      if (sid === LOCAL_SERVER_ID) {
        for (const slot of [0, 1]) await stopUnit(nodeUnit(id, slot));
        await removePhpPool(id);
      } else {
        const server = get<ServerRow>('SELECT * FROM servers WHERE id = ?', sid);
        if (server) await removeSiteFromNode(server, id).catch((err) => req.log.warn(err));
      }
    }
    let deploymentId: number | undefined;
    const needsRedeploy =
      site.active_release &&
      (after.some((x) => !before.includes(x)) || sitePhpVersion(site) !== sitePhpVersion(prev) || site.env !== prev.env || site.memory_mb !== prev.memory_mb);
    if (site.active_release) await writeSiteEnv(site);
    const nodeChanged =
      site.active_release && site.source !== 'wordpress' && resolveNode(site.node_version)?.version !== resolveNode(prev.node_version)?.version;
    if (nodeChanged && site.repo_url) {
      // New Node.js version: install and build again with it (native modules, lockfiles…).
      deploymentId = enqueueDeploy(id, `cambio a Node.js ${resolveNode(site.node_version)?.version ?? site.node_version} (${req.user!.username})`);
    } else if (needsRedeploy || nodeChanged) {
      // Republishes the current release with the new settings (no rebuild of the repo).
      deploymentId = enqueueDeploy(id, `configuración (${req.user!.username})`, { rollbackRelease: site.active_release });
    }
    await syncCaddy();
    audit(req.user!.username, 'site.update', body.name, req.ip);
    return { ...present(site), deployment_id: deploymentId };
  });

  app.delete('/api/sites/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const site = getSite(id);
    // SFTP logins share the site's UID, so remove them before the site's Linux user.
    const sftpUsers = all<{ username: string }>('SELECT username FROM sftp_accounts WHERE site_id = ?', id).map((a) => a.username);
    run('DELETE FROM sites WHERE id = ?', id);
    await syncCaddy();
    for (const u of sftpUsers) await removeSftpUser(u).catch((err) => req.log.warn(err));
    for (const sid of siteServerIds(site).filter((x) => x !== LOCAL_SERVER_ID)) {
      const server = get<ServerRow>('SELECT * FROM servers WHERE id = ?', sid);
      if (server) await removeSiteFromNode(server, id).catch((err) => req.log.warn(err));
    }
    await removeSiteSystem(id);
    removeSiteBackups(id);
    if (site.source === 'wordpress') {
      forgetStaging(site);
      const db = get<DatabaseRow>('SELECT * FROM databases WHERE id = ?', wpApp(site).database_id);
      if (db) {
        await dropDatabase(db.name, db.username, JSON.parse(db.remote_hosts) as string[]).catch((err) => req.log.warn(err));
        run('DELETE FROM databases WHERE id = ?', db.id);
        deleteScopeTokens('database', db.id);
      }
    }
    audit(req.user!.username, 'site.delete', site.name, req.ip);
    return { ok: true };
  });

  app.post('/api/sites/:id/webhook-secret', async (req) => {
    const { id } = parse(idParam, req.params);
    getSite(id);
    run('UPDATE sites SET webhook_secret = ? WHERE id = ?', randomToken(24), id);
    return present(getSite(id));
  });

  // --- deployments -----------------------------------------------------------------
  app.post('/api/sites/:id/deploy', async (req) => {
    const { id } = parse(idParam, req.params);
    getSite(id);
    audit(req.user!.username, 'site.deploy', String(id), req.ip);
    return { deployment_id: enqueueDeploy(id, `manual (${req.user!.username})`) };
  });

  app.post('/api/sites/:id/rollback', async (req) => {
    const { id } = parse(idParam, req.params);
    getSite(id);
    if (getSite(id).source === 'wordpress') throw badRequest('WordPress no usa versiones: haz copias de seguridad de la base de datos');
    const { release } = parse(z.object({ release: z.string().regex(/^[\w-]+$/) }), req.body);
    if (!releasesOnDisk(id).includes(release)) throw badRequest('Esa release ya no está disponible');
    audit(req.user!.username, 'site.rollback', `${id} → ${release}`, req.ip);
    return { deployment_id: enqueueDeploy(id, `rollback (${req.user!.username})`, { rollbackRelease: release }) };
  });

  app.get('/api/sites/:id/deployments', async (req) => {
    const { id } = parse(idParam, req.params);
    return all<Omit<DeploymentRow, 'log'>>(
      'SELECT id, site_id, trigger, release, commit_sha, commit_message, status, created_at, finished_at FROM deployments WHERE site_id = ? ORDER BY id DESC LIMIT 50',
      id,
    );
  });

  app.get('/api/deployments/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const dep = get<DeploymentRow>('SELECT * FROM deployments WHERE id = ?', id);
    if (!dep) throw notFound('Despliegue');
    return { ...dep, log: deploymentLog(id) ?? dep.log };
  });

  app.get('/api/sites/:id/logs', async (req) => {
    const { id } = parse(idParam, req.params);
    const site = getSite(id);
    if (site.type === 'php') return { logs: (await phpErrorLog(site.id, 300)) || 'Sin errores de PHP registrados. 🎉' };
    if (site.type !== 'node') return { logs: 'Los sitios estáticos no generan logs de ejecución. Consulta la analítica para ver las peticiones.' };
    const unit = nodeUnit(id, site.active_slot);
    const parts: string[] = [];
    for (const sid of siteServerIds(site)) {
      if (sid === LOCAL_SERVER_ID) {
        parts.push(`── este servidor ──\n${await unitLogs(unit, 200)}`);
      } else {
        const server = get<ServerRow>('SELECT * FROM servers WHERE id = ?', sid);
        if (!server) continue;
        const out = await remoteScript(server, `journalctl -u ${unit} -n 200 --no-pager -o cat || true`).catch((err: Error) => err.message);
        parts.push(`── ${server.name} ──\n${out}`);
      }
    }
    return { logs: parts.join('\n\n') };
  });
}
