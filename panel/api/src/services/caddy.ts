/**
 * Builds the complete Caddy JSON configuration from the panel database and loads it
 * through Caddy's admin API. Caddy validates the config before applying it, so a bad
 * config never replaces a working one.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { dirname, join } from 'node:path';
import { config } from '../config.ts';
import {
  all,
  getSetting,
  type BucketRow,
  type DomainRow,
  type ServerRow,
  type WorkerRow,
  type IpRuleRow,
  type LoadBalancerRow,
  type ProtectedPathRow,
  type ProxyRouteRow,
  type RedirectRow,
  type SecurityRow,
  type SiteRow,
} from '../db.ts';
import { matchDomain } from '../lib/validate.ts';
import { protectedPathRoutes } from './protectedpaths.ts';
import { nodePort, phpSocket, sitePaths } from './system.ts';
import { HEALTH_PATH, LOCAL_SERVER_ID, NODE_PORT, nodeUpstream, siteIsLocalOnly, siteServerIds, type NodeInfo } from './servers.ts';
import { bucketDir } from './storage.ts';
import { WP_BLOCKED_PATHS } from './wordpress.ts';
import { workerHostname, workerPort, workerRoutes } from './workers.ts';

type Json = Record<string, unknown>;
interface Route {
  match?: Json[];
  handle: Json[];
  terminal?: boolean;
}

const ACCESS_LOGGER = 'hostpanel';
const BAD_BOTS =
  '(?i)(sqlmap|nikto|nmap|masscan|zgrab|nuclei|acunetix|wpscan|dirbuster|gobuster|feroxbuster|ffuf|wfuzz|netsparker|havij|jorgee|zmeu|censysinspect|petalbot|mj12bot|dotbot|semrushbot|ahrefsbot)';

export const DEFAULT_SECURITY: Omit<SecurityRow, 'domain_id'> = {
  waf_mode: 'block',
  paranoia: 1,
  rate_limit_rpm: 600,
  block_bots: 1,
  under_attack: 0,
  under_attack_token: '',
  security_headers: 1,
  hsts: 0,
  compression: 1,
  block_sensitive: 1,
  hotlink: 0,
  max_body_mb: 0,
  cache_static: 1,
  cache_ttl: 604800,
};

const LOCAL_ORIGIN = `127.0.0.1:${NODE_PORT}`;
const SENSITIVE_PATHS = [
  '/.git', '/.git/*', '/.svn/*', '/.hg/*', '/.env', '/.env.*', '/.DS_Store', '/.htpasswd', '/.htaccess',
  '*/.git/*', '*/.env', '/composer.json', '/composer.lock', '/package.json', '/package-lock.json',
  '/wp-config.php.bak', '/wp-config.php~', '*.sql', '*.sql.gz', '*.bak', '*.old', '*.swp', '/phpinfo.php',
];
const STATIC_EXTENSIONS = ['*.css', '*.js', '*.mjs', '*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.avif', '*.svg', '*.ico', '*.woff', '*.woff2', '*.ttf', '*.otf', '*.mp4', '*.webm', '*.mp3', '*.pdf'];
const IMAGE_EXTENSIONS = ['*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.avif', '*.svg'];
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// --- security layer (WAF, rate limit, IP rules, bots, challenge) ---------------------

function underAttackPage(token: string) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Comprobando tu navegador…</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#0b0d12;color:#e6e8ee}main{text-align:center;max-width:420px;padding:24px}.s{width:36px;height:36px;border:3px solid #2a3040;border-top-color:#f6821f;border-radius:50%;animation:r 1s linear infinite;margin:0 auto 20px}@keyframes r{to{transform:rotate(360deg)}}p{color:#9aa3b5;font-size:14px}</style></head>
<body><main><div class="s"></div><h1 style="font-size:20px">Comprobando que eres humano</h1><p>Este sitio está protegido. Serás redirigido en unos segundos.</p><noscript><p>Necesitas JavaScript activado.</p></noscript></main>
<script>setTimeout(function(){var t=${JSON.stringify(token)}.split('').reverse().join('');document.cookie='hp_clear='+t+';path=/;max-age=86400;SameSite=Lax;Secure';location.reload()},2500)</script></body></html>`;
}

function wafDirectives(sec: SecurityRow) {
  const engine = sec.waf_mode === 'block' ? 'On' : 'DetectionOnly';
  const pl = Math.min(4, Math.max(1, sec.paranoia));
  return [
    'Include @coraza.conf-recommended',
    `SecRuleEngine ${engine}`,
    'SecResponseBodyAccess Off',
    'SecRequestBodyLimit 67108864',
    'Include @crs-setup.conf.example',
    `SecAction "id:900000,phase:1,pass,t:none,nolog,setvar:tx.blocking_paranoia_level=${pl}"`,
    'Include @owasp_crs/*.conf',
  ].join('\n');
}

function securityRoutes(domain: DomainRow | undefined, sec: SecurityRow, rules: IpRuleRow[]): Route[] {
  const scoped = rules.filter((r) => r.domain_id === null || (domain && r.domain_id === domain.id));
  const allow = scoped.filter((r) => r.action === 'allow').map((r) => r.cidr);
  const block = scoped.filter((r) => r.action === 'block').map((r) => r.cidr);
  const forbidden = (body: string) => ({ handler: 'static_response', status_code: 403, body });

  const checks: Route[] = [];
  if (sec.block_sensitive) {
    checks.push({ match: [{ path: SENSITIVE_PATHS }], handle: [{ handler: 'static_response', status_code: 404, body: 'No encontrado' }] });
  }
  if (sec.max_body_mb > 0) {
    checks.push({ handle: [{ handler: 'request_body', max_size: sec.max_body_mb * 1024 * 1024 }] });
  }
  if (block.length) checks.push({ match: [{ remote_ip: { ranges: block } }], handle: [forbidden('Acceso denegado (IP bloqueada)')] });
  if (sec.block_bots) {
    checks.push({ match: [{ header_regexp: { 'User-Agent': { pattern: BAD_BOTS } } }], handle: [forbidden('Acceso denegado')] });
  }
  if (sec.under_attack && sec.under_attack_token) {
    const cookieValue = sec.under_attack_token;
    const reversed = cookieValue.split('').reverse().join('');
    checks.push({
      match: [{ not: [{ header: { Cookie: [`*hp_clear=${cookieValue}*`] } }] }],
      handle: [
        {
          handler: 'static_response',
          status_code: 503,
          headers: { 'Content-Type': ['text/html; charset=utf-8'], 'Cache-Control': ['no-store'], 'Retry-After': ['5'] },
          body: underAttackPage(reversed),
        },
      ],
    });
  }
  if (sec.hotlink && domain) {
    // Images may only be embedded from the domain itself (or opened directly).
    checks.push({
      match: [
        {
          path: IMAGE_EXTENSIONS,
          header_regexp: { Referer: { pattern: '^https?://' } },
          not: [{ header_regexp: { Referer: { pattern: String.raw`^https?://([a-z0-9-]+\.)*` + escapeRegex(domain.name) + String.raw`(:\d+)?(/|$)` } } }],
        },
      ],
      handle: [forbidden('Hotlinking no permitido')],
    });
  }
  if (sec.rate_limit_rpm > 0) {
    checks.push({
      handle: [
        {
          handler: 'rate_limit',
          rate_limits: {
            [`zone_${domain?.id ?? 0}`]: {
              key: '{http.request.remote.host}',
              window: '1m',
              max_events: sec.rate_limit_rpm,
            },
          },
        },
      ],
    });
  }
  if (sec.waf_mode !== 'off') {
    checks.push({ handle: [{ handler: 'waf', load_owasp_crs: true, directives: wafDirectives(sec) }] });
  }
  if (!checks.length) return [];
  // Allow-listed IPs skip every check (like Cloudflare's "allow" IP access rule).
  if (allow.length) {
    return [{ match: [{ not: [{ remote_ip: { ranges: allow } }] }], handle: [{ handler: 'subroute', routes: checks }] }];
  }
  return checks;
}

function responseHeaders(sec: SecurityRow): Route[] {
  const set: Record<string, string[]> = {};
  if (sec.security_headers) {
    set['X-Content-Type-Options'] = ['nosniff'];
    set['X-Frame-Options'] = ['SAMEORIGIN'];
    set['Referrer-Policy'] = ['strict-origin-when-cross-origin'];
    set['Permissions-Policy'] = ['interest-cohort=()'];
  }
  if (sec.hsts) set['Strict-Transport-Security'] = ['max-age=31536000; includeSubDomains'];
  const routes: Route[] = [
    { handle: [{ handler: 'headers', response: { set, delete: ['Server', 'X-Powered-By'], deferred: true } }] },
  ];
  if (sec.cache_static && sec.cache_ttl > 0) {
    // Browser cache for static assets, only when the app did not set its own policy.
    routes.push({
      match: [{ path: STATIC_EXTENSIONS }],
      handle: [
        {
          handler: 'headers',
          response: {
            set: { 'Cache-Control': [`public, max-age=${sec.cache_ttl}`] },
            require: { headers: { 'Cache-Control': null } },
            deferred: true,
          },
        },
      ],
    });
  }
  if (sec.compression) {
    routes.push({
      handle: [{ handler: 'encode', encodings: { zstd: {}, gzip: {} }, prefer: ['zstd', 'gzip'], minimum_length: 512 }],
    });
  }
  return routes;
}

// --- content handlers ----------------------------------------------------------------

function staticSiteRoutes(root: string, spa: boolean): Route[] {
  const routes: Route[] = [];
  if (spa) {
    routes.push({
      match: [{ file: { root, try_files: ['{http.request.uri.path}', '{http.request.uri.path}/', '/index.html'] } }],
      handle: [{ handler: 'rewrite', uri: '{http.matchers.file.relative}' }],
    });
  }
  routes.push({ handle: [{ handler: 'file_server', root, hide: ['.git', '.env', '.htaccess'] }] });
  return routes;
}

export function phpRoutes(root: string, socket: string): Route[] {
  return [
    {
      match: [{ path: ['/.git/*', '/.env', '/.env.*', '*/.ht*'] }],
      handle: [{ handler: 'static_response', status_code: 404 }],
    },
    {
      match: [
        {
          file: {
            root,
            try_files: ['{http.request.uri.path}', '{http.request.uri.path}/index.php', '/index.php'],
            split_path: ['.php'],
          },
        },
      ],
      handle: [{ handler: 'rewrite', uri: '{http.matchers.file.relative}' }],
    },
    {
      match: [{ path: ['*.php'] }],
      handle: [
        {
          handler: 'reverse_proxy',
          transport: { protocol: 'fastcgi', root, split_path: ['.php'], read_timeout: '300s' },
          upstreams: [{ dial: `unix/${socket}` }],
        },
      ],
    },
    { handle: [{ handler: 'file_server', root, hide: ['.git', '.env', '.htaccess'] }] },
  ];
}

const comingSoon = (): Route[] => [
  {
    handle: [
      {
        handler: 'static_response',
        status_code: 200,
        headers: { 'Content-Type': ['text/html; charset=utf-8'] },
        body: '<!doctype html><meta charset="utf-8"><title>Próximamente</title><body style="font-family:system-ui;display:grid;place-items:center;min-height:90vh;color:#555"><h1>Sitio en preparación</h1></body>',
      },
    ],
  },
];

/** How a server (this one or a node) serves the site's files or app. */
export function siteContentRoutes(site: SiteRow): Route[] {
  const current = sitePaths(site.id).current;
  if (site.type === 'node') {
    return [{ handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: `127.0.0.1:${nodePort(site.id, site.active_slot)}` }] }] }];
  }
  if (site.type === 'php') {
    const routes = phpRoutes(current, phpSocket(site.id));
    if (site.source === 'wordpress') {
      routes.unshift({ match: [{ path: WP_BLOCKED_PATHS }], handle: [{ handler: 'static_response', status_code: 404 }] });
    }
    return routes;
  }
  return staticSiteRoutes(current, !!site.spa);
}

/**
 * Content routes for a remote node's Caddy: the same protected paths are checked there too,
 * so reaching the node directly (port 8443) does not skip them.
 */
export function nodeSiteRoutes(site: SiteRow): Route[] {
  const rows = all<ProtectedPathRow>('SELECT * FROM protected_paths WHERE site_id = ? ORDER BY id', site.id);
  return [...protectedPathRoutes(rows), ...siteContentRoutes(site)];
}

/** PEM certificates → base64 DER, as Caddy's inline CA pool expects. */
function pemToDer(pem: string) {
  return [...pem.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/g)].map((m) => m[1]!.replace(/\s+/g, ''));
}

function localCaPem() {
  const path = join(config.caddyDataDir, 'pki', 'authorities', 'local', 'root.crt');
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  } catch {
    return '';
  }
}

/** Site spread over several servers: load-balance from this Caddy to each origin. */
function balancedSiteRoutes(site: SiteRow, servers: ServerRow[]): Route[] {
  const ids = siteServerIds(site);
  const upstreams: Json[] = [];
  const cas: string[] = [];
  let verifiable = true;
  if (ids.includes(LOCAL_SERVER_ID)) {
    upstreams.push({ dial: LOCAL_ORIGIN });
    const local = pemToDer(localCaPem());
    if (!local.length) verifiable = false;
    cas.push(...local);
  }
  for (const s of servers.filter((x) => ids.includes(x.id))) {
    upstreams.push({ dial: nodeUpstream(s) });
    const info = JSON.parse(s.info || '{}') as NodeInfo;
    const ca = pemToDer(info.ca ?? '');
    if (!ca.length) verifiable = false;
    cas.push(...ca);
  }
  if (!upstreams.length) return comingSoon();
  // Verify each origin against its internal CA when known; otherwise encrypt without verifying.
  const tls: Json = verifiable
    ? { ca: { provider: 'inline', trusted_ca_certs: cas }, server_name: '{http.reverse_proxy.upstream.host}' }
    : { insecure_skip_verify: true };
  return [
    {
      handle: [
        {
          handler: 'reverse_proxy',
          upstreams,
          transport: { protocol: 'http', tls, dial_timeout: '5s' },
          load_balancing: { selection_policy: { policy: site.lb_policy || 'round_robin' }, retries: 2, try_duration: '5s' },
          health_checks: {
            active: { uri: HEALTH_PATH, interval: '10s', timeout: '3s', expect_status: 200 },
            passive: { fail_duration: '30s', max_fails: 3, unhealthy_status: [502, 503, 504] },
          },
        },
      ],
    },
  ];
}

function siteRoutes(site: SiteRow, servers: ServerRow[]): Route[] {
  if (site.status === 'new' || !site.active_release) return comingSoon();
  if (!siteIsLocalOnly(site)) return balancedSiteRoutes(site, servers);
  return siteContentRoutes(site);
}

/** Reverse proxy to a Worker process. Retries cover the instant it restarts on deploy. */
function workerHandler(w: WorkerRow): Json {
  return {
    handler: 'reverse_proxy',
    upstreams: [{ dial: `127.0.0.1:${workerPort(w.id)}` }],
    load_balancing: { try_duration: '5s', try_interval: '100ms' },
    headers: { request: { set: { 'X-Forwarded-Proto': ['{http.request.scheme}'] } } },
  };
}

/** "ejemplo.com/api/*" → { host: 'ejemplo.com', path: '/api/*' } */
function parseWorkerRoute(pattern: string) {
  const clean = pattern.replace(/^https?:\/\//, '');
  const slash = clean.indexOf('/');
  const host = slash === -1 ? clean : clean.slice(0, slash);
  const path = slash === -1 ? '/*' : clean.slice(slash);
  return { host, path };
}

/** Public bucket served on its own hostname (custom domain). */
function bucketRoutes(b: BucketRow): Route[] {
  const cors = b.cors_origins.trim();
  const routes: Route[] = [
    {
      match: [{ method: ['GET', 'HEAD', 'OPTIONS'] }],
      handle: [
        {
          handler: 'headers',
          response: { set: { 'Cache-Control': [`public, max-age=${b.cache_ttl}`], 'X-Content-Type-Options': ['nosniff'] }, deferred: true },
        },
      ],
    },
  ];
  if (cors) {
    // CORS headers only for allowed origins ("*" = any origin).
    const allowed = cors === '*' ? null : cors.split(',').map((o) => o.trim()).filter(Boolean);
    routes.push({
      match: [allowed ? { header: { Origin: allowed } } : { header: { Origin: ['*'] } }],
      handle: [
        {
          handler: 'headers',
          response: {
            set: {
              'Access-Control-Allow-Origin': [allowed ? '{http.request.header.Origin}' : '*'],
              'Access-Control-Allow-Methods': ['GET, HEAD, OPTIONS'],
              'Access-Control-Max-Age': ['86400'],
              Vary: ['Origin'],
            },
            deferred: true,
          },
        },
      ],
    });
  }
  routes.push(
    { match: [{ method: ['OPTIONS'] }], handle: [{ handler: 'static_response', status_code: 204 }] },
    { match: [{ not: [{ method: ['GET', 'HEAD'] }] }], handle: [{ handler: 'static_response', status_code: 405 }] },
    { handle: [{ handler: 'file_server', root: bucketDir(b.name), hide: ['.hp-*'], pass_thru: false }] },
  );
  return routes;
}

function proxyHandler(route: ProxyRouteRow): Json[] {
  const upstreams = JSON.parse(route.upstreams) as string[];
  const parsed = upstreams.map((u) => {
    const url = new URL(/^https?:\/\//.test(u) ? u : `http://${u}`);
    const https = url.protocol === 'https:';
    return { dial: `${url.hostname}:${url.port || (https ? 443 : 80)}`, https };
  });
  const anyHttps = parsed.some((p) => p.https);
  const handler: Json = {
    handler: 'reverse_proxy',
    upstreams: parsed.map((p) => ({ dial: p.dial })),
  };
  if (parsed.length > 1) {
    handler.load_balancing = { selection_policy: { policy: route.lb_policy }, retries: 2 };
    handler.health_checks = { passive: { fail_duration: '30s', max_fails: 3 } };
  }
  if (anyHttps) handler.transport = { protocol: 'http', tls: route.tls_skip_verify ? { insecure_skip_verify: true } : {} };
  if (!route.preserve_host) {
    handler.headers = { request: { set: { Host: ['{http.reverse_proxy.upstream.hostport}'] } } };
  }
  const handlers: Json[] = [];
  if (route.strip_prefix && route.path_prefix) {
    handlers.push({ handler: 'rewrite', strip_path_prefix: route.path_prefix });
  }
  handlers.push(handler);
  return handlers;
}

// --- load balancers -----------------------------------------------------------------

export interface LbOrigin {
  address: string;
  weight: number;
  enabled: boolean;
  label?: string;
  server_id?: number | null;
}

export const lbOrigins = (lb: Pick<LoadBalancerRow, 'origins'>) => JSON.parse(lb.origins || '[]') as LbOrigin[];
export const lbHostnames = (lb: Pick<LoadBalancerRow, 'hostnames'>) => JSON.parse(lb.hostnames || '[]') as string[];

/** "https://10.0.0.5:8443" | "10.0.0.5:3000" → dial address and whether it uses TLS. */
export function parseOrigin(address: string) {
  const url = new URL(/^https?:\/\//.test(address) ? address : `http://${address}`);
  const https = url.protocol === 'https:';
  return { dial: `${url.hostname}:${url.port || (https ? 443 : 80)}`, https, host: url.hostname };
}

function selectionPolicy(lb: LoadBalancerRow, origins: LbOrigin[]): Json {
  switch (lb.policy) {
    case 'weighted_round_robin':
      return { policy: 'weighted_round_robin', weights: origins.map((o) => Math.max(1, o.weight || 1)) };
    case 'cookie':
      return { policy: 'cookie', name: lb.sticky_cookie || 'hp_lb', fallback: { policy: 'least_conn' } };
    case 'least_conn':
    case 'ip_hash':
    case 'first':
    case 'random':
    case 'uri_hash':
    case 'round_robin':
      return { policy: lb.policy };
    default:
      return { policy: 'round_robin' };
  }
}

export function loadBalancerHandlers(lb: LoadBalancerRow): Json[] {
  const origins = lbOrigins(lb).filter((o) => o.enabled);
  if (!origins.length) {
    return [{ handler: 'static_response', status_code: 503, body: 'Sin servidores de origen disponibles' }];
  }
  const parsed = origins.map((o) => parseOrigin(o.address));
  const handler: Json = {
    handler: 'reverse_proxy',
    upstreams: parsed.map((p) => ({ dial: p.dial })),
    load_balancing: {
      selection_policy: selectionPolicy(lb, origins),
      retries: Math.max(0, lb.retries),
      try_duration: lb.retries > 0 ? '5s' : undefined,
    },
    headers: { request: { set: { 'X-Forwarded-Proto': ['{http.request.scheme}'] } } },
  };
  const health: Json = {
    passive: { fail_duration: `${Math.max(1, lb.fail_duration)}s`, max_fails: Math.max(1, lb.max_fails), unhealthy_status: [502, 503, 504] },
  };
  if (lb.health_enabled) {
    health.active = {
      uri: lb.health_path || '/',
      interval: `${Math.max(2, lb.health_interval)}s`,
      timeout: `${Math.max(1, lb.health_timeout)}s`,
      expect_status: lb.health_status || 200,
    };
  }
  handler.health_checks = health;
  if (parsed.some((p) => p.https)) {
    handler.transport = { protocol: 'http', dial_timeout: '5s', tls: lb.tls_skip_verify ? { insecure_skip_verify: true } : {} };
  }
  if (!lb.preserve_host) {
    (handler.headers as Json).request = { set: { 'X-Forwarded-Proto': ['{http.request.scheme}'], Host: ['{http.reverse_proxy.upstream.hostport}'] } };
  }
  return [handler];
}

function redirectRoute(r: RedirectRow): Route {
  const location = r.preserve_path ? `${r.target.replace(/\/$/, '')}{http.request.uri}` : r.target;
  const route: Route = {
    handle: [{ handler: 'static_response', status_code: r.code, headers: { Location: [location] } }],
  };
  if (r.path) route.match = [{ path: [r.path] }];
  return route;
}

// --- full config ---------------------------------------------------------------------

interface HostEntry {
  content: Route[];
  /** Panel / webmail routes skip the user-facing WAF (they have their own protection). */
  system?: boolean;
}

export function buildCaddyConfig(): Json {
  const domains = all<DomainRow>('SELECT * FROM domains');
  const sites = all<SiteRow>('SELECT * FROM sites');
  const proxies = all<ProxyRouteRow>('SELECT * FROM proxy_routes WHERE enabled = 1');
  const balancers = all<LoadBalancerRow>('SELECT * FROM load_balancers WHERE enabled = 1');
  const redirects = all<RedirectRow>('SELECT * FROM redirects WHERE enabled = 1');
  const securityRows = all<SecurityRow>('SELECT * FROM security');
  const ipRules = all<IpRuleRow>('SELECT * FROM ip_rules');
  const servers = all<ServerRow>("SELECT * FROM servers");
  const buckets = all<BucketRow>("SELECT * FROM buckets WHERE public = 1 AND hostname != ''");
  const workers = all<WorkerRow>("SELECT * FROM workers WHERE enabled = 1 AND status = 'running'");
  const protectedPaths = all<ProtectedPathRow>('SELECT * FROM protected_paths ORDER BY id');

  const hosts = new Map<string, HostEntry>();
  const entry = (host: string) => {
    let e = hosts.get(host);
    if (!e) {
      e = { content: [] };
      hosts.set(host, e);
    }
    return e;
  };

  // Redirects first, then proxy routes (longest prefix first), then the site itself.
  for (const r of redirects) entry(r.hostname).content.push(redirectRoute(r));
  // Worker routes run before proxies and the site (like Cloudflare: the Worker sees the
  // request first). More specific paths first.
  const workerMatches = workers
    .flatMap((w) => workerRoutes(w).map((r) => ({ w, ...parseWorkerRoute(r) })))
    .sort((a, b) => b.path.replace(/\*$/, '').length - a.path.replace(/\*$/, '').length);
  for (const m of workerMatches) {
    const route: Route = { handle: [workerHandler(m.w)] };
    if (m.path !== '/*') route.match = [{ path: [m.path] }];
    entry(m.host).content.push(route);
  }
  // <name>.<workersDomain>, like *.workers.dev.
  for (const w of workers) {
    const host = workerHostname(w);
    if (host && !hosts.has(host)) hosts.set(host, { content: [{ handle: [workerHandler(w)] }] });
  }
  // Proxy routes and load balancers share one ordering: the longest path prefix wins.
  const forwards = [
    ...proxies.map((p) => ({ hosts: [p.hostname], prefix: p.path_prefix, handle: () => proxyHandler(p) })),
    ...balancers.map((lb) => ({ hosts: lbHostnames(lb), prefix: lb.path_prefix, handle: () => loadBalancerHandlers(lb) })),
  ].sort((a, b) => b.prefix.length - a.prefix.length);
  for (const f of forwards) {
    for (const host of f.hosts) {
      const route: Route = { handle: f.handle() };
      if (f.prefix) route.match = [{ path: [f.prefix, `${f.prefix.replace(/\/$/, '')}/*`] }];
      entry(host).content.push(route);
    }
  }
  for (const site of sites) {
    for (const host of JSON.parse(site.hostnames) as string[]) {
      entry(host).content.push(...siteRoutes(site, servers));
    }
  }

  for (const b of buckets) entry(b.hostname).content.push(...bucketRoutes(b));

  // Password-protected paths go first on the site's hostnames, so redirects, Workers and
  // proxies on the same host can't be used to get around them.
  for (const site of sites) {
    const rows = protectedPaths.filter((p) => p.site_id === site.id);
    if (!rows.length) continue;
    const auth = protectedPathRoutes(rows);
    for (const host of JSON.parse(site.hostnames) as string[]) entry(host).content.unshift(...auth);
  }

  // Panel on its own domain.
  const panelUpstream = { handler: 'reverse_proxy', upstreams: [{ dial: `127.0.0.1:${config.listenPort}` }] };
  if (config.panelDomain) {
    hosts.set(config.panelDomain, { content: [{ handle: [panelUpstream] }], system: true });
  }

  // Webmail (Roundcube) + Stalwart autoconfig/JMAP on the mail hostname.
  if (config.mailHostname) {
    const stalwart = { handler: 'reverse_proxy', upstreams: [{ dial: config.stalwartApi.replace(/^https?:\/\//, '') }] };
    hosts.set(config.mailHostname, {
      system: true,
      content: [
        { match: [{ path: ['/.well-known/*', '/jmap*', '/mail/config-v1.1.xml', '/autodiscover/*'] }], handle: [stalwart] },
        ...phpRoutes(join(config.roundcubeDir, 'public_html'), '/run/php/hp-roundcube.sock'),
      ],
    });
    // webmail.<domain> and autoconfig for every domain with mail enabled.
    for (const d of domains.filter((x) => x.mail_enabled)) {
      if (!hosts.has(`webmail.${d.name}`)) {
        hosts.set(`webmail.${d.name}`, { system: true, content: phpRoutes(join(config.roundcubeDir, 'public_html'), '/run/php/hp-roundcube.sock') });
      }
      for (const h of [`autoconfig.${d.name}`, `autodiscover.${d.name}`]) {
        if (!hosts.has(h)) hosts.set(h, { system: true, content: [{ handle: [stalwart] }] });
      }
    }
  }

  const routes: Route[] = [];
  for (const [host, e] of hosts) {
    if (!e.content.length) continue;
    const domain = matchDomain(host, domains);
    const sec: SecurityRow = securityRows.find((s) => s.domain_id === domain?.id) ?? {
      domain_id: domain?.id ?? 0,
      ...DEFAULT_SECURITY,
    };
    const inner: Route[] = e.system
      ? [...responseHeaders({ ...sec, security_headers: 1, compression: 1 }), ...e.content]
      : [...securityRoutes(domain, sec, ipRules), ...responseHeaders(sec), ...e.content];
    routes.push({ match: [{ host: [host] }], handle: [{ handler: 'subroute', routes: inner }], terminal: true });
  }
  routes.push({
    handle: [
      {
        handler: 'static_response',
        status_code: 404,
        headers: { 'Content-Type': ['text/plain; charset=utf-8'] },
        body: 'Dominio no configurado en este servidor.',
      },
    ],
  });

  const panelHosts = [config.serverIp, config.panelDomain].filter(Boolean);
  // Optional allowlist for the panel itself (Ajustes → Acceso al panel).
  const panelAllow = (getSetting('panel_allow_ips') ?? '').split(/[\s,]+/).filter(Boolean);
  const panelGuard: Route[] = panelAllow.length
    ? [{ match: [{ not: [{ remote_ip: { ranges: [...panelAllow, '127.0.0.1/32', '::1/128'] } }] }], handle: [{ handler: 'static_response', status_code: 403, body: 'Acceso al panel no permitido desde tu IP' }], terminal: true }]
    : [];
  const panelEntry = hosts.get(config.panelDomain);
  if (panelEntry && panelGuard.length) panelEntry.content.unshift(...panelGuard);
  const logFile = join(config.logDir, 'access.log');
  const originSites = sites.filter((st) => st.active_release && !siteIsLocalOnly(st) && siteServerIds(st).includes(LOCAL_SERVER_ID));

  return {
    admin: config.caddyAdmin.startsWith('unix/')
      ? { listen: config.caddyAdmin }
      : { listen: config.caddyAdmin.replace(/^https?:\/\//, ''), origins: ['127.0.0.1:2019', 'localhost:2019'] },
    logging: {
      logs: {
        default: { exclude: [`http.log.access.${ACCESS_LOGGER}`] },
        tls: {
          writer: { output: 'file', filename: TLS_LOG(), roll_size_mb: 10, roll_keep: 3 },
          encoder: { format: 'json' },
          include: ['tls'],
        },
        [ACCESS_LOGGER]: {
          writer: { output: 'file', filename: logFile, roll_size_mb: 100, roll_keep: 5 },
          encoder: { format: 'json' },
          include: [`http.log.access.${ACCESS_LOGGER}`],
        },
      },
    },
    apps: {
      http: {
        servers: {
          web: {
            listen: [':80', ':443'],
            routes,
            logs: { default_logger_name: ACCESS_LOGGER },
          },
          // Panel reachable at https://<server-ip>:2087 from minute one (internal certificate).
          panel: {
            listen: [`:${config.panelPort}`],
            routes: [...panelGuard, { match: [{ host: panelHosts }], handle: [panelUpstream], terminal: true }, { handle: [panelUpstream] }],
            tls_connection_policies: [{ default_sni: config.serverIp }],
            automatic_https: { disable_redirects: true },
          },
          // Local origin for sites balanced between this server and remote nodes.
          ...(originSites.length
            ? {
                origin: {
                  listen: [LOCAL_ORIGIN],
                  routes: [
                    { match: [{ path: [HEALTH_PATH] }], handle: [{ handler: 'static_response', status_code: 200, body: 'ok' }], terminal: true },
                    ...originSites.map((site) => ({
                      match: [{ host: JSON.parse(site.hostnames) as string[] }],
                      handle: [{ handler: 'subroute', routes: siteContentRoutes(site) }],
                      terminal: true,
                    })),
                  ],
                  automatic_https: { disable: true },
                  tls_connection_policies: [{ default_sni: '127.0.0.1' }],
                },
              }
            : {}),
        },
      },
      tls: {
        ...(originSites.length ? { certificates: { automate: ['127.0.0.1'] } } : {}),
        automation: {
          policies: [
            { subjects: [config.serverIp, '127.0.0.1'], issuers: [{ module: 'internal' }] },
            // Every other hostname gets its own Let's Encrypt certificate (HTTP-01 / TLS-ALPN-01),
            // renewed by Caddy when a third of its lifetime is left.
            { issuers: [letsEncryptIssuer()] },
          ],
        },
      },
    },
  };
}

// --- certificates ----------------------------------------------------------------------

export const LETS_ENCRYPT_CA = 'https://acme-v02.api.letsencrypt.org/directory';
/** Folder name Caddy uses for Let's Encrypt certificates in its storage. */
export const LETS_ENCRYPT_STORAGE = 'acme-v02.api.letsencrypt.org-directory';
/** Caddy's TLS events (obtain, renew, errors) go here so the panel can show them per domain. */
export const TLS_LOG = () => join(config.logDir, 'caddy-tls.log');

/** Let's Encrypt rejects placeholder addresses, so those are left out (an account works without email). */
export function acmeEmail(): string {
  const email = config.adminEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(email)) return '';
  const domain = email.split('@')[1]!;
  if (/(^|\.)(example\.(com|org|net)|localhost|local|test|invalid|example)$/.test(domain)) return '';
  return email;
}

function letsEncryptIssuer(): Json {
  const email = acmeEmail();
  return { module: 'acme', ca: LETS_ENCRYPT_CA, ...(email ? { email } : {}) };
}

/** Hostnames that get a public certificate (every host routed on ports 80/443). */
export function publicHostnames(): string[] {
  const cfg = buildCaddyConfig() as { apps: { http: { servers: { web: { routes: { match?: { host?: string[] }[] }[] } } } } };
  const out = new Set<string>();
  for (const r of cfg.apps.http.servers.web.routes) for (const h of r.match?.[0]?.host ?? []) out.add(h);
  return [...out].filter((h) => !/^[\d.]+$|:|^localhost$/.test(h)).sort();
}

// --- apply ---------------------------------------------------------------------------

let pending: Promise<void> = Promise.resolve();
let timer: NodeJS.Timeout | undefined;
let lastError = '';
let lastSync = 0;

export function caddyState() {
  return { lastError, lastSync };
}

/** force: reload even if nothing changed (restarts pending certificate requests). */
export async function applyCaddyConfig(force = false): Promise<void> {
  const body = JSON.stringify(buildCaddyConfig());
  if (config.dev) {
    lastSync = Date.now();
    return;
  }
  const res = await postToCaddy('/load', body, 'POST', force ? { 'Cache-Control': 'must-revalidate' } : {});
  if (res.status !== 200) {
    lastError = res.body;
    throw new Error(`Caddy rechazó la configuración: ${lastError}`);
  }
  lastError = '';
  lastSync = Date.now();
}

/**
 * Talks to Caddy's admin API. The default is a unix socket only root can use; installs
 * that still have the old TCP admin (127.0.0.1:2019) are reached there once, and the
 * config we push moves the admin to the socket.
 */
function postToCaddy(path: string, body: string, method = 'POST', extraHeaders: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  const viaSocket = config.caddyAdmin.startsWith('unix/');
  const socketPath = viaSocket ? config.caddyAdmin.replace(/^unix\//, '') : '';
  if (viaSocket && !existsSync(dirname(socketPath))) {
    // Older caddy.service without RuntimeDirectory: create the folder for this boot.
    mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
    spawnSync('chown', [`${config.caddyUser}:${config.caddyUser}`, dirname(socketPath)]);
  }
  const target =
    viaSocket && existsSync(socketPath)
      ? { socketPath, host: '127.0.0.1' }
      : viaSocket
        ? { host: '127.0.0.1', port: 2019 }
        : { host: new URL(config.caddyAdmin).hostname, port: Number(new URL(config.caddyAdmin).port || 80) };
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      // Caddy only accepts Host 127.0.0.1 / ::1 / empty on its unix socket.
      { ...target, path, method, headers: { 'Content-Type': 'application/json', Host: '127.0.0.1', 'Content-Length': Buffer.byteLength(body), ...extraHeaders }, timeout: 30_000 },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Caddy no respondió')));
    req.end(body);
  });
}

/** Per-upstream counters kept by Caddy (requests in flight and recent failures). */
export async function upstreamStats(): Promise<{ address: string; num_requests: number; fails: number }[]> {
  if (config.dev) return [];
  try {
    const res = await postToCaddy('/reverse_proxy/upstreams', '', 'GET');
    return res.status === 200 ? (JSON.parse(res.body) as { address: string; num_requests: number; fails: number }[]) : [];
  } catch {
    return [];
  }
}

/** Applies the config now and waits; concurrent callers are serialized. */
export function syncCaddy(force = false): Promise<void> {
  pending = pending.catch(() => {}).then(() => applyCaddyConfig(force));
  return pending;
}

/** Debounced background sync for bulk changes. */
export function scheduleCaddySync() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    syncCaddy().catch((err) => console.error(err));
  }, 300);
}

/** Lists certificates Caddy currently manages (from its storage). */
export async function listCertificates(): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  const out: string[] = [];
  try {
    const base = join(config.caddyDataDir, 'certificates');
    for (const issuer of await readdir(base)) {
      for (const host of await readdir(join(base, issuer))) out.push(host);
    }
  } catch {
    /* no certificates yet */
  }
  return out;
}
