/**
 * Workers: JavaScript modules with the Cloudflare Workers API, each one running in its own
 * sandboxed process (runtime/worker-host.mjs):
 *
 *   - its own Linux user (hpw-<id>) and folder /srv/hostpanel/workers/<id> (0750)
 *   - Node's permission model: can only read its own folder; no child processes or addons
 *   - systemd: no access to unix sockets (MariaDB, Caddy admin…), memory and CPU limits
 *   - bindings (D1, R2, KV, Queues) only through the internal API with its own token
 *
 * Caddy routes <name>.<workersDomain> and the Worker's routes (ejemplo.com/api/*) to it.
 * In dev mode (any OS) Workers run as plain child processes so they can be tested.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.ts';
import { all, get, run, type WorkerRow } from '../db.ts';
import { decrypt } from '../lib/crypto.ts';
import { exec, tryExec } from '../lib/exec.ts';

export const RUNTIME_DIR = fileURLToPath(new URL('../../../runtime', import.meta.url));
export const workerDir = (id: number) => resolve(config.workersDir, String(id));
export const workerPort = (id: number) => 30000 + id;
export const workerUser = (id: number) => `hpw-${id}`;
export const workerUnit = (id: number) => `hp-worker-${id}`;
export const WORKER_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface Binding {
  type: 'd1' | 'kv' | 'r2' | 'queue';
  name: string;
  id: number;
}

export const workerBindings = (w: Pick<WorkerRow, 'bindings'>) => JSON.parse(w.bindings || '[]') as Binding[];
export const workerRoutes = (w: Pick<WorkerRow, 'routes'>) => JSON.parse(w.routes || '[]') as string[];
export const workerCrons = (w: Pick<WorkerRow, 'crons'>) => JSON.parse(w.crons || '[]') as string[];

export function workerSecrets(w: Pick<WorkerRow, 'secrets'>): Record<string, string> {
  const enc = JSON.parse(w.secrets || '{}') as Record<string, string>;
  return Object.fromEntries(Object.entries(enc).map(([k, v]) => [k, decrypt(v)]));
}

export function workerHostname(w: Pick<WorkerRow, 'name' | 'subdomain'>) {
  return w.subdomain && config.workersDomain ? `${w.name}.${config.workersDomain}` : null;
}

// --- live logs & metrics ----------------------------------------------------------------

export interface WorkerEvent {
  seq: number;
  type: 'fetch' | 'queue' | 'scheduled' | 'log' | 'system';
  ts: number;
  method?: string;
  url?: string;
  status?: number;
  duration?: number;
  ip?: string;
  queue?: string;
  count?: number;
  cron?: string;
  logs?: { level: string; message: string }[];
  exception?: string | null;
}

const events = new Map<number, WorkerEvent[]>();
let seq = 0;

export function pushEvents(workerId: number, list: Omit<WorkerEvent, 'seq'>[]) {
  const buf = events.get(workerId) ?? [];
  const hour = Math.floor(Date.now() / 3600_000);
  for (const e of list) {
    buf.push({ ...e, seq: ++seq } as WorkerEvent);
    if (e.type === 'fetch' || e.type === 'queue' || e.type === 'scheduled') {
      const failed = !!e.exception || (e.type === 'fetch' && (e.status ?? 0) >= 500);
      run(
        `INSERT INTO worker_metrics (worker_id, hour, requests, errors, duration_ms, queue_messages, cron_runs) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(worker_id, hour) DO UPDATE SET requests = requests + excluded.requests, errors = errors + excluded.errors,
           duration_ms = duration_ms + excluded.duration_ms, queue_messages = queue_messages + excluded.queue_messages, cron_runs = cron_runs + excluded.cron_runs`,
        workerId,
        hour,
        e.type === 'fetch' ? 1 : 0,
        failed ? 1 : 0,
        e.duration ?? 0,
        e.type === 'queue' ? (e.count ?? 0) : 0,
        e.type === 'scheduled' ? 1 : 0,
      );
    }
  }
  if (buf.length > 500) buf.splice(0, buf.length - 500);
  events.set(workerId, buf);
}

const systemEvent = (workerId: number, message: string, level = 'info') => pushEvents(workerId, [{ type: 'system', ts: Date.now(), logs: [{ level, message }] }]);

export function workerEvents(workerId: number, after = 0) {
  return (events.get(workerId) ?? []).filter((e) => e.seq > after);
}

export function workerMetrics(workerId: number, hours = 24) {
  const now = Math.floor(Date.now() / 3600_000);
  const rows = all<{ hour: number; requests: number; errors: number; duration_ms: number; queue_messages: number; cron_runs: number }>(
    'SELECT * FROM worker_metrics WHERE worker_id = ? AND hour > ? ORDER BY hour',
    workerId,
    now - hours,
  );
  const byHour = new Map(rows.map((r) => [r.hour, r]));
  const series = Array.from({ length: hours }, (_, i) => {
    const hour = now - hours + 1 + i;
    const r = byHour.get(hour);
    return { hour: hour * 3600, requests: r?.requests ?? 0, errors: r?.errors ?? 0, avg_ms: r?.requests ? Math.round((r.duration_ms / r.requests) * 10) / 10 : 0, queue_messages: r?.queue_messages ?? 0, cron_runs: r?.cron_runs ?? 0 };
  });
  const total = series.reduce(
    (a, s) => ({ requests: a.requests + s.requests, errors: a.errors + s.errors, queue_messages: a.queue_messages + s.queue_messages, cron_runs: a.cron_runs + s.cron_runs }),
    { requests: 0, errors: 0, queue_messages: 0, cron_runs: 0 },
  );
  const durations = rows.reduce((a, r) => a + r.duration_ms, 0);
  return { series, total: { ...total, avg_ms: total.requests ? Math.round((durations / total.requests) * 10) / 10 : 0 } };
}

// --- processes ----------------------------------------------------------------------------

/**
 * Node's permission model flags. Node 25+ also gates networking (--allow-net); Node 24
 * doesn't know that flag, so it is only added when this Node supports it.
 */
let permFlagsCache: string[] | null = null;
function permissionFlags(id: number) {
  if (!permFlagsCache) {
    const probe = spawnSync(process.execPath, ['--permission', '--allow-net', '-e', '0'], { timeout: 10_000 });
    permFlagsCache = probe.status === 0 ? ['--allow-net'] : [];
  }
  return ['--disable-warning=ExperimentalWarning', '--permission', `--allow-fs-read=${workerDir(id)}`, `--allow-fs-read=${RUNTIME_DIR}`, ...permFlagsCache];
}

/** Dev mode: Workers run as plain child processes (restarted if they crash). */
const devProcs = new Map<number, { child: ChildProcess; stopping: boolean }>();
const startupOutput = new Map<number, string>();

function devStart(id: number) {
  devStop(id);
  const entry = { child: null as unknown as ChildProcess, stopping: false };
  const launch = () => {
    startupOutput.set(id, '');
    const child = spawn(process.execPath, [...permissionFlags(id), join(RUNTIME_DIR, 'worker-host.mjs'), workerDir(id)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const collect = (d: Buffer) => {
      out = (out + d.toString()).slice(-8000);
      startupOutput.set(id, out);
    };
    child.stdout!.on('data', collect);
    child.stderr!.on('data', collect);
    child.on('exit', (code) => {
      if (entry.stopping) return;
      systemEvent(id, `El proceso terminó (código ${code}); reiniciando…`, 'warn');
      setTimeout(() => !entry.stopping && launch(), 1000);
    });
    entry.child = child;
  };
  launch();
  devProcs.set(id, entry);
}

function devStop(id: number) {
  const p = devProcs.get(id);
  if (!p) return;
  p.stopping = true;
  p.child.kill('SIGTERM');
  devProcs.delete(id);
}

function unitContent(w: WorkerRow) {
  const dir = workerDir(w.id);
  return `# Generated by HostPanel. Do not edit.
[Unit]
Description=HostPanel Worker ${w.id} (${w.name})
After=network.target hostpanel.service

[Service]
Type=simple
User=${workerUser(w.id)}
Group=${workerUser(w.id)}
WorkingDirectory=${dir}
ExecStart=/usr/bin/node ${permissionFlags(w.id).join(' ')} --max-old-space-size=${w.memory_mb} ${join(RUNTIME_DIR, 'worker-host.mjs')} ${dir}
Restart=always
RestartSec=1
MemoryMax=${w.memory_mb + 64}M
CPUQuota=100%
TasksMax=64
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictNamespaces=yes
# Network only: no unix sockets (MariaDB, Caddy admin, systemd…).
RestrictAddressFamilies=AF_INET AF_INET6
UMask=0077

[Install]
WantedBy=multi-user.target
`;
}

function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const s = connect({ host: '127.0.0.1', port });
      s.once('connect', () => {
        s.destroy();
        resolve(true);
      });
      s.once('error', () => {
        s.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

async function writeWorkerFiles(w: WorkerRow, code: string) {
  const dir = workerDir(w.id);
  mkdirSync(dir, { recursive: true });
  const cfg = {
    id: w.id,
    name: w.name,
    version: w.version,
    port: workerPort(w.id),
    token: w.token,
    internal: `http://127.0.0.1:${config.internalPort}`,
    vars: JSON.parse(w.vars || '{}'),
    secrets: workerSecrets(w),
    bindings: workerBindings(w),
  };
  await writeFile(join(dir, 'worker.mjs'), code, { mode: 0o640 });
  await writeFile(join(dir, 'config.json'), JSON.stringify(cfg), { mode: 0o640 });
  if (!config.dev) {
    const user = workerUser(w.id);
    if (!(await tryExec('id', ['-u', user])).ok) {
      await exec('useradd', ['--system', '--user-group', '--no-create-home', '--home-dir', dir, '--shell', '/usr/sbin/nologin', user]);
    }
    await exec('chown', ['-R', `root:${user}`, dir]);
    await exec('chmod', ['0750', dir]);
  }
}

async function startProcess(w: WorkerRow) {
  if (config.dev) {
    devStart(w.id);
  } else {
    writeFileSync(`/etc/systemd/system/${workerUnit(w.id)}.service`, unitContent(w));
    await exec('systemctl', ['daemon-reload']);
    await exec('systemctl', ['enable', workerUnit(w.id)]);
    await exec('systemctl', ['restart', workerUnit(w.id)]);
  }
}

/** Removes colour codes, Node's footer and internal stack frames from error output. */
export function cleanOutput(text: string) {
  return text
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .filter((l) => !/^Node\.js v\d/.test(l) && !/\(node:internal\//.test(l) && !/ExperimentalWarning|--trace-warnings/.test(l))
    .join('\n')
    .replace(/file:\/\/[^\s)]*\/worker\.mjs/g, 'worker.js')
    .trim();
}

async function processOutput(id: number) {
  if (config.dev) return startupOutput.get(id) ?? '';
  return (await tryExec('journalctl', ['-u', workerUnit(id), '-n', '25', '--no-pager', '-o', 'cat'])).output;
}

export async function stopWorkerProcess(id: number) {
  if (config.dev) devStop(id);
  else await tryExec('systemctl', ['disable', '--now', workerUnit(id)]);
}

/** Checks the module syntax without running it. */
export function checkSyntax(code: string): string | null {
  const dir = join(config.workersDir, '.check');
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `check-${process.pid}-${Date.now()}.mjs`);
  writeFileSync(file, code);
  try {
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 10_000 });
    if (r.status === 0) return null;
    return cleanOutput((r.stderr || r.stdout || 'Error de sintaxis').split(file).join('worker.js'));
  } finally {
    void rm(file, { force: true });
  }
}

/**
 * Starts the Worker with the given code. If it doesn't come up, the previous version is
 * restored and the error is reported: a bad deploy never takes the Worker down.
 */
export async function launchWorker(w: WorkerRow, code: string, previousCode?: string): Promise<{ ok: boolean; error?: string }> {
  await writeWorkerFiles(w, code);
  await startProcess(w);
  const up = await waitForPort(workerPort(w.id), 10_000);
  if (up) {
    run("UPDATE workers SET status = 'running', last_error = '' WHERE id = ?", w.id);
    systemEvent(w.id, `Versión ${w.version} desplegada`);
    return { ok: true };
  }
  const output = cleanOutput(await processOutput(w.id)).split('\n').slice(-15).join('\n');
  if (previousCode) {
    systemEvent(w.id, 'La nueva versión no arrancó: se restaura la anterior', 'error');
    await writeWorkerFiles(w, previousCode);
    await startProcess(w);
    await waitForPort(workerPort(w.id), 10_000);
    run("UPDATE workers SET status = 'running', last_error = ? WHERE id = ?", output, w.id);
  } else {
    await stopWorkerProcess(w.id);
    run("UPDATE workers SET status = 'error', last_error = ? WHERE id = ?", output, w.id);
  }
  return { ok: false, error: output || 'El Worker no arrancó' };
}

export async function removeWorkerFiles(id: number) {
  await stopWorkerProcess(id);
  if (!config.dev) {
    await rm(`/etc/systemd/system/${workerUnit(id)}.service`, { force: true });
    await tryExec('systemctl', ['daemon-reload']);
    await tryExec('userdel', [workerUser(id)]);
  }
  await rm(workerDir(id), { recursive: true, force: true });
  events.delete(id);
}

/** Starts every enabled Worker (dev mode: the panel owns the processes). */
export async function startWorkersOnBoot() {
  for (const w of all<WorkerRow>("SELECT * FROM workers WHERE enabled = 1 AND version > 0 AND status != 'error'")) {
    if (config.dev) {
      await launchWorker(w, w.code).catch((err) => console.error(`Worker ${w.name}:`, err.message));
    } else if (!existsSync(join(workerDir(w.id), 'worker.mjs'))) {
      await launchWorker(w, w.code).catch(() => {});
    }
  }
}

export function getWorkerByToken(token: string) {
  return get<WorkerRow>('SELECT * FROM workers WHERE token = ?', token);
}

/** Calls a Worker's internal trigger (queue batch or cron). */
export async function triggerWorker(w: WorkerRow, path: '/__hp/queue' | '/__hp/scheduled', body: unknown, timeoutMs = 60_000) {
  const res = await fetch(`http://127.0.0.1:${workerPort(w.id)}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hp-token': w.token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res;
}
