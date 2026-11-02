/**
 * Traffic analytics from Caddy's JSON access log. The file is tailed every few seconds,
 * aggregated per host and hour into SQLite, and the latest requests are kept in memory
 * for the "live log" view.
 */
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.ts';
import { all, db, getSetting, setSetting } from '../db.ts';

export interface RecentRequest {
  ts: number;
  host: string;
  method: string;
  uri: string;
  status: number;
  size: number;
  duration: number;
  ip: string;
  ua: string;
}

const recent: RecentRequest[] = [];
const MAX_RECENT = 500;
const logFile = join(config.logDir, 'access.log');

const upsert = db.prepare(`
  INSERT INTO traffic (host, hour, requests, bytes, s2xx, s3xx, s4xx, s5xx, blocked)
  VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(host, hour) DO UPDATE SET
    requests = requests + 1, bytes = bytes + excluded.bytes,
    s2xx = s2xx + excluded.s2xx, s3xx = s3xx + excluded.s3xx,
    s4xx = s4xx + excluded.s4xx, s5xx = s5xx + excluded.s5xx,
    blocked = blocked + excluded.blocked
`);

function ingest(line: string) {
  let entry: {
    ts?: number;
    status?: number;
    size?: number;
    duration?: number;
    request?: { host?: string; method?: string; uri?: string; remote_ip?: string; client_ip?: string; headers?: Record<string, string[]> };
  };
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }
  const req = entry.request ?? {};
  const host = (req.host ?? '').replace(/:\d+$/, '').toLowerCase();
  if (!host) return;
  const status = entry.status ?? 0;
  const ts = entry.ts ?? Date.now() / 1000;
  const hour = Math.floor(ts / 3600) * 3600;
  const blocked = status === 403 || status === 429 ? 1 : 0;
  upsert.run(
    host,
    hour,
    entry.size ?? 0,
    status >= 200 && status < 300 ? 1 : 0,
    status >= 300 && status < 400 ? 1 : 0,
    status >= 400 && status < 500 ? 1 : 0,
    status >= 500 ? 1 : 0,
    blocked,
  );
  recent.push({
    ts,
    host,
    method: req.method ?? '',
    uri: (req.uri ?? '').slice(0, 300),
    status,
    size: entry.size ?? 0,
    duration: entry.duration ?? 0,
    ip: req.client_ip ?? req.remote_ip ?? '',
    ua: (req.headers?.['User-Agent']?.[0] ?? '').slice(0, 200),
  });
  if (recent.length > MAX_RECENT) recent.splice(0, recent.length - MAX_RECENT);
}

let offset = Number(getSetting('analytics_offset') ?? 0);
let busy = false;

async function poll() {
  if (busy) return;
  busy = true;
  try {
    const { size } = await stat(logFile);
    if (size < offset) offset = 0; // log rotated
    if (size === offset) return;
    const fh = await open(logFile, 'r');
    try {
      const length = Math.min(size - offset, 16 * 1024 * 1024);
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, offset);
      const text = buf.toString('utf8');
      const lastNewline = text.lastIndexOf('\n');
      if (lastNewline === -1) return;
      db.exec('BEGIN');
      for (const line of text.slice(0, lastNewline).split('\n')) if (line) ingest(line);
      db.exec('COMMIT');
      offset += Buffer.byteLength(text.slice(0, lastNewline + 1));
      setSetting('analytics_offset', String(offset));
    } finally {
      await fh.close();
    }
  } catch {
    /* log file does not exist yet */
  } finally {
    busy = false;
  }
}

export function startAnalytics() {
  setInterval(poll, 5000).unref();
  // Keep 90 days of hourly stats.
  setInterval(() => {
    db.prepare('DELETE FROM traffic WHERE hour < ?').run(Math.floor(Date.now() / 1000) - 90 * 86400);
  }, 3600_000).unref();
  void poll();
}

export function recentRequests(host?: string, limit = 200) {
  const list = host ? recent.filter((r) => r.host === host || r.host.endsWith(`.${host}`)) : recent;
  return list.slice(-limit).reverse();
}

export function trafficSeries(hours: number, host?: string) {
  const since = Math.floor(Date.now() / 1000 / 3600) * 3600 - (hours - 1) * 3600;
  const where = host ? 'AND (host = ? OR host LIKE ?)' : '';
  const params: (string | number)[] = [since];
  if (host) params.push(host, `%.${host}`);
  const rows = all<{ hour: number; requests: number; bytes: number; s4xx: number; s5xx: number; blocked: number }>(
    `SELECT hour, SUM(requests) requests, SUM(bytes) bytes, SUM(s4xx) s4xx, SUM(s5xx) s5xx, SUM(blocked) blocked
     FROM traffic WHERE hour >= ? ${where} GROUP BY hour ORDER BY hour`,
    ...params,
  );
  const byHour = new Map(rows.map((r) => [r.hour, r]));
  const series = [];
  for (let h = since; h <= since + (hours - 1) * 3600; h += 3600) {
    series.push(byHour.get(h) ?? { hour: h, requests: 0, bytes: 0, s4xx: 0, s5xx: 0, blocked: 0 });
  }
  const topHosts = all<{ host: string; requests: number; bytes: number; blocked: number }>(
    `SELECT host, SUM(requests) requests, SUM(bytes) bytes, SUM(blocked) blocked FROM traffic
     WHERE hour >= ? ${where} GROUP BY host ORDER BY requests DESC LIMIT 10`,
    ...params,
  );
  return { series, topHosts };
}
