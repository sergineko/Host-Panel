/**
 * Background jobs (PHP installs, updates, server provisioning) with a persisted log.
 * Jobs that must survive a panel restart (self-update) run outside the panel process,
 * write to a log file and end with a marker line ("HP_JOB_DONE rc=N") read back here.
 */
import { existsSync, readFileSync } from 'node:fs';
import { all, get, run, type JobRow } from '../db.ts';

const DONE_MARKER = /^HP_JOB_DONE rc=(\d+)\s*$/m;
const live = new Map<number, string[]>();

export type JobLog = (line: string) => void;

export function startJob(kind: string, title: string, user: string, fn: (log: JobLog) => Promise<void>): number {
  const { id } = run('INSERT INTO jobs (kind, title, created_by) VALUES (?, ?, ?)', kind, title, user);
  const lines: string[] = [];
  live.set(id, lines);
  const log: JobLog = (line) => {
    lines.push(line);
    if (lines.length > 5000) lines.splice(0, lines.length - 5000);
  };
  const flush = () => run('UPDATE jobs SET log = ? WHERE id = ?', lines.join('\n'), id);
  const timer = setInterval(flush, 2000);
  // Run on the next tick so the caller gets the id before any log line.
  setImmediate(() => {
    fn(log)
      .then(() => {
        log('✔ Terminado');
        run("UPDATE jobs SET status = 'success', finished_at = datetime('now') WHERE id = ?", id);
      })
      .catch((err: Error) => {
        log(`✖ ${err.message}`);
        run("UPDATE jobs SET status = 'failed', finished_at = datetime('now') WHERE id = ?", id);
      })
      .finally(() => {
        clearInterval(timer);
        flush();
        setTimeout(() => live.delete(id), 60_000);
      });
  });
  return id;
}

/** Registers a job whose work runs outside the panel process and logs to a file. */
export function startDetachedJob(kind: string, title: string, user: string, logFile: string): number {
  return run('INSERT INTO jobs (kind, title, created_by, log_file) VALUES (?, ?, ?, ?)', kind, title, user, logFile).id;
}

function readDetached(job: JobRow): JobRow {
  if (!job.log_file) return job;
  let text = job.log;
  try {
    if (existsSync(job.log_file)) text = readFileSync(job.log_file, 'utf8').slice(-200_000);
  } catch {
    /* keep stored log */
  }
  if (job.status !== 'running') return { ...job, log: text };
  const m = DONE_MARKER.exec(text);
  if (m) {
    const status = m[1] === '0' ? 'success' : 'failed';
    run("UPDATE jobs SET status = ?, log = ?, finished_at = datetime('now') WHERE id = ?", status, text, job.id);
    return { ...job, status, log: text };
  }
  return { ...job, log: text };
}

export function getJob(id: number): JobRow | undefined {
  const job = get<JobRow>('SELECT * FROM jobs WHERE id = ?', id);
  if (!job) return undefined;
  const lines = live.get(id);
  if (lines) return { ...job, log: lines.join('\n') };
  return readDetached(job);
}

export function listJobs(limit = 30) {
  return all<JobRow>('SELECT * FROM jobs ORDER BY id DESC LIMIT ?', limit).map((j) => {
    const { log: _log, ...rest } = j.status === 'running' && j.log_file ? readDetached(j) : j;
    return rest;
  });
}

export function runningJob(kind: string) {
  return get<JobRow>("SELECT * FROM jobs WHERE kind = ? AND status = 'running' ORDER BY id DESC LIMIT 1", kind);
}

/** In-process jobs interrupted by a restart are marked as failed. */
export function recoverJobs() {
  run("UPDATE jobs SET status = 'failed', finished_at = datetime('now'), log = log || '\n✖ Interrumpido por reinicio del panel' WHERE status = 'running' AND log_file = ''");
  run("UPDATE jobs SET status = 'failed', finished_at = datetime('now') WHERE status = 'running' AND log_file != '' AND created_at < datetime('now', '-3 hours')");
}
