/**
 * Updater for the panel and its components. Versions are compared against GitHub
 * releases / nodejs.org; the update itself runs in `scripts/hp-update` as a transient
 * systemd unit, so it keeps running when it restarts the panel.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.ts';
import { getSetting, setSetting } from '../db.ts';
import { exec, tryExec } from '../lib/exec.ts';
import { HttpError } from '../lib/validate.ts';
import { runningJob, startDetachedJob, startJob } from './jobs.ts';
import { installedPhpVersions } from './php.ts';

export const COMPONENTS = ['panel', 'caddy', 'stalwart', 'roundcube', 'node', 'system'] as const;
/** Fixed components, "all", or one installed PHP branch ("php-8.5"). */
export type ComponentId = string;
export const PHP_COMPONENT = /^php-(\d+\.\d+)$/;

export function isValidComponent(id: string) {
  if (id === 'all' || (COMPONENTS as readonly string[]).includes(id)) return true;
  const m = PHP_COMPONENT.exec(id);
  return !!m && installedPhpVersions().includes(m[1]!);
}

export interface ComponentStatus {
  id: string;
  name: string;
  description: string;
  current: string;
  latest: string;
  updateAvailable: boolean;
}

const NAMES: Record<(typeof COMPONENTS)[number], [string, string]> = {
  panel: ['HostPanel', 'Panel de control (API e interfaz)'],
  caddy: ['Caddy + WAF', 'Proxy inverso, SSL, Coraza OWASP CRS y rate limit'],
  stalwart: ['Stalwart Mail', 'Servidor de correo SMTP / IMAP / JMAP'],
  roundcube: ['Roundcube', 'Webmail'],
  node: ['Node.js', 'Entorno de ejecución del panel y de las apps Node'],
  system: ['Paquetes del sistema', 'MariaDB, PowerDNS, PHP y parches de seguridad (apt)'],
};

let cache: { at: number; data: ComponentStatus[] } | null = null;

async function githubLatest(repo: string): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'HostPanel' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return '';
  const data = (await res.json()) as { tag_name?: string };
  return (data.tag_name ?? '').replace(/^v/, '');
}

async function nodeLatest(major: string): Promise<string> {
  const res = await fetch('https://nodejs.org/dist/index.json', { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return '';
  const list = (await res.json()) as { version: string }[];
  return list.find((v) => v.version.startsWith(`v${major}.`))?.version.replace(/^v/, '') ?? '';
}

const firstVersion = (text: string) => /\d+\.\d+(?:\.\d+)?/.exec(text)?.[0] ?? '';

function newer(latest: string, current: string) {
  if (!latest || !current) return false;
  const a = latest.split('.').map(Number);
  const b = current.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

/**
 * Each installed PHP branch: exact installed version vs the newest in the repository
 * (e.g. 8.5.10 → 8.5.12). Uses apt's view, refreshed with "Comprobar".
 */
async function phpVersions(): Promise<ComponentStatus[]> {
  const out: ComponentStatus[] = [];
  for (const v of installedPhpVersions()) {
    let current = '';
    let latest = '';
    if (config.dev) {
      current = `${v}.10`;
      latest = `${v}.12`;
    } else {
      const policy = await tryExec('apt-cache', ['policy', `php${v}-fpm`], { env: { LC_ALL: 'C', LANG: 'C' } });
      current = firstVersion(/Installed:\s*(\S+)/.exec(policy.output)?.[1] ?? '');
      latest = firstVersion(/Candidate:\s*(\S+)/.exec(policy.output)?.[1] ?? '');
      if (!current) current = (await tryExec(`/usr/bin/php${v}`, ['-r', 'echo PHP_VERSION;'])).output.trim();
    }
    out.push({
      id: `php-${v}`,
      name: `PHP ${v}`,
      description: 'Intérprete y extensiones de esta versión (parches de seguridad y correcciones)',
      current: current || 'no instalado',
      latest,
      updateAvailable: !!current && newer(latest, current),
    });
  }
  return out;
}

async function panelVersions() {
  if (config.dev || !existsSync(join(config.appDir, '.git'))) return { current: config.dev ? 'dev' : 'local', latest: '' };
  const current = (await tryExec('git', ['-C', config.appDir, 'rev-parse', '--short=7', 'HEAD'])).output.trim();
  const remote = await tryExec('git', ['-C', config.appDir, 'ls-remote', 'origin', 'HEAD'], { timeoutMs: 15_000 });
  const latest = remote.ok ? remote.output.trim().slice(0, 7) : '';
  return { current, latest };
}

async function currentVersions(): Promise<Record<(typeof COMPONENTS)[number], string>> {
  if (config.dev) {
    return { panel: 'dev', caddy: '2.10.0', stalwart: '0.13.1', roundcube: '1.6.11', node: process.versions.node, system: '0' };
  }
  const caddy = firstVersion((await tryExec('/usr/local/bin/caddy', ['version'])).output);
  const stalwart = firstVersion((await tryExec('/opt/stalwart/bin/stalwart', ['--version'])).output);
  let roundcube = '';
  try {
    roundcube = /RCMAIL_VERSION',\s*'([^']+)'/.exec(readFileSync(join(config.roundcubeDir, 'program/include/iniset.php'), 'utf8'))?.[1] ?? '';
  } catch {
    /* not installed */
  }
  const apt = await tryExec('apt', ['list', '--upgradable'], { env: { LANG: 'C' } });
  const upgradable = apt.output.split('\n').filter((l) => l.includes('[upgradable')).length;
  return { panel: '', caddy, stalwart, roundcube, node: process.versions.node, system: String(upgradable) };
}

export async function checkUpdates(force = false): Promise<ComponentStatus[]> {
  if (cache && !force && Date.now() - cache.at < 3600_000) return cache.data;
  // A manual check refreshes apt's package lists (PHP and system packages).
  if (force && !config.dev) await tryExec('apt-get', ['update', '-qq'], { timeoutMs: 120_000, env: { DEBIAN_FRONTEND: 'noninteractive' } });
  const current = await currentVersions();
  const panel = await panelVersions();
  const latest: Record<string, string> = {
    caddy: await githubLatest('caddyserver/caddy').catch(() => ''),
    stalwart: await githubLatest('stalwartlabs/stalwart').catch(() => ''),
    roundcube: await githubLatest('roundcube/roundcubemail').catch(() => ''),
    node: await nodeLatest(process.versions.node.split('.')[0]!).catch(() => ''),
  };
  const data: ComponentStatus[] = COMPONENTS.map((id) => {
    const [name, description] = NAMES[id];
    if (id === 'panel') {
      return { id, name, description, current: panel.current, latest: panel.latest, updateAvailable: !!panel.latest && panel.latest !== panel.current };
    }
    if (id === 'system') {
      const n = Number(current.system);
      return { id, name, description, current: n ? `${n} paquetes pendientes` : 'Al día', latest: '', updateAvailable: n > 0 };
    }
    const cur = current[id];
    const lat = latest[id] ?? '';
    return { id, name, description, current: cur || 'no instalado', latest: lat, updateAvailable: !!cur && newer(lat, cur) };
  });
  // Mail components are only relevant when mail is installed.
  const result = data.filter((c) => config.mailHostname || (c.id !== 'stalwart' && c.id !== 'roundcube'));
  // PHP branches go right after the runtime components.
  result.splice(result.findIndex((c) => c.id === 'system'), 0, ...(await phpVersions()));
  cache = { at: Date.now(), data: result };
  setSetting('updates_checked_at', new Date().toISOString());
  return result;
}

/** Starts an update. Returns the job id (its log is visible in the panel). */
export async function runUpdate(component: ComponentId, user: string): Promise<number> {
  if (runningJob('update')) throw new HttpError(409, 'Ya hay una actualización en curso');
  if (!isValidComponent(component)) throw new HttpError(400, `Componente desconocido: ${component}`);
  const php = PHP_COMPONENT.exec(component);
  const title =
    component === 'all' ? 'Actualizar todo' : php ? `Actualizar PHP ${php[1]}` : `Actualizar ${NAMES[component as (typeof COMPONENTS)[number]][0]}`;
  cache = null;
  if (config.dev) {
    return startJob('update', title, user, async (log) => {
      for (const step of ['Descargando', 'Instalando', 'Reiniciando servicios']) {
        log(`[dev] ${step} ${component}…`);
        await new Promise((r) => setTimeout(r, 700));
      }
    });
  }
  const logFile = join(config.logDir, `update-${Date.now()}.log`);
  const id = startDetachedJob('update', title, user, logFile);
  // Transient unit: survives the panel restarting itself during the update.
  await exec('systemd-run', [
    `--unit=hostpanel-update-${id}`,
    '--collect',
    '--quiet',
    '--property=Type=oneshot',
    '/bin/bash',
    join(config.appDir, 'scripts', 'hp-update'),
    component,
    '--log',
    logFile,
  ]);
  return id;
}

// --- automatic updates -----------------------------------------------------------------

export type AutoUpdateMode = 'off' | 'system' | 'all';
export const autoUpdateMode = (): AutoUpdateMode => (getSetting('auto_update') as AutoUpdateMode) ?? 'system';

/** Runs nightly (between 04:00 and 05:00 server time) according to the chosen mode. */
export function startAutoUpdates() {
  const tick = async () => {
    const mode = autoUpdateMode();
    if (mode === 'off' || config.dev) return;
    const now = new Date();
    if (now.getHours() !== 4) return;
    const last = Number(getSetting('auto_update_last') ?? 0);
    if (Date.now() - last < 20 * 3600_000) return;
    setSetting('auto_update_last', String(Date.now()));
    await runUpdate(mode === 'all' ? 'all' : 'system', 'auto').catch((err) => console.error('Auto-update:', err.message));
  };
  return setInterval(() => void tick(), 10 * 60_000);
}
