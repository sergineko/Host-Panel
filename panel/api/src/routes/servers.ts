import type { FastifyInstance } from 'fastify';
import { isIP } from 'node:net';
import { z } from 'zod';
import { config } from '../config.ts';
import { all, audit, get, run, type ServerRow, type SiteRow } from '../db.ts';
import { badRequest, HOST_RE, idParam, parse } from '../lib/validate.ts';
import { syncCaddy } from '../services/caddy.ts';
import { syncNodeCaddy } from '../services/deploy.ts';
import { checkServer, ensureSshKey, getServer, NODE_PORT, siteServerIds } from '../services/servers.ts';
import { systemInfo } from '../services/system.ts';
import { scopeOf } from '../access.ts';

const REPO_RAW = 'https://raw.githubusercontent.com/sergineko/Host-Panel/main';

function present(s: ServerRow, sites: SiteRow[]) {
  const { ca: _ca, ...info } = JSON.parse(s.info || '{}') as Record<string, unknown>;
  return {
    ...s,
    info,
    sites: sites.filter((x) => siteServerIds(x).includes(s.id)).map((x) => ({ id: x.id, name: x.name })),
  };
}

export default async function serverRoutes(app: FastifyInstance) {
  app.get('/api/servers', async (req) => {
    if (scopeOf(req) !== null) {
      return { local: { id: 0, name: 'Este servidor', host: config.serverIp, status: 'online', sites: [] }, servers: [] };
    }
    const sites = all<SiteRow>('SELECT * FROM sites');
    const servers = all<ServerRow>('SELECT * FROM servers ORDER BY name').map((s) => present(s, sites));
    const sys = systemInfo();
    return {
      local: {
        id: 0,
        name: 'Este servidor',
        host: config.serverIp,
        status: 'online',
        info: {
          hostname: sys.hostname,
          cpus: sys.cpus,
          mem_total: sys.memory.total,
          mem_free: sys.memory.free,
          disk_total: sys.disk.total,
          disk_free: sys.disk.free,
          load: sys.load[0]?.toFixed(2),
        },
        sites: sites.filter((x) => siteServerIds(x).includes(0)).map((x) => ({ id: x.id, name: x.name })),
      },
      servers,
    };
  });

  /** Public key + one-line command to prepare a VPS as a node. */
  app.get('/api/servers/setup', async () => {
    const key = await ensureSshKey();
    const command = `curl -fsSL ${REPO_RAW}/node-install.sh | sudo bash -s -- --panel-ip ${config.serverIp} --key "${key}"`;
    return { public_key: key, command, port: NODE_PORT, panel_ip: config.serverIp };
  });

  app.post('/api/servers', async (req) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(60),
        host: z
          .string()
          .trim()
          .toLowerCase()
          .refine((h) => isIP(h) !== 0 || HOST_RE.test(h), 'IP o hostname no válido'),
        ssh_port: z.number().int().min(1).max(65535).default(22),
        ssh_user: z.string().trim().regex(/^[a-z_][a-z0-9_-]{0,31}$/, 'Usuario no válido').default('root'),
      }),
      req.body,
    );
    if (body.host === config.serverIp) throw badRequest('Esa es la IP de este servidor');
    if (get('SELECT 1 FROM servers WHERE host = ?', body.host)) throw badRequest('Ese servidor ya está añadido');
    const { id } = run('INSERT INTO servers (name, host, ssh_port, ssh_user) VALUES (?, ?, ?, ?)', body.name, body.host, body.ssh_port, body.ssh_user);
    audit(req.user!.username, 'server.create', `${body.name} (${body.host})`, req.ip);
    const checked = await checkServer(getServer(id));
    return present(checked, all<SiteRow>('SELECT * FROM sites'));
  });

  app.put('/api/servers/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    getServer(id);
    const body = parse(z.object({ name: z.string().trim().min(1).max(60) }), req.body);
    run('UPDATE servers SET name = ? WHERE id = ?', body.name, id);
    return { ok: true };
  });

  app.post('/api/servers/:id/check', async (req) => {
    const { id } = parse(idParam, req.params);
    let s = await checkServer(getServer(id));
    // A node that comes back gets its configuration again (e.g. after a reboot). The first
    // push creates its internal CA, so check again to pick it up for verification.
    if (s.status === 'online') {
      await syncNodeCaddy(s).catch((err) => req.log.warn(err));
      s = await checkServer(s);
      await syncCaddy().catch(() => {});
    }
    return present(s, all<SiteRow>('SELECT * FROM sites'));
  });

  app.delete('/api/servers/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const s = getServer(id);
    const used = all<SiteRow>('SELECT * FROM sites').filter((x) => siteServerIds(x).includes(id));
    if (used.length) throw badRequest(`Antes quita este servidor de: ${used.map((x) => x.name).join(', ')}`);
    run('DELETE FROM servers WHERE id = ?', id);
    audit(req.user!.username, 'server.delete', s.name, req.ip);
    return { ok: true };
  });
}
