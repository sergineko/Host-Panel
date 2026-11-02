/**
 * Remote VPS ("nodes"). The panel builds every release locally and ships it over SSH
 * (rsync) to the nodes selected for a site; the main Caddy load-balances between them.
 *
 *   visitor ─► Caddy (this server: TLS, WAF, rate limit) ─► node1:8443 / node2:8443 / local
 *
 * Each node runs a plain Caddy on :8443 (TLS with an internal certificate, reachable only
 * from the panel's IP thanks to its firewall) that serves the sites it hosts.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.ts';
import { all, get, run, type ServerRow, type SiteRow } from '../db.ts';
import { exec, tryExec, type ExecOptions } from '../lib/exec.ts';
import { HttpError } from '../lib/validate.ts';
import { nodePort, sitePaths } from './system.ts';

export const NODE_PORT = 8443;
export const LOCAL_SERVER_ID = 0;
export const HEALTH_PATH = '/.hostpanel-health';

const sshDir = () => join(config.dataDir, 'ssh');
const keyPath = () => join(sshDir(), 'id_ed25519');

export async function ensureSshKey(): Promise<string> {
  const dir = sshDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!existsSync(`${keyPath()}.pub`)) {
    if (config.dev) return 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDevModeFakeKeyForHostPanelPreviewOnly hostpanel@dev';
    await exec('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', `hostpanel@${config.serverIp}`, '-f', keyPath()]);
  }
  return readFileSync(`${keyPath()}.pub`, 'utf8').trim();
}

function sshArgs(server: ServerRow) {
  return [
    '-i', keyPath(),
    '-p', String(server.ssh_port),
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${join(sshDir(), 'known_hosts')}`,
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15',
  ];
}

/** Runs a bash script on the node (passed on stdin, so no quoting issues). */
export function remoteScript(server: ServerRow, script: string, opts: ExecOptions = {}) {
  return exec('ssh', [...sshArgs(server), `${server.ssh_user}@${server.host}`, 'bash -s'], {
    timeoutMs: 10 * 60_000,
    ...opts,
    input: `set -euo pipefail\n${script}\n`,
  });
}

/** Copies a local directory to the node (contents of `from` into `to`). */
export function rsyncTo(server: ServerRow, from: string, to: string, opts: ExecOptions = {}) {
  const ssh = ['ssh', ...sshArgs(server)].join(' ');
  return exec('rsync', ['-az', '--delete', '--rsync-path', `mkdir -p ${to} && rsync`, '-e', ssh, `${from.replace(/\/$/, '')}/`, `${server.ssh_user}@${server.host}:${to}/`], {
    timeoutMs: 30 * 60_000,
    ...opts,
  });
}

/** Shell-safe single-quoted string. */
export const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Writes a file on the node from a string (base64 avoids any escaping problem). */
export const writeFileScript = (path: string, content: string, mode = '0644') =>
  `install -D -m ${mode} /dev/null ${sq(path)}\necho ${sq(Buffer.from(content).toString('base64'))} | base64 -d > ${sq(path)}`;

export function getServer(id: number) {
  const s = get<ServerRow>('SELECT * FROM servers WHERE id = ?', id);
  if (!s) throw new HttpError(404, 'Servidor no encontrado');
  return s;
}

export function siteServerIds(site: Pick<SiteRow, 'server_ids'>): number[] {
  try {
    const ids = JSON.parse(site.server_ids) as number[];
    return ids.length ? ids : [LOCAL_SERVER_ID];
  } catch {
    return [LOCAL_SERVER_ID];
  }
}

export const siteIsLocalOnly = (site: Pick<SiteRow, 'server_ids'>) => {
  const ids = siteServerIds(site);
  return ids.length === 1 && ids[0] === LOCAL_SERVER_ID;
};

// --- health -------------------------------------------------------------------------

export interface NodeInfo {
  hostname?: string;
  os?: string;
  cpus?: number;
  mem_total?: number;
  mem_free?: number;
  disk_total?: number;
  disk_free?: number;
  load?: string;
  php?: string[];
  node?: string;
  caddy?: string;
  /** PEM root of the node's internal CA (to verify its certificate). */
  ca?: string;
}

export async function checkServer(server: ServerRow): Promise<ServerRow> {
  let info: NodeInfo = {};
  let error = '';
  if (config.dev) {
    info = { hostname: `vps-${server.id}`, os: 'Ubuntu 24.04 LTS', cpus: 2, mem_total: 4e9, mem_free: 2.6e9, disk_total: 80e9, disk_free: 61e9, load: '0.12', php: ['8.3'], node: 'v24.11.0', caddy: 'v2.10.2' };
  } else {
    const r = await tryExec('ssh', [...sshArgs(server), `${server.ssh_user}@${server.host}`, 'hostpanel-node info'], { timeoutMs: 20_000 });
    if (r.ok) {
      try {
        info = JSON.parse(r.output.trim().split('\n').at(-1) ?? '{}');
      } catch {
        error = 'Respuesta no válida del nodo (¿instalaste node-install.sh?)';
      }
    } else {
      error = r.output.trim().split('\n').slice(-3).join(' ') || 'Sin conexión SSH';
    }
  }
  run(
    "UPDATE servers SET status = ?, info = ?, last_error = ?, last_check = datetime('now') WHERE id = ?",
    error ? 'offline' : 'online',
    JSON.stringify(info),
    error,
    server.id,
  );
  return getServer(server.id);
}

let healthTimer: NodeJS.Timeout | undefined;
export function startServerHealth() {
  const tick = async () => {
    let caChanged = false;
    for (const s of all<ServerRow>('SELECT * FROM servers')) {
      const before = (JSON.parse(s.info || '{}') as NodeInfo).ca ?? '';
      const after = await checkServer(s).catch(() => s);
      if (((JSON.parse(after.info || '{}') as NodeInfo).ca ?? '') !== before) caChanged = true;
    }
    // A node's certificate authority appeared or changed: verify against it from now on.
    if (caChanged) (await import('./caddy.ts')).scheduleCaddySync();
  };
  healthTimer = setInterval(() => void tick(), 5 * 60_000);
  setTimeout(() => void tick(), 10_000);
  return healthTimer;
}

// --- Caddy configuration of a node --------------------------------------------------

type Json = Record<string, unknown>;

/**
 * Builds the node's Caddy config: one TLS server on :8443 that routes by Host to the
 * sites deployed there. `contentRoutes` comes from the main Caddy builder.
 */
export function buildNodeCaddyConfig(server: ServerRow, sites: SiteRow[], contentRoutes: (site: SiteRow) => object[]): Json {
  const routes: object[] = [
    { match: [{ path: [HEALTH_PATH] }], handle: [{ handler: 'static_response', status_code: 200, body: 'ok' }], terminal: true },
  ];
  for (const site of sites) {
    routes.push({
      match: [{ host: JSON.parse(site.hostnames) as string[] }],
      handle: [{ handler: 'subroute', routes: contentRoutes(site) }],
      terminal: true,
    });
  }
  routes.push({ handle: [{ handler: 'static_response', status_code: 404, body: 'Sitio no desplegado en este nodo' }] });
  return {
    admin: { listen: 'unix//run/caddy/admin.sock' },
    apps: {
      http: {
        servers: {
          origin: {
            listen: [`:${NODE_PORT}`],
            routes,
            automatic_https: { disable: true },
            tls_connection_policies: [{ default_sni: server.host }],
            trusted_proxies: { source: 'static', ranges: [config.serverIp] },
            client_ip_headers: ['X-Forwarded-For'],
          },
        },
      },
      tls: {
        certificates: { automate: [server.host] },
        automation: { policies: [{ subjects: [server.host], issuers: [{ module: 'internal' }] }] },
      },
    },
  };
}

export async function pushNodeCaddy(server: ServerRow, configJson: Json, log?: (l: string) => void) {
  const body = JSON.stringify(configJson);
  await remoteScript(
    server,
    // Unix socket (root only); older nodes still listen on 127.0.0.1:2019 until this push.
    `echo ${sq(Buffer.from(body).toString('base64'))} | base64 -d > /tmp/hp-caddy.json
# Nodes installed before the admin socket: let systemd create /run/caddy from now on.
if ! grep -q '^RuntimeDirectory=caddy' /etc/systemd/system/caddy.service; then
  printf 'RuntimeDirectory=caddy\nRuntimeDirectoryMode=0700\nUMask=0077\n' > /tmp/hp-caddy-unit
  sed -i '/^.Service.$/r /tmp/hp-caddy-unit' /etc/systemd/system/caddy.service
  rm -f /tmp/hp-caddy-unit
  systemctl daemon-reload
fi
if [ ! -d /run/caddy ]; then install -d -m 0700 -o caddy -g caddy /run/caddy; fi
if [ -S /run/caddy/admin.sock ]; then
  curl -fsS --unix-socket /run/caddy/admin.sock -X POST -H 'Content-Type: application/json' --data-binary @/tmp/hp-caddy.json http://127.0.0.1/load
else
  curl -fsS -X POST -H 'Content-Type: application/json' --data-binary @/tmp/hp-caddy.json http://127.0.0.1:2019/load
fi
rm -f /tmp/hp-caddy.json`,
    { onLine: log },
  );
}

/** Upstream address of a site on a node, as seen by the main Caddy. */
export function nodeUpstream(server: ServerRow) {
  return `${server.host.includes(':') ? `[${server.host}]` : server.host}:${NODE_PORT}`;
}

/** Remote paths mirror the local layout. */
export const remoteSitePaths = (id: number) => sitePaths(id);
export { nodePort };
