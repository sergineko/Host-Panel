/**
 * Deployment pipeline. One queue per site (deploys of the same site never overlap).
 *
 *   clone → install → build (always on this server) → upload to remote nodes → publish
 *
 * Static/PHP: publish = atomically switch the `current` symlink to the new release.
 * Node: blue/green — start the new release on the idle slot (on every server of the
 *       site), wait until it answers, route traffic to it, then stop the old slot.
 * A failed deploy never takes the site down.
 */
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { connect } from 'node:net';
import { join, relative } from 'node:path';
import { config } from '../config.ts';
import { all, get, run, type DeploymentRow, type ServerRow, type SiteRow } from '../db.ts';
import { exec } from '../lib/exec.ts';
import { siteContentRoutes, syncCaddy } from './caddy.ts';
import { phpPoolDir, PHP_EXTENSIONS } from './php.ts';
import { ensureNodeOnRemoteScript, nodePathEnv, remoteNodeBin, siteNode, type NodeInstall } from './nodejs.ts';
import { installWordPress, isWordPressInstalled, wpDir } from './wordpress.ts';
import {
  buildNodeCaddyConfig,
  LOCAL_SERVER_ID,
  pushNodeCaddy,
  remoteScript,
  rsyncTo,
  siteServerIds,
  sq,
  writeFileScript,
} from './servers.ts';
import {
  chownSite,
  ensureSiteUser,
  envFileContent,
  nodePort,
  nodeUnit,
  nodeUnitContent,
  prepareSiteDirs,
  reloadPhp,
  removeReleaseDir,
  restartUnit,
  runAsSite,
  sitePaths,
  sitePhpPool,
  siteUser,
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

// --- remote nodes -----------------------------------------------------------------------

function remoteServersOf(site: SiteRow): ServerRow[] {
  const ids = siteServerIds(site).filter((id) => id !== LOCAL_SERVER_ID);
  if (!ids.length) return [];
  return all<ServerRow>(`SELECT * FROM servers WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
}

/** Creates the site user and folders on the node and uploads the release. */
async function uploadToNode(server: ServerRow, site: SiteRow, release: string, releaseDir: string, log: (l: string) => void) {
  const p = sitePaths(site.id);
  const user = siteUser(site.id);
  const env = JSON.parse(site.env) as Record<string, string>;
  log(`⇡ ${server.name}: subiendo la release…`);
  await remoteScript(
    server,
    `id -u ${user} >/dev/null 2>&1 || useradd --system --user-group --home-dir ${sq(p.home)} --shell /usr/sbin/nologin ${user}
mkdir -p ${sq(p.releases)} ${sq(p.shared)} ${sq(p.home)} ${sq(p.tmp)}`,
    { onLine: log },
  );
  await rsyncTo(server, releaseDir, join(p.releases, release), { onLine: log });
  await remoteScript(
    server,
    `${writeFileScript(p.envFile, envFileContent(env), '0640')}
chown -R ${user}:${user} ${sq(p.root)}
chown root:${user} ${sq(p.envFile)}
chmod 0750 ${sq(p.root)}
setfacl -R -m u:caddy:rX ${sq(p.root)} && setfacl -R -d -m u:caddy:rX ${sq(p.root)}
# keep the last ${KEEP_RELEASES} releases
ls -1 ${sq(p.releases)} | sort -r | tail -n +${KEEP_RELEASES + 2} | while read -r old; do rm -rf ${sq(p.releases)}/"$old"; done`,
    { onLine: log },
  );
}

/** Static/PHP: points `current` at the release and (PHP) writes the pool. */
async function activateFilesOnNode(server: ServerRow, site: SiteRow, publishDir: string, log: (l: string) => void) {
  const p = sitePaths(site.id);
  const target = relative(p.root, publishDir);
  let script = `ln -sfn ${sq(target)} ${sq(`${p.current}.tmp`)} && mv -Tf ${sq(`${p.current}.tmp`)} ${sq(p.current)}`;
  if (site.type === 'php') {
    const pool = sitePhpPool(site);
    const v = pool.version;
    script += `
if [ ! -x /usr/sbin/php-fpm${v} ]; then
  echo "Instalando PHP ${v} en el nodo…"
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${PHP_EXTENSIONS.map((e) => `php${v}-${e}`).join(' ')} >/dev/null
  rm -f ${phpPoolDir(v)}/www.conf
  systemctl enable --now php${v}-fpm
fi
for other in /etc/php/*/fpm/pool.d/hp-${site.id}.conf; do
  [ -e "$other" ] && [ "$other" != ${sq(pool.path)} ] && rm -f "$other" && systemctl reload "php$(echo "$other" | cut -d/ -f4)-fpm" || true
done
${writeFileScript(pool.path, pool.content)}
systemctl reload php${v}-fpm || systemctl restart php${v}-fpm`;
  }
  log(`▶ ${server.name}: publicando`);
  await remoteScript(server, script, { onLine: log });
}

/** Node: starts the release on a slot and waits until it listens. */
async function startNodeAppOnNode(server: ServerRow, site: SiteRow, slot: number, workdir: string, start: string, node: NodeInstall, log: (l: string) => void) {
  const unit = nodeUnit(site.id, slot);
  const port = nodePort(site.id, slot);
  log(`▶ ${server.name}: arrancando con Node.js ${node.version} en el slot ${slot} (puerto ${port})`);
  await remoteScript(
    server,
    `${ensureNodeOnRemoteScript(node)}
${writeFileScript(`/etc/systemd/system/${unit}.service`, nodeUnitContent(site, slot, workdir, start, remoteNodeBin(node)))}
systemctl daemon-reload
systemctl enable ${unit} >/dev/null 2>&1
systemctl restart ${unit}
for i in $(seq 1 60); do
  if (exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null; then echo "La app responde"; exit 0; fi
  sleep 1
done
echo "La app no respondió en 60 s:"; journalctl -u ${unit} -n 30 --no-pager -o cat || true
systemctl disable --now ${unit} || true
exit 1`,
    { onLine: log, timeoutMs: 3 * 60_000 },
  );
}

const stopNodeAppOnNode = (server: ServerRow, site: SiteRow, slot: number) =>
  remoteScript(server, `systemctl disable --now ${nodeUnit(site.id, slot)} || true`).catch(() => {});

/** Pushes the Caddy config of a node with every site it currently serves. */
export async function syncNodeCaddy(server: ServerRow, log?: (l: string) => void) {
  const sites = all<SiteRow>("SELECT * FROM sites WHERE active_release != ''").filter((s) => siteServerIds(s).includes(server.id));
  await pushNodeCaddy(server, buildNodeCaddyConfig(server, sites, siteContentRoutes), log);
}

/** Removes everything a site left on a node (site moved away or deleted). */
export async function removeSiteFromNode(server: ServerRow, siteId: number) {
  const p = sitePaths(siteId);
  await remoteScript(
    server,
    `for slot in 0 1; do systemctl disable --now hp-site-${siteId}-$slot 2>/dev/null || true; rm -f /etc/systemd/system/hp-site-${siteId}-$slot.service; done
systemctl daemon-reload
for pool in /etc/php/*/fpm/pool.d/hp-${siteId}.conf; do [ -e "$pool" ] && rm -f "$pool" && systemctl reload "php$(echo "$pool" | cut -d/ -f4)-fpm" || true; done
rm -rf ${sq(p.root)}
userdel ${siteUser(siteId)} 2>/dev/null || true`,
  );
  await syncNodeCaddy(server);
}

// --- pipeline ---------------------------------------------------------------------------

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
    const local = siteServerIds(site).includes(LOCAL_SERVER_ID);
    const remotes = remoteServersOf(site);

    log(`▶ Despliegue #${deploymentId} de "${site.name}" (${site.type})`);
    log(`  Servidores: ${[local ? 'este servidor' : null, ...remotes.map((r) => r.name)].filter(Boolean).join(', ')}`);
    // The release is always built here, even when the site only runs on remote nodes.
    await ensureSiteUser(site.id);
    await prepareSiteDirs(site.id);
    await writeSiteEnv(site);

    if (site.source === 'wordpress') {
      // WordPress lives in one persistent folder: install once, then only re-apply settings.
      const installed = isWordPressInstalled(site);
      if (installed) log('WordPress ya está instalado: se aplica la configuración (PHP y dominios).');
      else await installWordPress(site, log);
      const versions = await writePhpPool(site);
      await switchCurrent(site.id, wpDir(site.id));
      await reloadPhp(versions);
      log(`✔ PHP ${sitePhpPool(site).version} recargado.`);
      run(
        "UPDATE deployments SET release = 'wordpress', commit_message = ? WHERE id = ?",
        installed ? 'Configuración aplicada' : 'Instalación de WordPress',
        deploymentId,
      );
      run("UPDATE sites SET active_release = 'wordpress' WHERE id = ?", site.id);
      await syncCaddy();
      run("UPDATE sites SET status = 'live' WHERE id = ?", site.id);
      run("UPDATE deployments SET status = 'success', finished_at = datetime('now') WHERE id = ?", deploymentId);
      log(`✔ Listo en ${Math.round((Date.now() - started) / 1000)} s`);
      return;
    }

    let release: string;
    let releaseDir: string;

    if (rollbackRelease) {
      release = rollbackRelease;
      releaseDir = join(p.releases, release);
      if (!config.dev && !existsSync(releaseDir)) throw new Error(`La release ${release} ya no existe en disco`);
      log(release === site.active_release ? `↻ Volviendo a publicar la release actual ${release}` : `↺ Rollback a la release ${release}`);
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
        await exec('mkdir', ['-p', releaseDir]);
        // Files managed from the panel (no Git): each new release starts from the live one.
        const previous = site.active_release ? join(p.releases, site.active_release) : '';
        if (previous && (config.dev || existsSync(previous))) {
          log(`Sin repositorio: se copian los archivos de la versión actual (${site.active_release}).`);
          await exec('cp', ['-a', `${previous}/.`, releaseDir]);
        } else {
          log('Sin repositorio: se publica una carpeta vacía. Sube tus archivos desde la pestaña Archivos o conecta un repositorio.');
        }
      }
      await chownSite(site.id, releaseDir);

      // Node.js version for install/build (the same one runs Node apps).
      const buildNode = needsNode(site, releaseDir) ? siteNode(site) : null;
      const buildEnv = buildNode ? { ...env, PATH: nodePathEnv(buildNode) } : env;
      if (buildNode) log(`Node.js ${buildNode.version} (${buildNode.bin})${!site.node_version || site.node_version === 'latest' ? ' · siempre la última instalada' : ''}`);

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
        await runAsSite(site.id, install, releaseDir, buildEnv, { onLine: log, timeoutMs: 20 * 60_000 });
      }

      // 3. Build
      if (site.build_command) {
        log(`$ ${site.build_command}`);
        await runAsSite(site.id, site.build_command, releaseDir, buildEnv, { onLine: log, timeoutMs: 30 * 60_000 });
      }
    }

    const publishDir = site.output_dir ? join(releaseDir, site.output_dir) : releaseDir;
    if (!config.dev && !existsSync(publishDir)) throw new Error(`No existe el directorio de salida "${site.output_dir}"`);

    // 4. Upload to remote nodes (before switching anything, so a failed upload changes nothing).
    for (const server of remotes) await uploadToNode(server, site, release, releaseDir, log);

    // 5. Publish
    if (site.type === 'node') {
      const slot = site.active_release ? 1 - site.active_slot : 0;
      const port = nodePort(site.id, slot);
      const start = site.start_command || 'npm start';
      const node = siteNode(site);
      const startedOn: ServerRow[] = [];
      try {
        if (local) {
          log(`▶ Este servidor: arrancando con Node.js ${node.version} en el slot ${slot} (puerto ${port}): ${start}`);
          await writeNodeUnit(site, slot, publishDir, start, node.bin);
          await restartUnit(nodeUnit(site.id, slot));
          const healthy = config.dev || (await waitForPort(port, 60_000));
          if (!healthy) {
            log('✖ La aplicación no respondió en 60 s. Últimas líneas del log:');
            log(await unitLogs(nodeUnit(site.id, slot), 40));
            throw new Error(`La app no escucha en el puerto ${port}. Asegúrate de usar process.env.PORT.`);
          }
        }
        for (const server of remotes) {
          await startNodeAppOnNode(server, site, slot, publishDir, start, node, log);
          startedOn.push(server);
        }
      } catch (err) {
        // Roll back the half-started slot everywhere; the old version keeps serving.
        if (local) await stopUnit(nodeUnit(site.id, slot));
        for (const s of startedOn) await stopNodeAppOnNode(s, site, slot);
        throw err;
      }
      log('✔ La nueva versión responde. Cambiando el tráfico…');
      run('UPDATE sites SET active_slot = ?, active_release = ? WHERE id = ?', slot, release, site.id);
      for (const server of remotes) await syncNodeCaddy(server, log);
      await syncCaddy();
      if (site.active_release) {
        await new Promise((r) => setTimeout(r, 3000)); // let in-flight requests finish
        if (local) await stopUnit(nodeUnit(site.id, 1 - slot));
        for (const server of remotes) await stopNodeAppOnNode(server, site, 1 - slot);
        log(`Slot anterior (${1 - slot}) detenido.`);
      }
    } else {
      if (local) {
        if (site.type === 'php') {
          const versions = await writePhpPool(site);
          await switchCurrent(site.id, publishDir);
          await reloadPhp(versions);
          log(`✔ PHP ${sitePhpPool(site).version} recargado (opcache limpio).`);
        } else {
          await switchCurrent(site.id, publishDir);
        }
      }
      for (const server of remotes) await activateFilesOnNode(server, site, publishDir, log);
      const firstRelease = !site.active_release;
      run('UPDATE sites SET active_release = ? WHERE id = ?', release, site.id);
      for (const server of remotes) await syncNodeCaddy(server, log);
      if (firstRelease || remotes.length) await syncCaddy();
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

/** Node.js is needed to run Node apps and for npm/yarn installs and builds. */
function needsNode(site: SiteRow, releaseDir: string) {
  if (site.type === 'node') return true;
  const cmds = `${site.install_command} ${site.build_command}`;
  if (/\b(npm|npx|yarn|pnpm|node|corepack)\b/.test(cmds)) return true;
  return !!site.build_command && (config.dev || existsSync(join(releaseDir, 'package.json')));
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
