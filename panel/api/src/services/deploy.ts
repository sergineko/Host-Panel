/**
 * Deployment pipeline. One queue per site (deploys of the same site never overlap).
 *
 *   clone → install → build → publish
 *
 * Static/PHP: publish = atomically switch the `current` symlink to the new release.
 * Node: blue/green — start the new release on the idle slot, wait until it answers,
 *       route traffic to it, then stop the old slot. A failed deploy never takes the site down.
 */
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { config } from '../config.ts';
import { get, run, all, type DeploymentRow, type SiteRow } from '../db.ts';
import { exec } from '../lib/exec.ts';
import { syncCaddy } from './caddy.ts';
import {
  chownSite,
  ensureSiteUser,
  nodePort,
  nodeUnit,
  prepareSiteDirs,
  reloadPhp,
  removeReleaseDir,
  restartUnit,
  runAsSite,
  sitePaths,
  stopUnit,
  switchCurrent,
  unitLogs,
  writeNodeUnit,
  writePhpPool,
  writeSiteEnv,
} from './system.ts';

const KEEP_RELEASES = 5;
const queues = new Map<number, Promise<void>>();
const liveLogs = new Map<number, string[]>();

export function deploymentLog(id: number): string | undefined {
  return liveLogs.get(id)?.join('\n');
}

function authUrl(repoUrl: string, token: string) {
  if (!token || !repoUrl.startsWith('https://')) return repoUrl;
  const url = new URL(repoUrl);
  url.username = 'x-access-token';
  url.password = token;
  return url.toString();
}

function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = connect({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(attempt, 1000);
      });
    };
    attempt();
  });
}

/** Queues a deployment and returns its id immediately. */
export function enqueueDeploy(siteId: number, trigger: string, opts: { rollbackRelease?: string } = {}): number {
  const { id } = run('INSERT INTO deployments (site_id, trigger) VALUES (?, ?)', siteId, trigger);
  liveLogs.set(id, []);
  const previous = queues.get(siteId) ?? Promise.resolve();
  const next = previous.then(() => runDeploy(id, opts.rollbackRelease)).catch(() => {});
  queues.set(siteId, next);
  return id;
}

async function runDeploy(deploymentId: number, rollbackRelease?: string) {
  const lines = liveLogs.get(deploymentId) ?? [];
  liveLogs.set(deploymentId, lines);
  const log = (line: string) => {
    lines.push(line);
    if (lines.length > 5000) lines.splice(0, lines.length - 5000);
  };
  const flush = () => run('UPDATE deployments SET log = ? WHERE id = ?', lines.join('\n'), deploymentId);
  const flusher = setInterval(flush, 2000);

  const dep = get<DeploymentRow>('SELECT * FROM deployments WHERE id = ?', deploymentId)!;
  const site = get<SiteRow>('SELECT * FROM sites WHERE id = ?', dep.site_id);
  run("UPDATE deployments SET status = 'running' WHERE id = ?", deploymentId);
  const started = Date.now();

  try {
    if (!site) throw new Error('El sitio ya no existe');
    run("UPDATE sites SET status = 'deploying' WHERE id = ?", site.id);
    const p = sitePaths(site.id);
    const env = JSON.parse(site.env) as Record<string, string>;

    log(`▶ Despliegue #${deploymentId} de "${site.name}" (${site.type})`);
    await ensureSiteUser(site.id);
    await prepareSiteDirs(site.id);
    await writeSiteEnv(site);

    let release: string;
    let releaseDir: string;

    if (rollbackRelease) {
      release = rollbackRelease;
      releaseDir = join(p.releases, release);
      if (!config.dev && !existsSync(releaseDir)) throw new Error(`La release ${release} ya no existe en disco`);
      log(`↺ Rollback a la release ${release}`);
      const original = get<DeploymentRow>('SELECT * FROM deployments WHERE site_id = ? AND release = ? ORDER BY id LIMIT 1', site.id, release);
      run(
        'UPDATE deployments SET release = ?, commit_sha = ?, commit_message = ? WHERE id = ?',
        release,
        original?.commit_sha ?? '',
        `Rollback: ${original?.commit_message ?? release}`,
        deploymentId,
      );
    } else {
      release = `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${deploymentId}`;
      releaseDir = join(p.releases, release);
      run('UPDATE deployments SET release = ? WHERE id = ?', release, deploymentId);

      // 1. Source code
      if (site.repo_url) {
        log(`$ git clone --depth 1 --branch ${site.branch} ${site.repo_url}`);
        await exec('git', ['clone', '--depth', '1', '--branch', site.branch, authUrl(site.repo_url, site.repo_token), releaseDir], {
          onLine: log,
          mask: [site.repo_token],
          timeoutMs: 5 * 60_000,
          env: { GIT_TERMINAL_PROMPT: '0' },
        });
        if (!config.dev) {
          const info = await exec('git', ['-C', releaseDir, 'log', '-1', '--format=%H%n%s']);
          const [sha = '', message = ''] = info.trim().split('\n');
          run('UPDATE deployments SET commit_sha = ?, commit_message = ? WHERE id = ?', sha, message, deploymentId);
          log(`✔ Commit ${sha.slice(0, 7)}: ${message}`);
        }
      } else {
        log('Sin repositorio: se publica una carpeta vacía (sube los archivos por SFTP o conecta un repo).');
        await exec('mkdir', ['-p', releaseDir]);
      }
      await chownSite(site.id, releaseDir);

      // 2. Dependencies
      const hasPackageJson = config.dev || existsSync(join(releaseDir, 'package.json'));
      let install = site.install_command;
      if (!install && hasPackageJson && (site.type === 'node' || site.build_command)) {
        install = existsSync(join(releaseDir, 'package-lock.json')) ? 'npm ci' : 'npm install';
      }
      if (!install && site.type === 'php' && existsSync(join(releaseDir, 'composer.json'))) {
        install = 'composer install --no-dev --optimize-autoloader --no-interaction';
      }
      if (install) {
        log(`$ ${install}`);
        await runAsSite(site.id, install, releaseDir, env, { onLine: log, timeoutMs: 20 * 60_000 });
      }

      // 3. Build
      if (site.build_command) {
        log(`$ ${site.build_command}`);
        await runAsSite(site.id, site.build_command, releaseDir, env, { onLine: log, timeoutMs: 30 * 60_000 });
      }
    }

    const publishDir = site.output_dir ? join(releaseDir, site.output_dir) : releaseDir;
    if (!config.dev && !existsSync(publishDir)) throw new Error(`No existe el directorio de salida "${site.output_dir}"`);

    // 4. Publish
    if (site.type === 'node') {
      const slot = site.active_release ? 1 - site.active_slot : 0;
      const port = nodePort(site.id, slot);
      const start = site.start_command || 'npm start';
      log(`▶ Arrancando en el slot ${slot} (puerto ${port}): ${start}`);
      await writeNodeUnit(site, slot, publishDir, start);
      await restartUnit(nodeUnit(site.id, slot));
      const healthy = config.dev || (await waitForPort(port, 60_000));
      if (!healthy) {
        log('✖ La aplicación no respondió en 60 s. Últimas líneas del log:');
        log(await unitLogs(nodeUnit(site.id, slot), 40));
        await stopUnit(nodeUnit(site.id, slot));
        throw new Error(`La app no escucha en el puerto ${port}. Asegúrate de usar process.env.PORT.`);
      }
      log('✔ La nueva versión responde. Cambiando el tráfico…');
      run('UPDATE sites SET active_slot = ?, active_release = ? WHERE id = ?', slot, release, site.id);
      await syncCaddy();
      if (site.active_release) {
        await new Promise((r) => setTimeout(r, 3000)); // let in-flight requests finish
        await stopUnit(nodeUnit(site.id, 1 - slot));
        log(`Slot anterior (${1 - slot}) detenido.`);
      }
    } else {
      if (site.type === 'php') {
        await writePhpPool(site);
      }
      await switchCurrent(site.id, publishDir);
      const firstRelease = !site.active_release;
      run('UPDATE sites SET active_release = ? WHERE id = ?', release, site.id);
      if (site.type === 'php') {
        await reloadPhp();
        log('✔ PHP-FPM recargado (opcache limpio).');
      }
      if (firstRelease) await syncCaddy();
      log(`✔ Publicado: current → releases/${release}${site.output_dir ? `/${site.output_dir}` : ''}`);
    }

    await cleanupReleases(site.id, release);
    run("UPDATE sites SET status = 'live' WHERE id = ?", site.id);
    run("UPDATE deployments SET status = 'success', finished_at = datetime('now') WHERE id = ?", deploymentId);
    log(`✔ Despliegue completado en ${Math.round((Date.now() - started) / 1000)} s`);
  } catch (err) {
    log(`✖ Error: ${err instanceof Error ? err.message : String(err)}`);
    run("UPDATE deployments SET status = 'failed', finished_at = datetime('now') WHERE id = ?", deploymentId);
    if (site) {
      const live = get<{ active_release: string }>('SELECT active_release FROM sites WHERE id = ?', site.id);
      run('UPDATE sites SET status = ? WHERE id = ?', live?.active_release ? 'live' : 'failed', site.id);
    }
  } finally {
    clearInterval(flusher);
    flush();
    setTimeout(() => liveLogs.delete(deploymentId), 60_000);
  }
}

async function cleanupReleases(siteId: number, keep: string) {
  if (config.dev) return;
  const dir = sitePaths(siteId).releases;
  const releases = (await readdir(dir)).sort().reverse();
  for (const r of releases.slice(KEEP_RELEASES)) {
    if (r !== keep) await removeReleaseDir(join(dir, r));
  }
}

/** Deployments interrupted by a panel restart are marked as failed. */
export function recoverInterruptedDeployments() {
  run("UPDATE deployments SET status = 'failed', finished_at = datetime('now'), log = log || '\n✖ Interrumpido por reinicio del panel' WHERE status IN ('queued','running')");
  run("UPDATE sites SET status = CASE WHEN active_release = '' THEN 'failed' ELSE 'live' END WHERE status = 'deploying'");
}

export function releasesOnDisk(siteId: number) {
  return all<{ release: string }>(
    "SELECT DISTINCT release FROM deployments WHERE site_id = ? AND status = 'success' AND release != '' ORDER BY id DESC LIMIT ?",
    siteId,
    KEEP_RELEASES,
  ).map((r) => r.release);
}
