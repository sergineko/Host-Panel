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
