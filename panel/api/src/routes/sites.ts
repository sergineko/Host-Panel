import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.ts';
import { all, audit, get, run, type DeploymentRow, type DomainRow, type ServerRow, type SiteRow } from '../db.ts';
import { randomToken } from '../lib/crypto.ts';
import { badRequest, hostname, idParam, matchDomain, notFound, parse } from '../lib/validate.ts';
import { syncCaddy } from '../services/caddy.ts';
import { deploymentLog, enqueueDeploy, releasesOnDisk, removeSiteFromNode } from '../services/deploy.ts';
import { installedPhpVersions, sitePhpVersion } from '../services/php.ts';
import { LOCAL_SERVER_ID, remoteScript, siteServerIds } from '../services/servers.ts';
import { nodePort, nodeUnit, removePhpPool, removeSiteSystem, stopUnit, unitLogs, writeSiteEnv } from '../services/system.ts';

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
});

function validateTargets(body: { php_version: string; server_ids: number[]; type: string }) {
  if (body.php_version && !installedPhpVersions().includes(body.php_version)) {
    throw badRequest(`PHP ${body.php_version} no está instalado en este servidor (instálalo en Sistema → PHP)`);
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
    spa: !!site.spa,
    auto_deploy: !!site.auto_deploy,
    port: site.type === 'node' ? nodePort(site.id, site.active_slot) : null,
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
  app.get('/api/sites', async () => {
    const sites = all<SiteRow>('SELECT * FROM sites ORDER BY name');
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

  app.post('/api/sites', async (req) => {
    const body = parse(siteInput, req.body);
    assertHostsFree(body.hostnames);
    validateTargets(body);
    const domain = matchDomain(body.hostnames[0]!, all<DomainRow>('SELECT * FROM domains'));
    const { id } = run(
      `INSERT INTO sites (name, domain_id, hostnames, type, spa, repo_url, branch, repo_token, install_command, build_command,
         output_dir, start_command, env, memory_mb, webhook_secret, auto_deploy, php_version, server_ids, lb_policy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    if (body.type !== prev.type && prev.active_release) throw badRequest('No se puede cambiar el tipo de un sitio ya desplegado');
    assertHostsFree(body.hostnames, id);
    validateTargets(body);
    const domain = matchDomain(body.hostnames[0]!, all<DomainRow>('SELECT * FROM domains'));
    run(
      `UPDATE sites SET name = ?, domain_id = ?, hostnames = ?, type = ?, spa = ?, repo_url = ?, branch = ?, repo_token = ?,
         install_command = ?, build_command = ?, output_dir = ?, start_command = ?, env = ?, memory_mb = ?, auto_deploy = ?,
         php_version = ?, server_ids = ?, lb_policy = ?
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
    if (needsRedeploy) {
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
    run('DELETE FROM sites WHERE id = ?', id);
    await syncCaddy();
    for (const sid of siteServerIds(site).filter((x) => x !== LOCAL_SERVER_ID)) {
      const server = get<ServerRow>('SELECT * FROM servers WHERE id = ?', sid);
      if (server) await removeSiteFromNode(server, id).catch((err) => req.log.warn(err));
    }
    await removeSiteSystem(id);
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
    if (site.type !== 'node') return { logs: 'Los logs de ejecución solo están disponibles para sitios Node.js. Consulta la analítica para ver las peticiones.' };
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
