/**
 * Scheduled commands per site (cPanel "Cron Jobs"): run as the site's Linux user, in the
 * site's folder, with its environment variables and its Node.js version on the PATH.
 * The panel keeps the last output of each one, so failures are visible without SSH.
 */
import { all, get, run, type SiteCronRow, type SiteRow } from '../db.ts';
import { cronMatches, parseCron } from './cron.ts';
import { nodePathEnv, siteNode } from './nodejs.ts';
import { runAsSite, sitePaths } from './system.ts';
import { wpDir } from './wordpress.ts';

const MAX_OUTPUT = 16_000;
const TIMEOUT_MS = 15 * 60_000;
const running = new Set<number>();

export const CRON_PRESETS = [
  { label: 'Cada minuto', schedule: '* * * * *' },
  { label: 'Cada 5 minutos', schedule: '*/5 * * * *' },
  { label: 'Cada 15 minutos', schedule: '*/15 * * * *' },
  { label: 'Cada hora', schedule: '0 * * * *' },
  { label: 'Cada día (03:00 UTC)', schedule: '0 3 * * *' },
  { label: 'Cada lunes (06:00 UTC)', schedule: '0 6 * * 1' },
  { label: 'Cada mes (día 1)', schedule: '0 4 1 * *' },
];

function siteEnv(site: SiteRow): Record<string, string> {
  const env = JSON.parse(site.env || '{}') as Record<string, string>;
  if (site.type === 'node' || /\b(npm|npx|node|yarn|pnpm)\b/.test(site.install_command + site.build_command)) {
    try {
      env.PATH = nodePathEnv(siteNode(site));
    } catch {
      /* no Node installed: keep the default PATH */
    }
  }
  return env;
}

export const cronWorkdir = (site: SiteRow) => (site.source === 'wordpress' ? wpDir(site.id) : sitePaths(site.id).current);

/** Runs one job now and stores its result. */
export async function runSiteCron(job: SiteCronRow): Promise<SiteCronRow> {
  const site = get<SiteRow>('SELECT * FROM sites WHERE id = ?', job.site_id);
  if (!site) throw new Error('El sitio ya no existe');
  if (running.has(job.id)) throw new Error('Esta tarea ya se está ejecutando');
  running.add(job.id);
  run("UPDATE site_crons SET last_status = 'running', last_run = datetime('now') WHERE id = ?", job.id);
  const started = Date.now();
  let output = '';
  const onLine = (line: string) => {
    output += `${line}\n`;
    if (output.length > MAX_OUTPUT * 2) output = output.slice(-MAX_OUTPUT);
  };
  let status: 'success' | 'failed' = 'success';
  try {
    await runAsSite(site.id, job.command, cronWorkdir(site), siteEnv(site), { onLine, timeoutMs: TIMEOUT_MS });
  } catch (err) {
    status = 'failed';
    onLine(`✖ ${(err as Error).message}`);
  } finally {
    running.delete(job.id);
  }
  run(
    'UPDATE site_crons SET last_status = ?, last_duration = ?, last_output = ? WHERE id = ?',
    status,
    Date.now() - started,
    output.slice(-MAX_OUTPUT),
    job.id,
  );
  return get<SiteCronRow>('SELECT * FROM site_crons WHERE id = ?', job.id)!;
}

/** Checks every few seconds for the jobs due this minute (UTC, like Worker crons). */
export function startSiteCronScheduler() {
  let lastMinute = 0;
  // Jobs left "running" by a restart are not running anymore.
  run("UPDATE site_crons SET last_status = 'failed', last_output = last_output || '\n✖ Interrumpida por un reinicio del panel' WHERE last_status = 'running'");
  const tick = () => {
    const now = new Date();
    const minute = Math.floor(now.getTime() / 60_000);
    if (minute === lastMinute) return;
    lastMinute = minute;
    for (const job of all<SiteCronRow>('SELECT * FROM site_crons WHERE enabled = 1')) {
      try {
        if (!cronMatches(parseCron(job.schedule), now)) continue;
      } catch {
        continue;
      }
      if (running.has(job.id)) continue; // still busy from the last run: skip, don't pile up
      runSiteCron(job).catch((err: Error) => console.error(`Cron ${job.id}: ${err.message}`));
    }
  };
  return setInterval(tick, 5000);
}
