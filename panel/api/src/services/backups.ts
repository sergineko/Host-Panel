/**
 * Site backups (like cPanel's Backup / JetBackup): files, the persistent "shared" folder
 * and SQL databases, made on demand or on a schedule, downloadable and restorable.
 *
 * A backup is a folder <dataDir>/backups/site-<id>/<stamp>/ with:
 *   manifest.json   what it contains
 *   files.tar.gz    the live release (or the WordPress folder); .git and caches excluded
 *   shared.tar.gz   persistent files outside the releases (not for WordPress)
 *   db-<name>.sql.gz one per database
 */
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGzip, createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { config } from '../config.ts';
import { all, get, run, type BackupRow, type DatabaseRow, type SiteRow } from '../db.ts';
import { exec } from '../lib/exec.ts';
import { HttpError } from '../lib/validate.ts';
import { exportDatabase, importDatabase } from './databases.ts';
import { enqueueDeploy } from './deploy.ts';
import type { JobLog } from './jobs.ts';
import { chownSite, sitePaths } from './system.ts';
import { wpApp, wpDir } from './wordpress.ts';

export const backupsRoot = () => join(config.dataDir, 'backups');
export const siteBackupDir = (siteId: number) => join(backupsRoot(), `site-${siteId}`);

const EXCLUDES = ['./.git', './node_modules/.cache', './.next/cache', './wp-content/cache'];

export interface BackupManifest {
  version: 1;
  site: { id: number; name: string; type: string; source: string };
  release: string;
  created_at: string;
  parts: { files: boolean; shared: boolean; databases: string[] };
}

/** Databases saved with a site: its WordPress database plus the ones chosen in its settings. */
export function backupDatabases(site: SiteRow): DatabaseRow[] {
  const ids = new Set<number>(JSON.parse(site.backup_databases || '[]') as number[]);
  if (site.source === 'wordpress') {
    const wp = wpApp(site);
    if (wp.database_id) ids.add(wp.database_id);
  }
  if (!ids.size) return [];
  return all<DatabaseRow>(`SELECT * FROM databases WHERE id IN (${[...ids].map(() => '?').join(',')})`, ...ids);
}

function filesDir(site: SiteRow): string | null {
  if (site.source === 'wordpress') return wpDir(site.id);
  return site.active_release ? join(sitePaths(site.id).releases, site.active_release) : null;
}

const stampNow = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

async function tarDir(src: string, out: string) {
  await exec('tar', ['-czf', out, ...EXCLUDES.map((e) => `--exclude=${e}`), '-C', src, '.'], { timeoutMs: 60 * 60_000 });
}

async function dumpDatabase(name: string, out: string) {
  await pipeline(exportDatabase(name), createGzip(), createWriteStream(out));
}

function folderBytes(dir: string) {
  let total = 0;
  for (const f of existsSync(dir) ? readdirSync(dir) : []) total += statSync(join(dir, f)).size;
  return total;
}

/** Creates a backup now. Returns its row once finished (throws on failure; the row says why). */
export async function createBackup(site: SiteRow, kind: BackupRow['kind'], log: JobLog = () => {}, note = ''): Promise<BackupRow> {
  const stamp = stampNow();
  const dir = join(siteBackupDir(site.id), stamp);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dbs = backupDatabases(site);
  const files = filesDir(site);
  const shared = site.source === 'wordpress' ? null : sitePaths(site.id).shared;
  const manifest: BackupManifest = {
    version: 1,
    site: { id: site.id, name: site.name, type: site.type, source: site.source },
    release: site.active_release,
    created_at: new Date().toISOString(),
    parts: { files: !!files, shared: !!shared, databases: dbs.map((d) => d.name) },
  };
  const includes = [...(files ? ['files'] : []), ...(shared ? ['shared'] : []), ...dbs.map((d) => `db:${d.name}`)];
  const { id } = run('INSERT INTO backups (site_id, file, kind, includes, note) VALUES (?, ?, ?, ?, ?)', site.id, stamp, kind, JSON.stringify(includes), note);
  try {
    if (files) {
      log(`Comprimiendo archivos del sitio…`);
      if (config.dev) writeFileSync(join(dir, 'files.tar.gz'), Buffer.alloc(180_000));
      else await tarDir(files, join(dir, 'files.tar.gz'));
    }
    if (shared && (config.dev || existsSync(shared))) {
      log('Comprimiendo la carpeta compartida…');
      if (config.dev) writeFileSync(join(dir, 'shared.tar.gz'), Buffer.alloc(12_000));
      else await tarDir(shared, join(dir, 'shared.tar.gz'));
    }
    for (const db of dbs) {
      log(`Volcando la base de datos ${db.name}…`);
      await dumpDatabase(db.name, join(dir, `db-${db.name}.sql.gz`));
    }
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    const size = folderBytes(dir);
    run("UPDATE backups SET status = 'success', size = ?, finished_at = datetime('now') WHERE id = ?", size, id);
    log(`✔ Copia creada (${(size / 1024 / 1024).toFixed(1)} MB)`);
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    run("UPDATE backups SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ?", (err as Error).message.slice(0, 1000), id);
    throw err;
  }
  return get<BackupRow>('SELECT * FROM backups WHERE id = ?', id)!;
}

export function deleteBackup(b: BackupRow) {
  rmSync(join(siteBackupDir(b.site_id), b.file), { recursive: true, force: true });
  run('DELETE FROM backups WHERE id = ?', b.id);
}

/** Keeps only the newest N automatic backups of a site. */
export function pruneBackups(site: SiteRow) {
  const autos = all<BackupRow>("SELECT * FROM backups WHERE site_id = ? AND kind = 'auto' AND status = 'success' ORDER BY id DESC", site.id);
  for (const b of autos.slice(Math.max(1, site.backup_keep))) deleteBackup(b);
}

export function removeSiteBackups(siteId: number) {
  rmSync(siteBackupDir(siteId), { recursive: true, force: true });
}

/** Streams a backup folder as one .tar (its parts are already compressed). */
export function backupArchive(b: BackupRow) {
  const dir = join(siteBackupDir(b.site_id), b.file);
  if (!existsSync(dir)) throw new HttpError(404, 'Los archivos de esta copia ya no existen');
  if (config.dev) return createReadStream(join(dir, 'manifest.json'));
  return spawn('tar', ['-cf', '-', '-C', dir, '.'], { stdio: ['ignore', 'pipe', 'ignore'] }).stdout;
}

/**
 * Restores a backup: makes a safety copy first, then puts back the databases, the shared
 * folder and the files. Non-WordPress files become a new release that is published with
 * the normal deploy flow (PHP reload, Node restart, remote servers…).
 */
export async function restoreBackup(site: SiteRow, b: BackupRow, parts: { files: boolean; databases: boolean }, log: JobLog) {
  const dir = join(siteBackupDir(b.site_id), b.file);
  if (!existsSync(dir)) throw new Error('Los archivos de esta copia ya no existen');
  log('Creando una copia de seguridad del estado actual por si necesitas deshacer…');
  await createBackup(site, 'pre-restore', log, `Antes de restaurar la copia del ${b.created_at}`);

  if (parts.databases) {
    for (const name of (JSON.parse(b.includes) as string[]).filter((x) => x.startsWith('db:')).map((x) => x.slice(3))) {
      const db = get<DatabaseRow>('SELECT * FROM databases WHERE name = ?', name);
      if (!db) {
        log(`⚠ La base de datos ${name} ya no existe: se omite.`);
        continue;
      }
      log(`Restaurando la base de datos ${name}…`);
      const file = join(dir, `db-${name}.sql.gz`);
      await importDatabase(db, config.dev ? createReadStream(join(dir, 'manifest.json')) : createReadStream(file).pipe(createGunzip()));
    }
  }

  if (!parts.files) return;
  const filesTar = join(dir, 'files.tar.gz');
  const sharedTar = join(dir, 'shared.tar.gz');
  if (site.source === 'wordpress') {
    const target = wpDir(site.id);
    const fresh = `${target}.restore-${Date.now()}`;
    log('Restaurando los archivos de WordPress…');
    await exec('mkdir', ['-p', fresh]);
    await exec('tar', ['--no-same-owner', '-xzf', filesTar, '-C', fresh]);
    await chownSite(site.id, fresh);
    // Swap folders so the site never serves a half-extracted copy.
    const old = `${target}.old-${Date.now()}`;
    await exec('mv', [target, old]);
    await exec('mv', [fresh, target]);
    await exec('rm', ['-rf', old]);
    log('✔ Archivos de WordPress restaurados.');
    return;
  }
  if (config.dev || existsSync(sharedTar)) {
    log('Restaurando la carpeta compartida…');
    const shared = sitePaths(site.id).shared;
    await exec('tar', ['--no-same-owner', '-xzf', sharedTar, '-C', shared]);
    await chownSite(site.id, shared);
  }
  const release = `${stampNow().replace('-', '')}-restore`;
  const releaseDir = join(sitePaths(site.id).releases, release);
  log(`Preparando la release ${release} con los archivos de la copia…`);
  await exec('mkdir', ['-p', releaseDir]);
  await exec('tar', ['--no-same-owner', '-xzf', filesTar, '-C', releaseDir]);
  await chownSite(site.id, releaseDir);
  const deploymentId = enqueueDeploy(site.id, 'restauración de copia', { rollbackRelease: release });
  log(`✔ Publicando la copia (despliegue #${deploymentId}).`);
}

// --- schedule ------------------------------------------------------------------------------

const PERIOD = { daily: 24 * 3600_000, weekly: 7 * 24 * 3600_000 } as const;

/** Checks every 10 minutes which sites are due for an automatic backup (one at a time). */
export function startBackupScheduler() {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const sites = all<SiteRow>("SELECT * FROM sites WHERE backup_schedule IN ('daily', 'weekly')");
      for (const site of sites) {
        const last = get<{ created_at: string }>("SELECT created_at FROM backups WHERE site_id = ? AND kind = 'auto' AND status = 'success' ORDER BY id DESC LIMIT 1", site.id);
        const lastAt = last ? Date.parse(`${last.created_at.replace(' ', 'T')}Z`) : 0;
        const period = PERIOD[site.backup_schedule as keyof typeof PERIOD];
        if (Date.now() - lastAt < period - 10 * 60_000) continue;
        try {
          await createBackup(site, 'auto');
          pruneBackups(site);
        } catch (err) {
          console.error(`Copia automática del sitio ${site.id}: ${(err as Error).message}`);
        }
      }
    } finally {
      busy = false;
    }
  };
  setTimeout(() => void tick(), 60_000);
  return setInterval(() => void tick(), 10 * 60_000);
}
