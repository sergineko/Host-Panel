/**
 * Certificate status per hostname. Caddy obtains a Let's Encrypt certificate for every
 * hostname the panel routes and renews it on its own; this module only reads the result:
 * the certificate files in Caddy's storage, Caddy's TLS log (for errors) and a public DNS
 * lookup (the usual reason an issuance fails).
 */
import { X509Certificate, createHash } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.ts';
import { all, get, type WorkerRow } from '../db.ts';
import { acmeEmail, LETS_ENCRYPT_STORAGE, publicHostnames, TLS_LOG } from './caddy.ts';
import { workerHostname } from './workers.ts';

export type CertState = 'valid' | 'renewing' | 'expired' | 'pending' | 'error';

export interface CertInfo {
  host: string;
  /** Who uses the hostname: "Sitio web: Tienda", "Balanceador: API"… */
  owner: string;
  owner_link: string | null;
  state: CertState;
  issuer: string | null;
  lets_encrypt: boolean;
  not_before: string | null;
  not_after: string | null;
  days_left: number | null;
  /** From this date Caddy renews it (a third of its lifetime before it expires). */
  renews_from: string | null;
  dns: { ok: boolean; a: string[]; aaaa: string[]; problem: string | null };
  error: { message: string; hint: string; at: string; retry_at: string | null } | null;
}

// --- who owns each hostname ------------------------------------------------------------

function owners() {
  const map = new Map<string, { owner: string; link: string | null }>();
  const add = (host: string, owner: string, link: string | null) => {
    if (host && !map.has(host)) map.set(host, { owner, link });
  };
  for (const s of all<{ id: number; name: string; hostnames: string }>('SELECT id, name, hostnames FROM sites')) {
    for (const h of JSON.parse(s.hostnames) as string[]) add(h, `Sitio web: ${s.name}`, `/sites/${s.id}`);
  }
  for (const lb of all<{ id: number; name: string; hostnames: string }>('SELECT id, name, hostnames FROM load_balancers')) {
    for (const h of JSON.parse(lb.hostnames) as string[]) add(h, `Balanceador: ${lb.name}`, '/load-balancers');
  }
  for (const p of all<{ hostname: string }>('SELECT hostname FROM proxy_routes')) add(p.hostname, 'Proxy inverso', '/proxy');
  for (const r of all<{ hostname: string }>('SELECT hostname FROM redirects')) add(r.hostname, 'Redirección', '/proxy');
  for (const b of all<{ id: number; name: string; hostname: string }>("SELECT id, name, hostname FROM buckets WHERE hostname != ''")) {
    add(b.hostname, `Almacenamiento: ${b.name}`, `/storage/${b.id}`);
  }
  for (const w of all<WorkerRow>('SELECT * FROM workers')) {
    const h = workerHostname(w);
    if (h) add(h, `Worker: ${w.name}`, `/workers/${w.id}`);
    for (const r of JSON.parse(w.routes || '[]') as string[]) add(r.replace(/^https?:\/\//, '').split('/')[0]!, `Worker: ${w.name}`, `/workers/${w.id}`);
  }
  if (config.panelDomain) add(config.panelDomain, 'Panel de control', null);
  if (config.mailHostname) add(config.mailHostname, 'Correo', '/mail');
  return map;
}

function ownerFor(host: string, map: Map<string, { owner: string; link: string | null }>) {
  const o = map.get(host);
  if (o) return o;
  if (/^(webmail|autoconfig|autodiscover)\./.test(host)) return { owner: 'Correo', link: '/mail' };
  return { owner: 'Sistema', link: null };
}

// --- certificate files ----------------------------------------------------------------

/** Newest certificate for a host across issuers in Caddy's storage. */
function readCert(host: string) {
  const base = join(config.caddyDataDir, 'certificates');
  let best: X509Certificate | null = null;
  let issuerDir = '';
  let dirs: string[] = [];
  try {
    dirs = readdirSync(base);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const file = join(base, dir, host, `${host}.crt`);
    if (!existsSync(file)) continue;
    try {
      const cert = new X509Certificate(readFileSync(file));
      if (!best || Date.parse(cert.validTo) > Date.parse(best.validTo)) {
        best = cert;
        issuerDir = dir;
      }
    } catch {
      /* unreadable or partial file */
    }
  }
  if (!best) return null;
  const org = /O=([^\n,]+)/.exec(best.issuer)?.[1]?.trim();
  const cn = /CN=([^\n,]+)/.exec(best.issuer)?.[1]?.trim();
  return {
    issuer: [org, cn].filter(Boolean).join(' · ') || best.issuer,
    letsEncrypt: issuerDir === LETS_ENCRYPT_STORAGE || /Let's Encrypt/i.test(best.issuer),
    notBefore: new Date(best.validFrom),
    notAfter: new Date(best.validTo),
  };
}

// --- Caddy TLS log: last outcome per hostname ----------------------------------------------

interface LogEvent {
  ok: boolean;
  message: string;
  at: number;
  retryAt: number | null;
}

let logCache: { mtime: number; size: number; events: Map<string, LogEvent> } | null = null;

function tlsEvents(): Map<string, LogEvent> {
  const file = TLS_LOG();
  let st;
  try {
    st = statSync(file);
  } catch {
    return new Map();
  }
  if (logCache && logCache.mtime === st.mtimeMs && logCache.size === st.size) return logCache.events;
  // The tail is enough: Caddy retries failed hosts regularly, so recent lines are there.
  const len = Math.min(st.size, 2 * 1024 * 1024);
  const buf = Buffer.alloc(len);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buf, 0, len, st.size - len);
  } finally {
    closeSync(fd);
  }
  const events = new Map<string, LogEvent>();
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line.startsWith('{')) continue;
    let e: { level?: string; ts?: number; msg?: string; identifier?: string; error?: string; retrying_in?: number; identifiers?: string[] };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const at = Math.round((e.ts ?? 0) * 1000);
    const hosts = e.identifier ? [e.identifier] : (e.identifiers ?? []);
    for (const host of hosts) {
      if (/certificate obtained successfully|certificate renewed successfully/.test(e.msg ?? '')) {
        events.set(host, { ok: true, message: '', at, retryAt: null });
      } else if (e.level === 'error' && e.error) {
        events.set(host, { ok: false, message: e.error, at, retryAt: events.get(host)?.retryAt ?? null });
      } else if (e.msg === 'will retry' && e.retrying_in) {
        const prev = events.get(host);
        if (prev && !prev.ok) prev.retryAt = at + e.retrying_in * 1000;
      }
    }
  }
  logCache = { mtime: st.mtimeMs, size: st.size, events };
  return events;
}

/** Turns an ACME error into something a person can act on. */
export function explainAcmeError(message: string): string {
  const m = message.toLowerCase();
  if (/ratelimited|too many (certificates|failed authorizations|new orders)/.test(m)) {
    return "Se alcanzó un límite de Let's Encrypt. Caddy volverá a intentarlo automáticamente más tarde.";
  }
  if (/nxdomain|no valid a records|no valid ip addresses|servfail|dns problem/.test(m)) {
    return 'El dominio no resuelve en el DNS público. Crea un registro A (y AAAA si usas IPv6) hacia este servidor.';
  }
  if (/timeout|connection refused|connection reset|fetching http|no route to host/.test(m)) {
    return "Let's Encrypt no pudo conectar con este servidor. Comprueba que los puertos 80 y 443 están abiertos y que el DNS apunta aquí.";
  }
  if (/unauthorized|invalid response|404/.test(m)) {
    return 'La verificación respondió desde otro servidor: el dominio apunta a otra IP o pasa por un proxy/CDN que no deja pasar /.well-known/acme-challenge.';
  }
  if (/caa/.test(m)) return "Un registro CAA del dominio no permite a Let's Encrypt emitir certificados (añade letsencrypt.org).";
  return "Let's Encrypt rechazó la solicitud. Caddy lo reintentará automáticamente.";
}

// --- public DNS check -------------------------------------------------------------------

const resolver = new Resolver({ timeout: 2500, tries: 1 });
resolver.setServers(['1.1.1.1', '8.8.8.8']);
const dnsCache = new Map<string, { at: number; a: string[]; aaaa: string[] }>();

async function lookup(host: string) {
  const hit = dnsCache.get(host);
  if (hit && Date.now() - hit.at < 60_000) return hit;
  const [a, aaaa] = await Promise.all([resolver.resolve4(host).catch(() => [] as string[]), resolver.resolve6(host).catch(() => [] as string[])]);
  const entry = { at: Date.now(), a, aaaa };
  dnsCache.set(host, entry);
  return entry;
}

function dnsVerdict(a: string[], aaaa: string[]) {
  if (!a.length && !aaaa.length) return { ok: false, problem: 'El dominio no tiene registros A ni AAAA en el DNS público.' };
  if (a.length && !a.includes(config.serverIp)) {
    return { ok: false, problem: `El registro A apunta a ${a.join(', ')}; debe apuntar a ${config.serverIp}.` };
  }
  // Let's Encrypt prefers IPv6: an AAAA record pointing elsewhere breaks validation.
  if (aaaa.length && !(config.serverIpv6 && aaaa.includes(config.serverIpv6))) {
    return {
      ok: false,
      problem: config.serverIpv6
        ? `El registro AAAA apunta a ${aaaa.join(', ')}; debe apuntar a ${config.serverIpv6} (o bórralo).`
        : `El registro AAAA apunta a ${aaaa.join(', ')} y este servidor no usa IPv6: bórralo.`,
    };
  }
  if (!a.length) return { ok: false, problem: `Falta el registro A hacia ${config.serverIp}.` };
  return { ok: true, problem: null };
}

// --- dev mode: believable sample data ---------------------------------------------------

function devCert(host: string, owner: { owner: string; link: string | null }): CertInfo {
  const n = createHash('sha1').update(host).digest()[0]!;
  const pending = n % 5 === 0;
  if (pending) {
    return {
      host,
      ...{ owner: owner.owner, owner_link: owner.link },
      state: 'error',
      issuer: null,
      lets_encrypt: false,
      not_before: null,
      not_after: null,
      days_left: null,
      renews_from: null,
      dns: { ok: false, a: ['192.0.2.44'], aaaa: [], problem: `El registro A apunta a 192.0.2.44; debe apuntar a ${config.serverIp}.` },
      error: {
        message: 'HTTP 400 urn:ietf:params:acme:error:unauthorized - 192.0.2.44: Invalid response from http://' + host + '/.well-known/acme-challenge/x: 404',
        hint: explainAcmeError('unauthorized'),
        at: new Date(Date.now() - 8 * 60_000).toISOString(),
        retry_at: new Date(Date.now() + 12 * 60_000).toISOString(),
      },
    };
  }
  const issued = Date.now() - (n % 50) * 86400_000;
  return certFrom(host, owner, { issuer: "Let's Encrypt · R11", letsEncrypt: true, notBefore: new Date(issued), notAfter: new Date(issued + 90 * 86400_000) }, null, {
    ok: true,
    a: [config.serverIp],
    aaaa: [],
    problem: null,
  });
}

function certFrom(
  host: string,
  owner: { owner: string; link: string | null },
  cert: { issuer: string; letsEncrypt: boolean; notBefore: Date; notAfter: Date } | null,
  event: LogEvent | null,
  dns: CertInfo['dns'],
): CertInfo {
  const now = Date.now();
  let state: CertState = 'pending';
  let renewsFrom: Date | null = null;
  if (cert) {
    const life = cert.notAfter.getTime() - cert.notBefore.getTime();
    renewsFrom = new Date(cert.notAfter.getTime() - life / 3);
    state = cert.notAfter.getTime() < now ? 'expired' : now >= renewsFrom.getTime() ? 'renewing' : 'valid';
  } else if (event && !event.ok) {
    state = 'error';
  }
  const failing = event && !event.ok && (!cert || state !== 'valid');
  return {
    host,
    owner: owner.owner,
    owner_link: owner.link,
    state,
    issuer: cert?.issuer ?? null,
    lets_encrypt: cert?.letsEncrypt ?? false,
    not_before: cert?.notBefore.toISOString() ?? null,
    not_after: cert?.notAfter.toISOString() ?? null,
    days_left: cert ? Math.floor((cert.notAfter.getTime() - now) / 86400_000) : null,
    renews_from: renewsFrom?.toISOString() ?? null,
    dns,
    error: failing
      ? {
          message: event.message,
          hint: explainAcmeError(event.message),
          at: new Date(event.at).toISOString(),
          retry_at: event.retryAt ? new Date(event.retryAt).toISOString() : null,
        }
      : null,
  };
}

/** Status of every public hostname (or only the given ones). */
export async function certificateStatus(only?: string[]): Promise<CertInfo[]> {
  const map = owners();
  const hosts = publicHostnames().filter((h) => !only || only.includes(h));
  if (config.dev) return hosts.map((h) => devCert(h, ownerFor(h, map)));
  const events = tlsEvents();
  return Promise.all(
    hosts.map(async (host) => {
      const cert = readCert(host);
      const { a, aaaa } = await lookup(host);
      return certFrom(host, ownerFor(host, map), cert, events.get(host) ?? null, { a, aaaa, ...dnsVerdict(a, aaaa) });
    }),
  );
}

export function certificateSettings() {
  return {
    issuer: "Let's Encrypt",
    email: acmeEmail(),
    configured_email: config.adminEmail,
    server_ip: config.serverIp,
    server_ipv6: config.serverIpv6 || null,
    dns_managed: !!get('SELECT 1 FROM domains WHERE dns_enabled = 1 LIMIT 1'),
  };
}
