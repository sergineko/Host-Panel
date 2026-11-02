export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/')) window.dispatchEvent(new Event('hp:unauthorized'));
    throw new ApiError(res.status, data?.error ?? res.statusText);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

// --- shared types -------------------------------------------------------------------

export interface Domain {
  id: number;
  name: string;
  dns_enabled: number;
  mail_enabled: number;
  created_at: string;
  sites?: number;
}

export interface DnsRecord {
  name: string;
  type: string;
  ttl: number;
  content: string;
  disabled: boolean;
}

export type SiteType = 'static' | 'php' | 'node';

export interface Site {
  id: number;
  name: string;
  domain_id: number | null;
  hostnames: string[];
  type: SiteType;
  spa: boolean;
  repo_url: string;
  branch: string;
  has_repo_token: boolean;
  install_command: string;
  build_command: string;
  output_dir: string;
  start_command: string;
  env: Record<string, string>;
  memory_mb: number;
  webhook_secret: string;
  webhook_path: string;
  auto_deploy: boolean;
  status: string;
  active_slot: number;
  active_release: string;
  port: number | null;
  php_version: string;
  php_effective: string | null;
  server_ids: number[];
  lb_policy: string;
  source: 'git' | 'wordpress';
  wordpress: {
    db_name: string;
    database_id: number;
    title: string;
    admin_user: string;
    admin_email: string;
    locale: string;
    site_url: string;
    admin_url: string;
  } | null;
  created_at: string;
  releases?: string[];
  last_deployment?: { id: number; status: string; commit_sha: string; commit_message: string; created_at: string } | null;
}

export interface Deployment {
  id: number;
  site_id: number;
  trigger: string;
  release: string;
  commit_sha: string;
  commit_message: string;
  status: 'queued' | 'running' | 'success' | 'failed';
  log?: string;
  created_at: string;
  finished_at: string | null;
}

export interface ProxyRoute {
  id: number;
  hostname: string;
  path_prefix: string;
  strip_prefix: boolean;
  upstreams: string[];
  lb_policy: string;
  preserve_host: boolean;
  tls_skip_verify: boolean;
  enabled: boolean;
  note: string;
}

export interface Redirect {
  id: number;
  hostname: string;
  path: string;
  target: string;
  code: number;
  preserve_path: boolean;
  enabled: boolean;
}

export interface IpRule {
  id: number;
  domain_id: number | null;
  cidr: string;
  action: 'allow' | 'block';
  note: string;
  created_at: string;
}

export interface Security {
  waf_mode: 'off' | 'detect' | 'block';
  paranoia: number;
  rate_limit_rpm: number;
  block_bots: number;
  under_attack: number;
  security_headers: number;
  hsts: number;
  compression: number;
  block_sensitive: number;
  hotlink: number;
  max_body_mb: number;
  cache_static: number;
  cache_ttl: number;
  ip_rules: IpRule[];
}

export interface Mailbox {
  email: string;
  name: string;
  aliases: string[];
  quotaMb: number;
  usedMb: number;
}

export interface TrafficPoint {
  hour: number;
  requests: number;
  bytes: number;
  s4xx: number;
  s5xx: number;
  blocked: number;
}

/** Uploads a file/blob with a raw PUT (or POST) body, reporting progress (0-1). */
export function upload<T>(path: string, body: Blob, onProgress?: (p: number) => void, method = 'PUT'): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, path);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', body.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data: { error?: string } | undefined;
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : undefined;
      } catch {
        data = undefined;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
      else reject(new ApiError(xhr.status, data?.error ?? xhr.statusText));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Error de red'));
    xhr.send(body);
  });
}

// --- new modules ----------------------------------------------------------------------

export interface Job {
  id: number;
  kind: string;
  title: string;
  status: 'running' | 'success' | 'failed';
  log?: string;
  created_by: string;
  created_at: string;
  finished_at: string | null;
}

export interface ServerInfo {
  hostname?: string;
  os?: string;
  cpus?: number;
  mem_total?: number;
  mem_free?: number;
  disk_total?: number;
  disk_free?: number;
  load?: string;
  php?: string[];
  node?: string;
  caddy?: string;
}

export interface ServerNode {
  id: number;
  name: string;
  host: string;
  ssh_port?: number;
  ssh_user?: string;
  status: 'pending' | 'online' | 'offline';
  info: ServerInfo;
  last_error?: string;
  last_check?: string | null;
  sites: { id: number; name: string }[];
}

export interface Bucket {
  id: number;
  name: string;
  public: boolean;
  hostname: string;
  cors_origins: string;
  cache_ttl: number;
  public_url: string | null;
  api_url: string;
  usage?: { size: number; count: number };
  created_at: string;
}

export interface ObjectEntry {
  key: string;
  size: number;
  modified: string;
  type: string;
}

export interface ApiToken {
  id: number;
  name: string;
  prefix: string;
  can_write: boolean;
  last_used: string | null;
  created_at: string;
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  affectedRows: number;
  insertId: number | null;
  durationMs: number;
  truncated: boolean;
}

export interface DatabaseInfo {
  id: number;
  name: string;
  username: string;
  note: string;
  size: number;
  has_password: boolean;
  remote_hosts: string[];
  created_at: string;
  api_url?: string;
  host?: string;
}

// --- Workers, Queues, KV ----------------------------------------------------------------

export type BindingType = 'd1' | 'kv' | 'r2' | 'queue';

export interface Worker {
  id: number;
  name: string;
  version: number;
  status: 'new' | 'running' | 'error' | 'stopped';
  last_error: string;
  enabled: boolean;
  subdomain: boolean;
  routes: string[];
  crons: { cron: string; next: string[] }[];
  vars: Record<string, string>;
  secrets: string[];
  bindings: { type: BindingType; name: string; id: number; resource: string }[];
  memory_mb: number;
  url: string | null;
  port: number;
  consumes: { id: number; name: string }[];
  deployed_at: string | null;
  created_at: string;
  code?: string;
  requests_24h?: number;
  errors_24h?: number;
}

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

export interface DeployResult {
  ok: boolean;
  error?: string;
  version?: number;
  stage?: 'syntax' | 'start' | 'done';
}

export interface Queue {
  id: number;
  name: string;
  consumer_worker_id: number | null;
  max_batch_size: number;
  max_batch_timeout: number;
  max_retries: number;
  retry_delay: number;
  dead_letter_queue_id: number | null;
  delivery_paused: boolean;
  consumer: { id: number; name: string; status: string } | null;
  dead_letter_queue: { id: number; name: string } | null;
  producers: { id: number; name: string }[];
  backlog: { total: number; ready: number; delayed: number; inflight: number; oldest: number | null };
  totals_24h: { sent: number; acked: number; retried: number; dead: number };
  api_url: string;
  created_at: string;
  stats?: { hour: number; sent: number; delivered: number; acked: number; retried: number; dead: number }[];
}

export interface KvNamespace {
  id: number;
  name: string;
  keys: number;
  size: number;
  workers: { id: number; name: string }[];
  created_at: string;
}
