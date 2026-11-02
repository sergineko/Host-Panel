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
  `
  ALTER TABLE users ADD COLUMN totp_secret TEXT NOT NULL DEFAULT '';
  ALTER TABLE sites ADD COLUMN php_version TEXT NOT NULL DEFAULT '';
  ALTER TABLE sites ADD COLUMN server_ids TEXT NOT NULL DEFAULT '[0]';
  ALTER TABLE sites ADD COLUMN lb_policy TEXT NOT NULL DEFAULT 'round_robin';
  ALTER TABLE databases ADD COLUMN password_enc TEXT NOT NULL DEFAULT '';
  ALTER TABLE databases ADD COLUMN remote_hosts TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE security ADD COLUMN block_sensitive INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE security ADD COLUMN hotlink INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE security ADD COLUMN max_body_mb INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE security ADD COLUMN cache_static INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE security ADD COLUMN cache_ttl INTEGER NOT NULL DEFAULT 604800;
  CREATE TABLE servers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    host TEXT NOT NULL UNIQUE,
    ssh_port INTEGER NOT NULL DEFAULT 22,
    ssh_user TEXT NOT NULL DEFAULT 'root',
    status TEXT NOT NULL DEFAULT 'pending',
    info TEXT NOT NULL DEFAULT '{}',
    last_error TEXT NOT NULL DEFAULT '',
    last_check TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    log TEXT NOT NULL DEFAULT '',
    log_file TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT
  );
  CREATE TABLE buckets (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    public INTEGER NOT NULL DEFAULT 0,
    hostname TEXT NOT NULL DEFAULT '',
    cors_origins TEXT NOT NULL DEFAULT '',
    cache_ttl INTEGER NOT NULL DEFAULT 86400,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE api_tokens (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    scope_type TEXT NOT NULL CHECK (scope_type IN ('bucket','database')),
    scope_id INTEGER NOT NULL,
    can_write INTEGER NOT NULL DEFAULT 0,
    last_used TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  `
  ALTER TABLE sites ADD COLUMN source TEXT NOT NULL DEFAULT 'git';
  ALTER TABLE sites ADD COLUMN app TEXT NOT NULL DEFAULT '{}';
  `,
  `
  CREATE TABLE workers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    code TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 0,
    routes TEXT NOT NULL DEFAULT '[]',
    subdomain INTEGER NOT NULL DEFAULT 1,
    crons TEXT NOT NULL DEFAULT '[]',
    vars TEXT NOT NULL DEFAULT '{}',
    secrets TEXT NOT NULL DEFAULT '{}',
    bindings TEXT NOT NULL DEFAULT '[]',
    memory_mb INTEGER NOT NULL DEFAULT 128,
    token TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'new',
    last_error TEXT NOT NULL DEFAULT '',
    deployed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE worker_versions (
    id INTEGER PRIMARY KEY,
    worker_id INTEGER NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    code TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX worker_versions_worker ON worker_versions(worker_id, version DESC);
  CREATE TABLE worker_metrics (
    worker_id INTEGER NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
    hour INTEGER NOT NULL,
    requests INTEGER NOT NULL DEFAULT 0,
    errors INTEGER NOT NULL DEFAULT 0,
    duration_ms REAL NOT NULL DEFAULT 0,
    queue_messages INTEGER NOT NULL DEFAULT 0,
    cron_runs INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (worker_id, hour)
  );
  CREATE TABLE kv_namespaces (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE kv_entries (
    namespace_id INTEGER NOT NULL REFERENCES kv_namespaces(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value BLOB NOT NULL,
    metadata TEXT,
    expires_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (namespace_id, key)
  );
  CREATE TABLE queues (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    consumer_worker_id INTEGER REFERENCES workers(id) ON DELETE SET NULL,
    max_batch_size INTEGER NOT NULL DEFAULT 10,
    max_batch_timeout INTEGER NOT NULL DEFAULT 5,
    max_retries INTEGER NOT NULL DEFAULT 3,
    retry_delay INTEGER NOT NULL DEFAULT 0,
    dead_letter_queue_id INTEGER REFERENCES queues(id) ON DELETE SET NULL,
    delivery_paused INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE queue_messages (
    id INTEGER PRIMARY KEY,
    queue_id INTEGER NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'json',
    attempts INTEGER NOT NULL DEFAULT 0,
    visible_at INTEGER NOT NULL,
    lease_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX queue_messages_ready ON queue_messages(queue_id, visible_at, id);
  CREATE TABLE queue_stats (
    queue_id INTEGER NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
    hour INTEGER NOT NULL,
    sent INTEGER NOT NULL DEFAULT 0,
    delivered INTEGER NOT NULL DEFAULT 0,
    acked INTEGER NOT NULL DEFAULT 0,
    retried INTEGER NOT NULL DEFAULT 0,
    dead INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (queue_id, hour)
  );
  -- API tokens can now also be scoped to a queue (CHECK constraints can't be altered).
  CREATE TABLE api_tokens_new (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    scope_type TEXT NOT NULL CHECK (scope_type IN ('bucket','database','queue')),
    scope_id INTEGER NOT NULL,
    can_write INTEGER NOT NULL DEFAULT 0,
    last_used TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT INTO api_tokens_new SELECT * FROM api_tokens;
  DROP TABLE api_tokens;
  ALTER TABLE api_tokens_new RENAME TO api_tokens;
  `,
  `
  -- Document (NoSQL) databases: each one is its own file under <dataDir>/nosql.
  CREATE TABLE nosql_databases (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- Load balancers: hostnames → pool of origins with health checks.
  CREATE TABLE load_balancers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    hostnames TEXT NOT NULL DEFAULT '[]',
    path_prefix TEXT NOT NULL DEFAULT '',
    origins TEXT NOT NULL DEFAULT '[]',
    policy TEXT NOT NULL DEFAULT 'round_robin',
    sticky_cookie TEXT NOT NULL DEFAULT '',
    health_enabled INTEGER NOT NULL DEFAULT 1,
    health_path TEXT NOT NULL DEFAULT '/',
    health_interval INTEGER NOT NULL DEFAULT 10,
    health_timeout INTEGER NOT NULL DEFAULT 5,
    health_status INTEGER NOT NULL DEFAULT 200,
    max_fails INTEGER NOT NULL DEFAULT 3,
    fail_duration INTEGER NOT NULL DEFAULT 30,
    retries INTEGER NOT NULL DEFAULT 2,
    preserve_host INTEGER NOT NULL DEFAULT 1,
    tls_skip_verify INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- Node.js version per site: 'latest', 'system', '22' (newest 22.x) or '22.11.0'.
  ALTER TABLE sites ADD COLUMN node_version TEXT NOT NULL DEFAULT 'latest';
  -- Neutral binding names (sql = MariaDB, bucket = object storage).
  UPDATE workers SET bindings = replace(replace(bindings, '"type":"d1"', '"type":"sql"'), '"type":"r2"', '"type":"bucket"');
  -- API tokens can also be scoped to a document database.
  CREATE TABLE api_tokens_new (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    scope_type TEXT NOT NULL CHECK (scope_type IN ('bucket','database','queue','nosql')),
    scope_id INTEGER NOT NULL,
    can_write INTEGER NOT NULL DEFAULT 0,
    last_used TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT INTO api_tokens_new SELECT * FROM api_tokens;
  DROP TABLE api_tokens;
  ALTER TABLE api_tokens_new RENAME TO api_tokens;
  `,
  `
  -- Per-site PHP settings (memory_limit, upload size…) as JSON.
  ALTER TABLE sites ADD COLUMN php_settings TEXT NOT NULL DEFAULT '{}';
  -- Automatic backups: 'off', 'daily' or 'weekly', keeping the newest N.
  ALTER TABLE sites ADD COLUMN backup_schedule TEXT NOT NULL DEFAULT 'off';
  ALTER TABLE sites ADD COLUMN backup_keep INTEGER NOT NULL DEFAULT 7;
  -- SQL databases saved with the site's files (WordPress adds its own automatically).
  ALTER TABLE sites ADD COLUMN backup_databases TEXT NOT NULL DEFAULT '[]';
  CREATE TABLE backups (
    id INTEGER PRIMARY KEY,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    file TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL DEFAULT 'manual',
    status TEXT NOT NULL DEFAULT 'running',
    includes TEXT NOT NULL DEFAULT '[]',
    note TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT
  );
  CREATE INDEX backups_site ON backups(site_id, id);
  -- Scheduled commands run as the site user (like cPanel cron jobs).
  CREATE TABLE site_crons (
    id INTEGER PRIMARY KEY,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    schedule TEXT NOT NULL,
    command TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run TEXT,
    last_status TEXT NOT NULL DEFAULT '',
    last_duration INTEGER NOT NULL DEFAULT 0,
    last_output TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  php_version: string;
  server_ids: string;
  lb_policy: string;
  /** 'latest', 'system', a major ('22') or an exact version ('22.11.0'). */
  node_version: string;
  /** 'git' (repository deploys) or 'wordpress' (one-click install). */
  source: 'git' | 'wordpress';
  /** App metadata as JSON (WordPress: database, admin user, locale…). */
  app: string;
  php_settings: string;
  backup_schedule: 'off' | 'daily' | 'weekly';
  backup_keep: number;
  backup_databases: string;
  created_at: string;
}
export interface BackupRow {
  id: number;
  site_id: number;
  file: string;
  size: number;
  kind: 'manual' | 'auto' | 'pre-restore';
  status: 'running' | 'success' | 'failed';
  includes: string;
  note: string;
  error: string;
  created_at: string;
  finished_at: string | null;
}
export interface SiteCronRow {
  id: number;
  site_id: number;
  schedule: string;
  command: string;
  note: string;
  enabled: number;
  last_run: string | null;
  last_status: '' | 'success' | 'failed' | 'running';
  last_duration: number;
  last_output: string;
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
  block_sensitive: number;
  hotlink: number;
  max_body_mb: number;
  cache_static: number;
  cache_ttl: number;
}
export interface IpRuleRow {
  id: number;
  domain_id: number | null;
  cidr: string;
  action: 'allow' | 'block';
  note: string;
}
export interface ServerRow {
  id: number;
  name: string;
  host: string;
  ssh_port: number;
  ssh_user: string;
  status: 'pending' | 'online' | 'offline';
  info: string;
  last_error: string;
  last_check: string | null;
  created_at: string;
}
export interface JobRow {
  id: number;
  kind: string;
  title: string;
  status: 'running' | 'success' | 'failed';
  log: string;
  log_file: string;
  created_by: string;
  created_at: string;
  finished_at: string | null;
}
export interface BucketRow {
  id: number;
  name: string;
  public: number;
  hostname: string;
  cors_origins: string;
  cache_ttl: number;
  created_at: string;
}
export interface DatabaseRow {
  id: number;
  name: string;
  username: string;
  note: string;
  password_enc: string;
  remote_hosts: string;
  created_at: string;
}
export interface ApiTokenRow {
  id: number;
  name: string;
  token_hash: string;
  prefix: string;
  scope_type: 'bucket' | 'database' | 'queue' | 'nosql';
  scope_id: number;
  can_write: number;
  last_used: string | null;
  created_at: string;
}
export interface WorkerRow {
  id: number;
  name: string;
  code: string;
  version: number;
  routes: string;
  subdomain: number;
  crons: string;
  vars: string;
  secrets: string;
  bindings: string;
  memory_mb: number;
  token: string;
  enabled: number;
  status: 'new' | 'running' | 'error' | 'stopped';
  last_error: string;
  deployed_at: string | null;
  created_at: string;
}
export interface QueueRow {
  id: number;
  name: string;
  consumer_worker_id: number | null;
  max_batch_size: number;
  max_batch_timeout: number;
  max_retries: number;
  retry_delay: number;
  dead_letter_queue_id: number | null;
  delivery_paused: number;
  created_at: string;
}
export interface QueueMessageRow {
  id: number;
  queue_id: number;
  body: string;
  content_type: string;
  attempts: number;
  visible_at: number;
  lease_id: string | null;
  created_at: number;
}
export interface NosqlDatabaseRow {
  id: number;
  name: string;
  note: string;
  created_at: string;
}
export interface LoadBalancerRow {
  id: number;
  name: string;
  hostnames: string;
  path_prefix: string;
  origins: string;
  policy: string;
  sticky_cookie: string;
  health_enabled: number;
  health_path: string;
  health_interval: number;
  health_timeout: number;
  health_status: number;
  max_fails: number;
  fail_duration: number;
  retries: number;
  preserve_host: number;
  tls_skip_verify: number;
  enabled: number;
  note: string;
  created_at: string;
}
