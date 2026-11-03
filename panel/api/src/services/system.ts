import { mkdir, rm, writeFile, rename, symlink, readlink, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { cpus, freemem, loadavg, totalmem, uptime, hostname as osHostname } from 'node:os';
import { statfsSync } from 'node:fs';
import { config } from '../config.ts';
import type { SiteRow } from '../db.ts';
import { exec, tryExec, type ExecOptions } from '../lib/exec.ts';
import { installedPhpVersions, phpPoolDir, phpService, sitePhpVersion } from './php.ts';

export const siteUser = (id: number) => `hp-${id}`;
export const phpSocket = (id: number) => `/run/php/hp-${id}.sock`;
/** Each Node site gets two ports (blue/green slots). */
export const nodePort = (id: number, slot: number) => 20000 + id * 2 + slot;
export const nodeUnit = (id: number, slot: number) => `hp-site-${id}-${slot}`;

export function sitePaths(id: number) {
  const root = join(config.sitesDir, String(id));
  return {
    root,
    releases: join(root, 'releases'),
    current: join(root, 'current'),
    shared: join(root, 'shared'),
    envFile: join(root, 'shared', '.env'),
    home: join(root, 'home'),
    tmp: join(root, 'tmp'),
  };
}

/** Writes a file outside the panel data dir (system config). In dev mode, only logs. */
export async function writeSystemFile(path: string, content: string, mode = 0o644) {
  if (config.dev) {
    console.log(`[dev] write ${path}\n${content}`);
    return;
  }
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, content, { mode });
  await rename(tmp, path);
}

export async function removeSystemFile(path: string) {
  if (config.dev) return;
  await rm(path, { force: true });
}

// --- site users and directories ------------------------------------------------------

export async function ensureSiteUser(id: number) {
  const user = siteUser(id);
  const exists = await tryExec('id', ['-u', user]);
  if (!exists.ok) {
    await exec('useradd', ['--system', '--user-group', '--home-dir', sitePaths(id).home, '--shell', '/usr/sbin/nologin', user]);
  }
}

export async function prepareSiteDirs(id: number) {
  const p = sitePaths(id);
  if (!config.dev) {
    for (const dir of [p.root, p.releases, p.shared, p.home, p.tmp]) await mkdir(dir, { recursive: true });
  }
  const user = siteUser(id);
  await exec('chown', ['-R', `${user}:${user}`, p.root]);
  await lockSiteRoot(id);
  // Caddy (web server) needs read access to serve static files; nobody else does.
  await exec('setfacl', ['-R', '-m', `u:${config.caddyUser}:rX`, p.root]);
  await exec('setfacl', ['-R', '-d', '-m', `u:${config.caddyUser}:rX`, p.root]);
}

/**
 * The site's top folder belongs to root (group = site user, 0750). OpenSSH requires that
 * for the SFTP chroot; the site user still reads it through the group and owns everything inside.
 */
export async function lockSiteRoot(id: number) {
  const root = sitePaths(id).root;
  await exec('chown', [`root:${siteUser(id)}`, root]);
  await exec('chmod', ['0750', root]);
}

export async function chownSite(id: number, path: string) {
  const user = siteUser(id);
  await exec('chown', ['-R', `${user}:${user}`, path]);
}

/** Atomically points `current` at the given directory (relative symlink + rename). */
export async function switchCurrent(id: number, target: string) {
  const p = sitePaths(id);
  if (config.dev) return;
  const tmpLink = `${p.current}.tmp-${Date.now()}`;
  await symlink(relative(p.root, target), tmpLink);
  await rename(tmpLink, p.current);
}

export async function currentTarget(id: number): Promise<string | null> {
  try {
    return await readlink(sitePaths(id).current);
  } catch {
    return null;
  }
}

/** Runs a shell command as the site's Linux user inside the given directory. */
export function runAsSite(id: number, command: string, cwd: string, env: Record<string, string>, opts: ExecOptions = {}) {
  const p = sitePaths(id);
  return exec('runuser', ['-u', siteUser(id), '--', 'sh', '-c', command], {
    ...opts,
    cwd,
    env: {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: p.home,
      npm_config_cache: join(p.home, '.npm'),
      CI: 'true',
      ...env,
    },
  });
}

// --- environment file ----------------------------------------------------------------

export function envFileContent(vars: Record<string, string>) {
  return (
    Object.entries(vars)
      .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
      .map(([k, v]) => `${k}="${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`)
      .join('\n') + '\n'
  );
}

export async function writeSiteEnv(site: SiteRow) {
  const p = sitePaths(site.id);
  const vars = JSON.parse(site.env) as Record<string, string>;
  if (config.dev) return;
  await mkdir(p.shared, { recursive: true });
  await writeFile(p.envFile, envFileContent(vars), { mode: 0o640 });
  await exec('chown', [`root:${siteUser(site.id)}`, p.envFile]);
}

// --- PHP-FPM pools -------------------------------------------------------------------

/** Per-site PHP settings (cPanel's MultiPHP INI Editor). */
export interface PhpSettings {
  memory_limit_mb: number;
  upload_max_mb: number;
  max_execution_time: number;
  max_input_vars: number;
  display_errors: boolean;
  timezone: string;
}

export const PHP_DEFAULTS: PhpSettings = {
  memory_limit_mb: 256,
  upload_max_mb: 64,
  max_execution_time: 60,
  max_input_vars: 3000,
  display_errors: false,
  timezone: 'Europe/Madrid',
};

export function phpSettings(site: Pick<SiteRow, 'php_settings'>): PhpSettings {
  let saved: Partial<PhpSettings> = {};
  try {
    saved = JSON.parse(site.php_settings || '{}') as Partial<PhpSettings>;
  } catch {
    /* keep defaults */
  }
  return { ...PHP_DEFAULTS, ...saved };
}

function phpPoolConfig(name: string, user: string, socket: string, root: string, tmp: string, env: Record<string, string>, ini: PhpSettings = PHP_DEFAULTS) {
  const envLines = Object.entries(env)
    .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
    .map(([k, v]) => `env[${k}] = "${String(v).replace(/"/g, '')}"`)
    .join('\n');
  return `; Generated by HostPanel. Do not edit.
[${name}]
user = ${user}
group = ${user}
listen = ${socket}
listen.owner = ${config.caddyUser}
listen.group = ${config.caddyUser}
listen.mode = 0660
pm = ondemand
pm.max_children = 10
pm.process_idle_timeout = 30s
pm.max_requests = 500
chdir = /
php_admin_value[open_basedir] = ${root}/:/tmp/:/usr/share/php/
php_admin_value[upload_tmp_dir] = ${tmp}
php_admin_value[session.save_path] = ${tmp}
php_admin_value[sys_temp_dir] = ${tmp}
php_admin_value[memory_limit] = ${ini.memory_limit_mb}M
php_admin_value[upload_max_filesize] = ${ini.upload_max_mb}M
php_admin_value[post_max_size] = ${ini.upload_max_mb + 8}M
php_value[max_execution_time] = ${ini.max_execution_time}
php_admin_value[max_input_vars] = ${ini.max_input_vars}
php_flag[display_errors] = ${ini.display_errors ? 'on' : 'off'}
php_admin_flag[log_errors] = on
php_admin_value[error_log] = ${tmp}/php-error.log
php_value[date.timezone] = ${ini.timezone.replace(/[^\w/+-]/g, '')}
php_admin_value[disable_functions] = exec,passthru,shell_exec,system,proc_open,popen,pcntl_exec
php_admin_flag[expose_php] = off
php_admin_flag[session.upload_progress.enabled] = off
${envLines}
`;
}

/** Pool file for a site: path, PHP version and content (also used for remote servers). */
export function sitePhpPool(site: SiteRow) {
  const p = sitePaths(site.id);
  const version = sitePhpVersion(site);
  const content = phpPoolConfig(
    `hp-${site.id}`,
    siteUser(site.id),
    phpSocket(site.id),
    p.root,
    p.tmp,
    JSON.parse(site.env) as Record<string, string>,
    phpSettings(site),
  );
  return { version, path: join(phpPoolDir(version), `hp-${site.id}.conf`), content };
}

/**
 * Writes the site's pool for its PHP version and removes it from any other version
 * (version switch). Returns the versions whose FPM must be reloaded.
 */
export async function writePhpPool(site: SiteRow): Promise<string[]> {
  const pool = sitePhpPool(site);
  const touched = [pool.version];
  for (const v of installedPhpVersions()) {
    if (v === pool.version) continue;
    const other = join(phpPoolDir(v), `hp-${site.id}.conf`);
    if (config.dev || existsSync(other)) {
      await removeSystemFile(other);
      if (!config.dev) touched.unshift(v); // reload the old version first so it frees the socket
    }
  }
  await writeSystemFile(pool.path, pool.content);
  return touched;
}

export async function removePhpPool(id: number) {
  for (const v of installedPhpVersions()) await removeSystemFile(join(phpPoolDir(v), `hp-${id}.conf`));
}

/** Last lines of a PHP site's error log (errors, warnings and fatal errors). */
export async function phpErrorLog(id: number, lines = 200): Promise<string> {
  if (config.dev) {
    return [
      `[02-Nov-2026 18:02:11 Europe/Madrid] PHP Warning:  Undefined array key "page" in ${sitePaths(id).root}/current/index.php on line 14`,
      `[02-Nov-2026 18:40:57 Europe/Madrid] PHP Fatal error:  Uncaught Error: Call to undefined function mysql_connect() in ${sitePaths(id).root}/current/db.php:3`,
    ].join('\n');
  }
  const out = await exec('tail', ['-n', String(lines), join(sitePaths(id).tmp, 'php-error.log')]).catch(() => '');
  return out.trim();
}

/** Graceful reload: running requests finish, opcache is cleared. */
export async function reloadPhp(versions: string[]) {
  for (const v of versions) await exec('systemctl', ['reload', phpService(v)]);
}

// --- systemd units for Node sites ----------------------------------------------------

function systemdQuote(cmd: string) {
  return `"${cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '$$$$').replace(/%/g, '%%')}"`;
}

/** `nodeBin` is the folder of the Node.js version the site runs (node, npm, npx). */
export function nodeUnitContent(site: SiteRow, slot: number, workdir: string, startCommand: string, nodeBin = '/usr/bin') {
  const p = sitePaths(site.id);
  return `# Generated by HostPanel. Do not edit.
[Unit]
Description=HostPanel site ${site.id} (${site.name.replace(/[\n\r]/g, ' ')}) slot ${slot}
After=network.target

[Service]
Type=simple
User=${siteUser(site.id)}
Group=${siteUser(site.id)}
WorkingDirectory=${workdir}
EnvironmentFile=-${p.envFile}
Environment=NODE_ENV=production
Environment=PORT=${nodePort(site.id, slot)}
Environment=HOST=127.0.0.1
Environment=HOME=${p.home}
Environment=PATH=${nodeBin}:/usr/local/bin:/usr/bin:/bin
ExecStart=/bin/sh -c ${systemdQuote(startCommand)}
Restart=always
RestartSec=3
MemoryMax=${site.memory_mb}M
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=${p.root}
PrivateTmp=yes
PrivateDevices=yes

[Install]
WantedBy=multi-user.target
`;
}

export async function writeNodeUnit(site: SiteRow, slot: number, workdir: string, startCommand: string, nodeBin?: string) {
  const unit = nodeUnitContent(site, slot, workdir, startCommand, nodeBin);
  await writeSystemFile(`/etc/systemd/system/${nodeUnit(site.id, slot)}.service`, unit);
  await exec('systemctl', ['daemon-reload']);
}

export async function restartUnit(name: string) {
  await exec('systemctl', ['enable', name]);
  await exec('systemctl', ['restart', name]);
}

export async function stopUnit(name: string) {
  await tryExec('systemctl', ['disable', '--now', name]);
}

export async function unitLogs(name: string, lines = 50) {
  const r = await tryExec('journalctl', ['-u', name, '-n', String(lines), '--no-pager', '-o', 'cat']);
  return r.output;
}

/** Removes everything a site owns on the system: units, pool, files and Linux user. */
export async function removeSiteSystem(id: number) {
  for (const slot of [0, 1]) {
    await stopUnit(nodeUnit(id, slot));
    await removeSystemFile(`/etc/systemd/system/${nodeUnit(id, slot)}.service`);
  }
  await tryExec('systemctl', ['daemon-reload']);
  await removePhpPool(id);
  for (const v of installedPhpVersions()) await tryExec('systemctl', ['reload', phpService(v)]);
  if (!config.dev) await rm(sitePaths(id).root, { recursive: true, force: true });
  await tryExec('userdel', [siteUser(id)]);
}

export async function removeReleaseDir(path: string) {
  if (config.dev || !existsSync(path)) return;
  await rm(path, { recursive: true, force: true });
}

export async function unlinkIfExists(path: string) {
  if (config.dev) return;
  await unlink(path).catch(() => {});
}

// --- server information --------------------------------------------------------------

export const MANAGED_SERVICES = ['hostpanel', 'caddy', 'pdns', 'stalwart', 'mariadb'] as const;

export async function servicesStatus() {
  const names = [...MANAGED_SERVICES, ...installedPhpVersions().map(phpService)];
  const result: { name: string; active: boolean; state: string }[] = [];
  for (const name of names) {
    if (config.dev) {
      result.push({ name, active: true, state: 'active' });
      continue;
    }
    const r = await tryExec('systemctl', ['is-active', name]);
    const state = r.output.trim() || 'unknown';
    result.push({ name, active: state === 'active', state });
  }
  return result;
}

export function systemInfo() {
  let disk = { total: 0, free: 0 };
  try {
    const s = statfsSync(config.dev ? '.' : '/');
    disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch {
    /* ignore */
  }
  return {
    hostname: osHostname(),
    uptime: uptime(),
    load: loadavg(),
    cpus: cpus().length,
    memory: { total: totalmem(), free: freemem() },
    disk,
    serverIp: config.serverIp,
  };
}
