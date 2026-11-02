import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.ts';

mkdirSync(config.dataDir, { recursive: true });

export const db = new DatabaseSync(join(config.dataDir, 'hostpanel.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const migrations: string[] = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    ip TEXT,
    user_agent TEXT
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE domains (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    dns_enabled INTEGER NOT NULL DEFAULT 1,
    mail_enabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE sites (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    domain_id INTEGER REFERENCES domains(id) ON DELETE SET NULL,
    hostnames TEXT NOT NULL DEFAULT '[]',
    type TEXT NOT NULL CHECK (type IN ('static','php','node')),
    spa INTEGER NOT NULL DEFAULT 0,
    repo_url TEXT NOT NULL DEFAULT '',
    branch TEXT NOT NULL DEFAULT 'main',
    repo_token TEXT NOT NULL DEFAULT '',
    install_command TEXT NOT NULL DEFAULT '',
    build_command TEXT NOT NULL DEFAULT '',
    output_dir TEXT NOT NULL DEFAULT '',
    start_command TEXT NOT NULL DEFAULT '',
    env TEXT NOT NULL DEFAULT '{}',
    memory_mb INTEGER NOT NULL DEFAULT 512,
    webhook_secret TEXT NOT NULL,
    auto_deploy INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'new',
    active_slot INTEGER NOT NULL DEFAULT 0,
    active_release TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE deployments (
    id INTEGER PRIMARY KEY,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    trigger TEXT NOT NULL,
    release TEXT NOT NULL DEFAULT '',
    commit_sha TEXT NOT NULL DEFAULT '',
    commit_message TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'queued',
    log TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT
  );
  CREATE INDEX deployments_site ON deployments(site_id, id DESC);
  CREATE TABLE proxy_routes (
    id INTEGER PRIMARY KEY,
    hostname TEXT NOT NULL,
    path_prefix TEXT NOT NULL DEFAULT '',
    strip_prefix INTEGER NOT NULL DEFAULT 0,
    upstreams TEXT NOT NULL DEFAULT '[]',
    lb_policy TEXT NOT NULL DEFAULT 'round_robin',
    preserve_host INTEGER NOT NULL DEFAULT 1,
    tls_skip_verify INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE redirects (
    id INTEGER PRIMARY KEY,
    hostname TEXT NOT NULL,
    path TEXT NOT NULL DEFAULT '',
    target TEXT NOT NULL,
    code INTEGER NOT NULL DEFAULT 301,
    preserve_path INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE security (
    domain_id INTEGER PRIMARY KEY REFERENCES domains(id) ON DELETE CASCADE,
    waf_mode TEXT NOT NULL DEFAULT 'block' CHECK (waf_mode IN ('off','detect','block')),
    paranoia INTEGER NOT NULL DEFAULT 1,
    rate_limit_rpm INTEGER NOT NULL DEFAULT 600,
    block_bots INTEGER NOT NULL DEFAULT 1,
    under_attack INTEGER NOT NULL DEFAULT 0,
    under_attack_token TEXT NOT NULL DEFAULT '',
    security_headers INTEGER NOT NULL DEFAULT 1,
    hsts INTEGER NOT NULL DEFAULT 0,
    compression INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE ip_rules (
    id INTEGER PRIMARY KEY,
    domain_id INTEGER REFERENCES domains(id) ON DELETE CASCADE,
    cidr TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('allow','block')),
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE databases (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE audit (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE traffic (
    host TEXT NOT NULL,
    hour INTEGER NOT NULL,
    requests INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0,
    s2xx INTEGER NOT NULL DEFAULT 0,
    s3xx INTEGER NOT NULL DEFAULT 0,
    s4xx INTEGER NOT NULL DEFAULT 0,
    s5xx INTEGER NOT NULL DEFAULT 0,
    blocked INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (host, hour)
  );
  `,
];

const { user_version: current } = db.prepare('PRAGMA user_version').get() as { user_version: number };
for (let i = current; i < migrations.length; i++) {
  db.exec('BEGIN');
  try {
    db.exec(migrations[i]!);
    db.exec(`PRAGMA user_version = ${i + 1}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// --- small typed helpers -------------------------------------------------------------
type Param = string | number | bigint | null | Uint8Array;

export function all<T>(sql: string, ...params: Param[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}
export function get<T>(sql: string, ...params: Param[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}
export function run(sql: string, ...params: Param[]) {
  const r = db.prepare(sql).run(...params);
  return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
}

export function getSetting(key: string): string | undefined {
  return get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)?.value;
}
export function setSetting(key: string, value: string) {
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
}

export function audit(username: string, action: string, target = '', ip = '') {
  run('INSERT INTO audit (username, action, target, ip) VALUES (?, ?, ?, ?)', username, action, target, ip);
}

// --- row types -----------------------------------------------------------------------
export interface DomainRow {
  id: number;
  name: string;
  dns_enabled: number;
  mail_enabled: number;
  created_at: string;
}
export interface SiteRow {
  id: number;
  name: string;
  domain_id: number | null;
  hostnames: string;
  type: 'static' | 'php' | 'node';
  spa: number;
  repo_url: string;
  branch: string;
  repo_token: string;
  install_command: string;
  build_command: string;
  output_dir: string;
  start_command: string;
  env: string;
  memory_mb: number;
  webhook_secret: string;
  auto_deploy: number;
  status: string;
  active_slot: number;
  active_release: string;
  created_at: string;
}
export interface DeploymentRow {
  id: number;
  site_id: number;
  trigger: string;
  release: string;
  commit_sha: string;
  commit_message: string;
  status: string;
  log: string;
  created_at: string;
  finished_at: string | null;
}
export interface ProxyRouteRow {
  id: number;
  hostname: string;
  path_prefix: string;
  strip_prefix: number;
  upstreams: string;
  lb_policy: string;
  preserve_host: number;
  tls_skip_verify: number;
  enabled: number;
  note: string;
}
export interface RedirectRow {
  id: number;
  hostname: string;
  path: string;
  target: string;
  code: number;
  preserve_path: number;
  enabled: number;
}
export interface SecurityRow {
  domain_id: number;
  waf_mode: 'off' | 'detect' | 'block';
  paranoia: number;
  rate_limit_rpm: number;
  block_bots: number;
  under_attack: number;
  under_attack_token: string;
  security_headers: number;
  hsts: number;
  compression: number;
}
export interface IpRuleRow {
  id: number;
  domain_id: number | null;
  cidr: string;
  action: 'allow' | 'block';
  note: string;
}
