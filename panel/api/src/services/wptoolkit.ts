/**
 * WordPress toolkit (like cPanel's WP Toolkit) for one-click WordPress sites:
 * versions and updates (with a backup first), plugins and themes, maintenance mode,
 * debug log, staging clones and minor auto-updates. Everything runs through WP-CLI
 * as the site's own Linux user.
 *
 * Toolkit settings live in the site's `app` JSON (see WordPressApp), so no extra tables.
 * In dev mode a believable in-memory WordPress is used instead of WP-CLI.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.ts';
import { all, get, run, type BackupRow, type DatabaseRow, type SiteRow } from '../db.ts';
import { decrypt, encrypt, randomPassword, randomToken } from '../lib/crypto.ts';
import { exec } from '../lib/exec.ts';
import { badRequest, matchDomain } from '../lib/validate.ts';
import { createBackup, deleteBackup } from './backups.ts';
import { createDatabase, exportDatabase, importDatabase } from './databases.ts';
import { enqueueDeploy } from './deploy.ts';
import type { JobLog } from './jobs.ts';
import { sitePhpVersion } from './php.ts';
import { sq } from './servers.ts';
import { chownSite, ensureSiteUser, prepareSiteDirs, runAsSite } from './system.ts';
import { wpApp, wpDir, type WordPressApp } from './wordpress.ts';

export interface WpItem {
  name: string;
  title: string;
  status: string;
  version: string;
  update_version: string | null;
  auto_update: boolean;
}

export interface WpToolkitSettings {
  /** Panel applies minor core updates (6.6.1 → 6.6.2) once a day, backup first. */
  core_minor: boolean;
  /** Panel applies minor plugin updates (2.3.1 → 2.3.4) once a day, backup first. */
  plugins_minor: boolean;
}

export interface WpStatus {
  installed: boolean;
  core: { version: string; update_version: string | null; update_type: 'major' | 'minor' | null };
  plugins: WpItem[];
  themes: WpItem[];
  maintenance: boolean;
  debug_log: boolean;
  debug_log_size: number;
  auto_update: WpToolkitSettings & { last_run: string | null };
  staging: { id: number; name: string; url: string; status: string } | null;
  staging_of: { id: number; name: string; url: string } | null;
}

/** Extra fields kept in `sites.app` for the toolkit. */
type ToolkitApp = WordPressApp & {
  auto_update?: WpToolkitSettings;
  auto_update_last?: string;
  staging_id?: number;
  staging_of?: number;
};

const NAME_RE = /^[A-Za-z0-9._-]{1,200}$/;
export const assertSlug = (name: string) => {
  if (!NAME_RE.test(name)) throw badRequest('Nombre de plugin o tema no válido');
  return name;
};

const toolkitApp = (site: SiteRow) => wpApp(site) as ToolkitApp;
function saveApp(siteId: number, patch: Partial<ToolkitApp>) {
  const site = get<SiteRow>('SELECT * FROM sites WHERE id = ?', siteId);
  if (!site) return;
  run('UPDATE sites SET app = ? WHERE id = ?', JSON.stringify({ ...toolkitApp(site), ...patch }), siteId);
}

export const siteUrl = (site: SiteRow) => `https://${(JSON.parse(site.hostnames) as string[])[0]}`;

// --- WP-CLI --------------------------------------------------------------------------------

function wpCommand(site: SiteRow, args: string[]) {
  return [`/usr/bin/php${sitePhpVersion(site)}`, '/usr/local/bin/wp', `--path=${sq(wpDir(site.id))}`, ...args.map(sq)].join(' ');
}

/** Runs WP-CLI as the site user, logging the command and its output. */
export function wp(site: SiteRow, args: string[], log: JobLog, mask: string[] = []) {
  log(`$ wp ${args.map((a) => (mask.some((m) => m && a.includes(m)) ? a.replace(/=.*/, '=****') : a)).join(' ')}`);
  return runAsSite(site.id, wpCommand(site, args), wpDir(site.id), {}, { onLine: log, mask, timeoutMs: 20 * 60_000 });
}

/** Runs a read-only WP-CLI command and parses its JSON output (warnings on stderr are dropped). */
async function wpJson<T>(site: SiteRow, args: string[]): Promise<T> {
  const out = await runAsSite(site.id, `${wpCommand(site, [...args, '--format=json'])} 2>/dev/null`, wpDir(site.id), {}, { timeoutMs: 2 * 60_000 });
  const start = out.search(/[[{]/);
  return JSON.parse(start === -1 ? '[]' : out.slice(start)) as T;
}

async function wpValue(site: SiteRow, args: string[]): Promise<string | null> {
  try {
    return (await runAsSite(site.id, `${wpCommand(site, args)} 2>/dev/null`, wpDir(site.id), {}, { timeoutMs: 60_000 })).trim();
  } catch {
    return null;
  }
}

const truthy = (v: string | null) => v !== null && ['1', 'true'].includes(v.toLowerCase());

// --- dev mode: a believable WordPress kept in memory ---------------------------------------

interface DevWp {
  core: WpStatus['core'];
  plugins: WpItem[];
  themes: WpItem[];
  maintenance: boolean;
  debug_log: boolean;
}
const devState = new Map<number, DevWp>();

function devWp(siteId: number): DevWp {
  let s = devState.get(siteId);
  if (!s) {
    const p = (name: string, title: string, status: string, version: string, update: string | null, auto = false): WpItem => ({ name, title, status, version, update_version: update, auto_update: auto });
    s = {
      core: { version: '6.6.1', update_version: '6.6.2', update_type: 'minor' },
      plugins: [
        p('akismet', 'Akismet Anti-spam: Spam Protection', 'active', '5.3.3', '5.3.5'),
        p('wordpress-seo', 'Yoast SEO', 'active', '23.4', '23.8'),
        p('woocommerce', 'WooCommerce', 'active', '9.3.1', '9.4.0'),
        p('contact-form-7', 'Contact Form 7', 'active', '5.9.8', null, true),
        p('wp-super-cache', 'WP Super Cache', 'inactive', '1.12.4', null),
        p('classic-editor', 'Classic Editor', 'inactive', '1.6.4', '1.6.5'),
      ],
      themes: [
        p('twentytwentyfour', 'Twenty Twenty-Four', 'active', '1.2', '1.3'),
        p('twentytwentythree', 'Twenty Twenty-Three', 'inactive', '1.5', null),
        p('astra', 'Astra', 'inactive', '4.8.1', '4.8.3'),
      ],
      maintenance: false,
      debug_log: false,
    };
    devState.set(siteId, s);
  }
  return s;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isMinorBump = (from: string, to: string) => from.split('.').slice(0, 2).join('.') === to.split('.').slice(0, 2).join('.');

// --- status --------------------------------------------------------------------------------

function siteRef(id: number | undefined) {
  if (!id) return null;
  return get<SiteRow>('SELECT * FROM sites WHERE id = ?', id) ?? null;
}

const debugLogPath = (site: SiteRow) => join(wpDir(site.id), 'wp-content', 'debug.log');

export async function wpStatus(site: SiteRow): Promise<WpStatus> {
  const app = toolkitApp(site);
  const staging = siteRef(app.staging_id);
  const stagingOf = siteRef(app.staging_of);
  const base = {
    auto_update: { core_minor: app.auto_update?.core_minor ?? true, plugins_minor: app.auto_update?.plugins_minor ?? false, last_run: app.auto_update_last ?? null },
    staging: staging ? { id: staging.id, name: staging.name, url: siteUrl(staging), status: staging.status } : null,
    staging_of: stagingOf ? { id: stagingOf.id, name: stagingOf.name, url: siteUrl(stagingOf) } : null,
  };
  const installed = config.dev ? !!site.active_release : existsSync(join(wpDir(site.id), 'wp-config.php'));
  if (!installed) {
    return { installed, core: { version: '', update_version: null, update_type: null }, plugins: [], themes: [], maintenance: false, debug_log: false, debug_log_size: 0, ...base };
  }
  if (config.dev) {
    const s = devWp(site.id);
    return { installed, core: { ...s.core }, plugins: s.plugins.map((p) => ({ ...p })), themes: s.themes.map((t) => ({ ...t })), maintenance: s.maintenance, debug_log: s.debug_log, debug_log_size: s.debug_log ? 48_213 : 0, ...base };
  }

  type Raw = { name: string; title?: string; status: string; version: string; update: string; update_version?: string; auto_update?: string };
  const fields = '--fields=name,title,status,version,update,update_version,auto_update';
  const [version, coreUpdates, plugins, themes, debugLog] = await Promise.all([
    wpValue(site, ['core', 'version']),
    wpJson<{ version: string; update_type: 'major' | 'minor' }[]>(site, ['core', 'check-update']).catch(() => []),
    wpJson<Raw[]>(site, ['plugin', 'list', fields]).catch(() => []),
    wpJson<Raw[]>(site, ['theme', 'list', fields]).catch(() => []),
    wpValue(site, ['config', 'get', 'WP_DEBUG_LOG', '--type=constant']),
  ]);
  const toItem = (r: Raw): WpItem => ({
    name: r.name,
    title: r.title || r.name,
    status: r.status,
    version: r.version,
    update_version: r.update === 'available' ? (r.update_version ?? null) : null,
    auto_update: r.auto_update === 'on',
  });
  const next = coreUpdates[0];
  const logFile = debugLogPath(site);
  return {
    installed,
    core: { version: version ?? '', update_version: next?.version ?? null, update_type: next?.update_type ?? null },
    // Must-use and drop-in plugins can't be managed from here.
    plugins: plugins.filter((p) => p.status === 'active' || p.status === 'inactive' || p.status === 'active-network').map(toItem),
    themes: themes.map(toItem),
    maintenance: existsSync(join(wpDir(site.id), '.maintenance')),
    debug_log: truthy(debugLog),
    debug_log_size: existsSync(logFile) ? statSync(logFile).size : 0,
    ...base,
  };
}

export function readDebugLog(site: SiteRow, lines = 300): string {
  if (config.dev) {
    if (!devWp(site.id).debug_log) return '';
    return [
      '[02-Nov-2026 09:14:02 UTC] PHP Deprecated:  Creation of dynamic property WC_Product::$meta is deprecated in /wp-content/plugins/woocommerce/includes/abstracts/abstract-wc-product.php on line 92',
      "[02-Nov-2026 09:14:05 UTC] PHP Warning:  Undefined array key \"utm_source\" in /wp-content/themes/twentytwentyfour/functions.php on line 214",
      '[02-Nov-2026 09:20:41 UTC] PHP Notice:  Function _load_textdomain_just_in_time was called incorrectly. Translation loading for the wordpress-seo domain was triggered too early.',
      '[02-Nov-2026 09:31:18 UTC] PHP Fatal error:  Uncaught Error: Call to undefined function mi_funcion() in /wp-content/plugins/mi-plugin/mi-plugin.php:33',
    ].join('\n');
  }
  const file = debugLogPath(site);
  if (!existsSync(file)) return '';
  const text = readFileSync(file, 'utf8');
  return text.split('\n').slice(-lines).join('\n');
}

export async function clearDebugLog(site: SiteRow) {
  if (config.dev) return;
  const file = debugLogPath(site);
  if (existsSync(file)) await runAsSite(site.id, `: > ${sq(file)}`, wpDir(site.id), {});
}

// --- updates -------------------------------------------------------------------------------

export interface UpdateRequest {
  core: boolean;
  /** Plugin slugs, or 'all'. */
  plugins: string[] | 'all';
  themes: string[] | 'all';
  /** Only minor/patch releases (used by auto-updates). */
  minor?: boolean;
}

/** Keeps the newest few pre-update backups of a site. */
function prunePreUpdate(site: SiteRow, keep = 5) {
  const rows = all<BackupRow>("SELECT * FROM backups WHERE site_id = ? AND kind = 'pre-update' AND status = 'success' ORDER BY id DESC", site.id);
  for (const b of rows.slice(keep)) deleteBackup(b);
}

export async function runUpdates(site: SiteRow, req: UpdateRequest, log: JobLog, note = 'Antes de actualizar WordPress') {
  log('▶ Creando una copia de seguridad antes de actualizar…');
  await createBackup(site, 'pre-update', log, note);
  prunePreUpdate(site);

  if (config.dev) {
    const s = devWp(site.id);
    const bump = <T extends { version: string; update_version: string | null }>(x: T) => {
      if (!x.update_version || (req.minor && !isMinorBump(x.version, x.update_version))) return false;
      x.version = x.update_version;
      x.update_version = null;
      return true;
    };
    if (req.core) {
      log(`$ wp core update${req.minor ? ' --minor' : ''}`);
      await pause(700);
      const from = s.core.version;
      if (bump(s.core)) {
        s.core.update_type = null;
        log(`Actualizando de ${from} a ${s.core.version}…`);
        log('$ wp core update-db');
        log('Success: WordPress database upgraded successfully.');
      } else log('Success: WordPress is up to date.');
    }
    for (const [kind, list, wanted] of [['plugin', s.plugins, req.plugins], ['theme', s.themes, req.themes]] as const) {
      const targets = list.filter((x) => (wanted === 'all' ? true : wanted.includes(x.name)) && x.update_version);
      if (!targets.length) continue;
      log(`$ wp ${kind} update ${wanted === 'all' ? '--all' : targets.map((t) => t.name).join(' ')}${req.minor ? ' --minor' : ''}`);
      for (const t of targets) {
        await pause(400);
        const from = t.version;
        if (bump(t)) log(`Actualizado ${t.name}: ${from} → ${t.version}`);
        else log(`${t.name}: sin versión menor disponible, se omite`);
      }
    }
    log('✔ WordPress actualizado');
    return;
  }

  const minor = req.minor ? ['--minor'] : [];
  if (req.core) {
    await wp(site, ['core', 'update', ...minor], log);
    await wp(site, ['core', 'update-db'], log);
  }
  for (const [kind, wanted] of [['plugin', req.plugins], ['theme', req.themes]] as const) {
    if (wanted === 'all') await wp(site, [kind, 'update', '--all', ...minor], log);
    else if (wanted.length) await wp(site, [kind, 'update', ...wanted.map(assertSlug), ...minor], log);
  }
  await wp(site, ['cache', 'flush'], log).catch(() => {});
  log('✔ WordPress actualizado');
}

// --- plugins and themes --------------------------------------------------------------------

export type ItemAction = 'activate' | 'deactivate' | 'delete';

export async function itemAction(site: SiteRow, kind: 'plugin' | 'theme', name: string, action: ItemAction) {
  assertSlug(name);
  if (kind === 'theme' && action === 'deactivate') throw badRequest('Para cambiar de tema, activa otro');
  if (config.dev) {
    const s = devWp(site.id);
    const list = kind === 'plugin' ? s.plugins : s.themes;
    const item = list.find((x) => x.name === name);
    if (!item) throw badRequest(`No existe ${name}`);
    if (kind === 'theme' && action === 'delete' && item.status === 'active') throw badRequest('No se puede eliminar el tema activo');
    if (action === 'delete') list.splice(list.indexOf(item), 1);
    else if (kind === 'theme') for (const t of list) t.status = t === item ? 'active' : 'inactive';
    else item.status = action === 'activate' ? 'active' : 'inactive';
    return;
  }
  const lines: string[] = [];
  const log = (l: string) => lines.push(l);
  try {
    if (kind === 'plugin' && action === 'delete') await wp(site, ['plugin', 'deactivate', name], log).catch(() => {});
    await wp(site, [kind, action, name], log);
  } catch {
    throw badRequest(lines.filter((l) => !l.startsWith('$')).slice(-3).join(' ') || `No se pudo completar la acción sobre ${name}`);
  }
}

// --- maintenance, debug and auto-update settings -------------------------------------------

export async function setMaintenance(site: SiteRow, on: boolean) {
  if (config.dev) {
    devWp(site.id).maintenance = on;
    return;
  }
  await wp(site, ['maintenance-mode', on ? 'activate' : 'deactivate'], () => {}).catch((err: Error) => {
    // Already in the requested state: WP-CLI exits with an error, nothing to do.
    if (existsSync(join(wpDir(site.id), '.maintenance')) !== on) throw err;
  });
}

export async function setDebugLog(site: SiteRow, on: boolean) {
  if (config.dev) {
    devWp(site.id).debug_log = on;
    return;
  }
  const v = on ? 'true' : 'false';
  // The log is written to wp-content/debug.log (Caddy blocks it from the web) and never shown to visitors.
  for (const [name, value] of [['WP_DEBUG', v], ['WP_DEBUG_LOG', v], ['WP_DEBUG_DISPLAY', 'false']] as const) {
    await wp(site, ['config', 'set', name, value, '--raw', '--type=constant'], () => {});
  }
}

export async function setAutoUpdate(site: SiteRow, settings: WpToolkitSettings) {
  saveApp(site.id, { auto_update: settings });
  if (config.dev) return;
  // The panel does the updates (with a backup first), so WordPress's own core updater is turned off.
  await wp(site, ['config', 'set', 'WP_AUTO_UPDATE_CORE', settings.core_minor ? "'minor'" : 'false', '--raw', '--type=constant'], () => {}).catch(() => {});
}

/** Once a day, applies minor core/plugin updates where enabled (only backs up if there is something to update). */
export function startWpAutoUpdates() {
  if (config.dev) return;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      for (const site of all<SiteRow>("SELECT * FROM sites WHERE source = 'wordpress' AND active_release != ''")) {
        const app = toolkitApp(site);
        const s = { core_minor: app.auto_update?.core_minor ?? true, plugins_minor: app.auto_update?.plugins_minor ?? false };
        if (!s.core_minor && !s.plugins_minor) continue;
        if (app.auto_update_last && Date.now() - Date.parse(app.auto_update_last) < 23 * 3600_000) continue;
        try {
          const status = await wpStatus(site);
          const core = s.core_minor && status.core.update_type === 'minor';
          const plugins = s.plugins_minor ? status.plugins.filter((p) => p.update_version && isMinorBump(p.version, p.update_version)).map((p) => p.name) : [];
          if (core || plugins.length) {
            await runUpdates(site, { core, plugins, themes: [], minor: true }, () => {}, 'Antes de la actualización automática');
          }
        } catch (err) {
          console.error(`Actualización automática de WordPress (sitio ${site.id}): ${(err as Error).message}`);
        }
        saveApp(site.id, { auto_update_last: new Date().toISOString() });
      }
    } finally {
      busy = false;
    }
  };
  setTimeout(() => void tick(), 5 * 60_000);
  return setInterval(() => void tick(), 60 * 60_000);
}

// --- staging -------------------------------------------------------------------------------

export function hostsInUse(hosts: string[]) {
  for (const s of all<SiteRow>('SELECT id, name, hostnames FROM sites')) {
    const clash = hosts.find((h) => (JSON.parse(s.hostnames) as string[]).includes(h));
    if (clash) throw badRequest(`${clash} ya lo usa el sitio "${s.name}"`);
  }
  if (config.panelDomain && hosts.includes(config.panelDomain)) throw badRequest('Ese hostname lo usa el panel');
  if (config.mailHostname && hosts.includes(config.mailHostname)) throw badRequest('Ese hostname lo usa el webmail');
}

function freeDbName(siteId: number) {
  let name = `wp_${siteId}`;
  for (let i = 2; get('SELECT 1 FROM databases WHERE name = ? OR username = ?', name, name); i++) name = `wp_${siteId}_${i}`;
  return name;
}

const dbOf = (site: SiteRow) => {
  const db = get<DatabaseRow>('SELECT * FROM databases WHERE id = ?', wpApp(site).database_id);
  if (!db) throw new Error(`No se encuentra la base de datos de ${site.name}`);
  return db;
};

/** Rewrites URLs in the database (serialized data is handled by WP-CLI). */
async function searchReplace(site: SiteRow, from: string, to: string, log: JobLog) {
  if (config.dev) {
    log(`$ wp search-replace ${from} ${to} --all-tables-with-prefix --skip-columns=guid --report-changed-only`);
    await pause(500);
    log(`Success: Made ${180 + Math.floor(Math.random() * 400)} replacements.`);
    return;
  }
  await wp(site, ['search-replace', from, to, '--all-tables-with-prefix', '--skip-columns=guid', '--report-changed-only'], log);
}

/**
 * Creates the staging site row and its database. Returns the new site id; the copy itself
 * runs in `cloneToStaging` as a job.
 */
export async function createStagingSite(live: SiteRow, host: string): Promise<number> {
  const app = toolkitApp(live);
  if (app.staging_of) throw badRequest('Este sitio ya es un staging: crea el staging desde el sitio en producción');
  if (siteRef(app.staging_id)) throw badRequest('Este WordPress ya tiene un staging');
  hostsInUse([host]);
  const domain = matchDomain(host, all<{ id: number; name: string }>('SELECT id, name FROM domains'));
  const { id } = run(
    `INSERT INTO sites (name, domain_id, hostnames, type, webhook_secret, auto_deploy, php_version, php_settings, source)
     VALUES (?, ?, ?, 'php', ?, 0, ?, ?, 'wordpress')`,
    `${live.name} (staging)`,
    domain?.id ?? null,
    JSON.stringify([host]),
    randomToken(24),
    live.php_version,
    live.php_settings,
  );
  const dbName = freeDbName(id);
  const dbPassword = randomPassword(24);
  try {
    await createDatabase(dbName, dbName, dbPassword);
  } catch (err) {
    run('DELETE FROM sites WHERE id = ?', id);
    throw err;
  }
  const dbId = run('INSERT INTO databases (name, username, note, password_enc) VALUES (?, ?, ?, ?)', dbName, dbName, `WordPress staging: ${live.name}`, encrypt(dbPassword)).id;
  const stagingApp: ToolkitApp = { ...app, database_id: dbId, db_name: dbName, title: `${app.title} (staging)`, staging_of: live.id, auto_update: { core_minor: false, plugins_minor: false } };
  delete stagingApp.staging_id;
  delete stagingApp.auto_update_last;
  run('UPDATE sites SET app = ? WHERE id = ?', JSON.stringify(stagingApp), id);
  saveApp(live.id, { staging_id: id });
  return id;
}

/** Copies files and database from live to staging, rewrites URLs and publishes the staging site. */
export async function cloneToStaging(live: SiteRow, staging: SiteRow, log: JobLog) {
  const from = wpDir(live.id);
  const to = wpDir(staging.id);
  log(`▶ Clonando ${siteUrl(live)} → ${siteUrl(staging)}`);
  await ensureSiteUser(staging.id);
  await prepareSiteDirs(staging.id);
  log('Copiando los archivos de WordPress…');
  await exec('rm', ['-rf', to], { onLine: log });
  await exec('cp', ['-a', from, to], { onLine: log, timeoutMs: 60 * 60_000 });
  await exec('rm', ['-f', join(to, '.maintenance')], { onLine: log });
  await chownSite(staging.id, to);

  const stagingDb = dbOf(staging);
  await copyDatabaseStream(dbOf(live), stagingDb, log);

  if (!config.dev) {
    const pass = decrypt(stagingDb.password_enc);
    await wp(staging, ['config', 'set', 'DB_NAME', stagingDb.name], log);
    await wp(staging, ['config', 'set', 'DB_USER', stagingDb.username], log);
    await wp(staging, ['config', 'set', 'DB_PASSWORD', pass], log, [pass]);
    await exec('chmod', ['0640', join(to, 'wp-config.php')]);
  } else log('$ wp config set DB_NAME / DB_USER / DB_PASSWORD (base de datos del staging)');

  await searchReplace(staging, siteUrl(live), siteUrl(staging), log);
  if (!config.dev) {
    // Staging must not be indexed by search engines nor send automatic updates.
    await wp(staging, ['option', 'update', 'blog_public', '0'], log);
    await wp(staging, ['config', 'set', 'WP_AUTO_UPDATE_CORE', 'false', '--raw', '--type=constant'], log).catch(() => {});
    await wp(staging, ['cache', 'flush'], log).catch(() => {});
  } else {
    log('$ wp option update blog_public 0');
    devState.set(staging.id, { ...structuredClone(devWp(live.id)), maintenance: false });
    // In dev mode "installed" is tracked by active_release.
    run("UPDATE sites SET active_release = 'wordpress' WHERE id = ?", staging.id);
  }
  const deploymentId = enqueueDeploy(staging.id, 'clon de staging');
  log(`✔ Staging listo. Publicando en ${siteUrl(staging)} (despliegue #${deploymentId}).`);
}

async function copyDatabaseStream(from: DatabaseRow, to: DatabaseRow, log: JobLog) {
  log(`Copiando la base de datos ${from.name} → ${to.name}…`);
  await importDatabase(to, exportDatabase(from.name));
}

/** Publishes the staging copy over the live site, after a backup of the live site. */
export async function pushStagingToLive(live: SiteRow, staging: SiteRow, parts: { files: boolean; database: boolean }, log: JobLog) {
  log(`▶ Publicando ${siteUrl(staging)} en ${siteUrl(live)}`);
  log('Creando una copia de seguridad de producción por si necesitas deshacer…');
  await createBackup(live, 'pre-update', log, 'Antes de publicar el staging');
  prunePreUpdate(live);

  const liveBlogPublic = config.dev ? '1' : ((await wpValue(live, ['option', 'get', 'blog_public'])) ?? '1');
  if (parts.files) {
    log('Sincronizando los archivos (wp-config.php de producción se conserva)…');
    await exec(
      'rsync',
      ['-a', '--delete', '--exclude=/wp-config.php', '--exclude=/.maintenance', '--exclude=/wp-content/debug.log', '--exclude=/wp-content/cache/', `${wpDir(staging.id)}/`, `${wpDir(live.id)}/`],
      { onLine: log, timeoutMs: 60 * 60_000 },
    );
    await chownSite(live.id, wpDir(live.id));
  }
  if (parts.database) {
    await copyDatabaseStream(dbOf(staging), dbOf(live), log);
    await searchReplace(live, siteUrl(staging), siteUrl(live), log);
    if (!config.dev) {
      await wp(live, ['option', 'update', 'blog_public', liveBlogPublic], log);
    } else log(`$ wp option update blog_public ${liveBlogPublic}`);
  }
  if (config.dev) {
    devState.set(live.id, { ...structuredClone(devWp(staging.id)), maintenance: devWp(live.id).maintenance });
  } else {
    await wp(live, ['cache', 'flush'], log).catch(() => {});
  }
  log('✔ Staging publicado en producción');
}

/** Staging/live pair for a site (either side). */
export function stagingPair(site: SiteRow): { live: SiteRow; staging: SiteRow } | null {
  const app = toolkitApp(site);
  if (app.staging_of) {
    const live = siteRef(app.staging_of);
    return live ? { live, staging: site } : null;
  }
  const staging = siteRef(app.staging_id);
  return staging ? { live: site, staging } : null;
}

/** When a site is deleted, unlink it from its staging pair. */
export function forgetStaging(site: SiteRow) {
  const app = toolkitApp(site);
  if (app.staging_of) {
    const live = siteRef(app.staging_of);
    if (live) {
      const { staging_id: _s, ...rest } = toolkitApp(live);
      run('UPDATE sites SET app = ? WHERE id = ?', JSON.stringify(rest), live.id);
    }
  }
  devState.delete(site.id);
}
