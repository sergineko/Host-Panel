/**
 * One-click WordPress. Unlike repository sites, WordPress changes its own files (updates,
 * plugins, uploads), so it lives in one persistent folder instead of releases:
 *
 *   /srv/hostpanel/sites/<id>/wordpress   ← `current` points here
 *
 * It is installed with WP-CLI as the site's own Linux user, against a MariaDB database
 * created for it.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.ts';
import { get, type DatabaseRow, type SiteRow } from '../db.ts';
import { decrypt, randomPassword } from '../lib/crypto.ts';
import { exec } from '../lib/exec.ts';
import { sitePhpVersion } from './php.ts';
import { sq } from './servers.ts';
import { chownSite, runAsSite, sitePaths } from './system.ts';

export interface WordPressApp {
  database_id: number;
  db_name: string;
  title: string;
  admin_user: string;
  admin_email: string;
  locale: string;
}

export const WP_LOCALES = ['es_ES', 'en_US', 'ca', 'gl_ES', 'eu', 'pt_PT', 'pt_BR', 'fr_FR', 'it_IT', 'de_DE'] as const;

/** Paths WordPress must never serve (config, PHP inside uploads, debug log…). */
export const WP_BLOCKED_PATHS = ['/wp-config.php', '/wp-config-sample.php', '/wp-content/uploads/*.php', '/wp-content/debug.log', '/readme.html', '/license.txt', '/wp-admin/install.php'];

export const wpDir = (siteId: number) => join(sitePaths(siteId).root, 'wordpress');

/** Admin passwords chosen at creation, kept in memory only until the install finishes. */
const pendingPasswords = new Map<number, string>();
export const setPendingAdminPassword = (siteId: number, password: string) => pendingPasswords.set(siteId, password);

export const wpApp = (site: SiteRow) => JSON.parse(site.app || '{}') as WordPressApp;

type Log = (line: string) => void;

/** Runs WP-CLI as the site user with the site's PHP version. */
function wp(site: SiteRow, args: string[], log: Log, opts: { mask?: string[]; input?: string } = {}) {
  const php = `/usr/bin/php${sitePhpVersion(site)}`;
  const command = [php, '/usr/local/bin/wp', `--path=${sq(wpDir(site.id))}`, ...args.map(sq)].join(' ');
  log(`$ wp ${args.map((a) => (opts.mask?.some((m) => m && a.includes(m)) ? a.replace(/=.*/, '=****') : a)).join(' ')}`);
  return runAsSite(site.id, command, wpDir(site.id), {}, { onLine: log, mask: opts.mask, input: opts.input, timeoutMs: 10 * 60_000 });
}

export function isWordPressInstalled(site: SiteRow) {
  return config.dev ? !!site.active_release : existsSync(join(wpDir(site.id), 'wp-config.php'));
}

const EXTRA_PHP = `define( 'FS_METHOD', 'direct' );
define( 'WP_AUTO_UPDATE_CORE', 'minor' );
define( 'DISALLOW_FILE_EDIT', true );
define( 'WP_POST_REVISIONS', 20 );
`;

/** Downloads WordPress, creates wp-config.php and runs the installer. */
export async function installWordPress(site: SiteRow, log: Log) {
  const app = wpApp(site);
  const db = get<DatabaseRow>('SELECT * FROM databases WHERE id = ?', app.database_id);
  if (!db?.password_enc) throw new Error('No se encuentra la base de datos de este WordPress');
  const dbPassword = decrypt(db.password_enc);
  let adminPassword = pendingPasswords.get(site.id);
  if (!adminPassword) {
    // Panel restarted before the install: a new password is set; reset it from the site page.
    adminPassword = randomPassword(20);
    log('! La contraseña elegida se perdió (reinicio del panel). Usa «Restablecer contraseña» al terminar.');
  }
  const host = (JSON.parse(site.hostnames) as string[])[0]!;
  const dir = wpDir(site.id);

  log(`▶ Instalando WordPress (${app.locale}) en https://${host}`);
  await exec('mkdir', ['-p', dir]);
  await chownSite(site.id, dir);
  await wp(site, ['core', 'download', `--locale=${app.locale}`], log);
  await wp(
    site,
    ['config', 'create', `--dbname=${db.name}`, `--dbuser=${db.username}`, `--dbpass=${dbPassword}`, '--dbhost=localhost', '--dbcharset=utf8mb4', `--locale=${app.locale}`, '--extra-php'],
    log,
    { mask: [dbPassword], input: EXTRA_PHP },
  );
  await wp(
    site,
    ['core', 'install', `--url=https://${host}`, `--title=${app.title}`, `--admin_user=${app.admin_user}`, `--admin_password=${adminPassword}`, `--admin_email=${app.admin_email}`, '--skip-email'],
    log,
    { mask: [adminPassword] },
  );
  await wp(site, ['rewrite', 'structure', '/%postname%/'], log);
  await wp(site, ['plugin', 'delete', 'hello'], log).catch(() => {});
  if (!config.dev) await exec('chmod', ['0640', join(dir, 'wp-config.php')]);
  pendingPasswords.delete(site.id);
  log('✔ WordPress instalado');
}

export async function resetWordPressPassword(site: SiteRow): Promise<string> {
  const password = randomPassword(20);
  const lines: string[] = [];
  try {
    await wp(site, ['user', 'update', wpApp(site).admin_user, `--user_pass=${password}`, '--skip-email'], (l) => lines.push(l), { mask: [password] });
  } catch (err) {
    throw new Error(`No se pudo cambiar la contraseña: ${lines.slice(-3).join(' ') || (err as Error).message}`);
  }
  return password;
}
