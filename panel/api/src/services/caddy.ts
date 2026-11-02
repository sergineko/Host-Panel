/**
 * Builds the complete Caddy JSON configuration from the panel database and loads it
 * through Caddy's admin API. Caddy validates the config before applying it, so a bad
 * config never replaces a working one.
 */
import { join } from 'node:path';
import { config } from '../config.ts';
import {
  all,
  type DomainRow,
  type IpRuleRow,
  type ProxyRouteRow,
  type RedirectRow,
  type SecurityRow,
  type SiteRow,
} from '../db.ts';
import { matchDomain } from '../lib/validate.ts';
import { nodePort, phpSocket, sitePaths } from './system.ts';

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
};

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
  if (sec.compression) {
    routes.push({ handle: [{ handler: 'encode', encodings: { zstd: {}, gzip: {} }, prefer: ['zstd', 'gzip'] }] });
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

function siteRoutes(site: SiteRow): Route[] {
  const current = sitePaths(site.id).current;
  if (site.status === 'new' || !site.active_release) {
    return [
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
  }
  if (site.type === 'node') {
    return [{ handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: `127.0.0.1:${nodePort(site.id, site.active_slot)}` }] }] }];
  }
  if (site.type === 'php') return phpRoutes(current, phpSocket(site.id));
  return staticSiteRoutes(current, !!site.spa);
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
  const redirects = all<RedirectRow>('SELECT * FROM redirects WHERE enabled = 1');
  const securityRows = all<SecurityRow>('SELECT * FROM security');
  const ipRules = all<IpRuleRow>('SELECT * FROM ip_rules');

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
  for (const p of [...proxies].sort((a, b) => b.path_prefix.length - a.path_prefix.length)) {
    const route: Route = { handle: proxyHandler(p) };
    if (p.path_prefix) route.match = [{ path: [p.path_prefix, `${p.path_prefix.replace(/\/$/, '')}/*`] }];
    entry(p.hostname).content.push(route);
  }
  for (const site of sites) {
    for (const host of JSON.parse(site.hostnames) as string[]) {
      entry(host).content.push(...siteRoutes(site));
    }
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
  const logFile = join(config.logDir, 'access.log');

  return {
    admin: { listen: config.caddyAdmin.replace(/^https?:\/\//, ''), origins: ['127.0.0.1:2019', 'localhost:2019'] },
    logging: {
      logs: {
        default: { exclude: [`http.log.access.${ACCESS_LOGGER}`] },
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
            routes: [{ match: [{ host: panelHosts }], handle: [panelUpstream], terminal: true }, { handle: [panelUpstream] }],
            tls_connection_policies: [{ default_sni: config.serverIp }],
            automatic_https: { disable_redirects: true },
          },
        },
      },
      tls: {
        automation: {
          policies: [
            { subjects: [config.serverIp], issuers: [{ module: 'internal' }] },
            { issuers: [{ module: 'acme', email: config.adminEmail }] },
          ],
        },
      },
    },
  };
}

// --- apply ---------------------------------------------------------------------------

let pending: Promise<void> = Promise.resolve();
let timer: NodeJS.Timeout | undefined;
let lastError = '';
let lastSync = 0;

export function caddyState() {
  return { lastError, lastSync };
}

export async function applyCaddyConfig(): Promise<void> {
  const body = JSON.stringify(buildCaddyConfig());
  if (config.dev) {
    lastSync = Date.now();
    return;
  }
  const res = await fetch(`${config.caddyAdmin}/load`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!res.ok) {
    lastError = await res.text();
    throw new Error(`Caddy rechazó la configuración: ${lastError}`);
  }
  lastError = '';
  lastSync = Date.now();
}

/** Applies the config now and waits; concurrent callers are serialized. */
export function syncCaddy(): Promise<void> {
  pending = pending.catch(() => {}).then(applyCaddyConfig);
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
