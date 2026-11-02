import type { FastifyInstance } from 'fastify';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { z } from 'zod';
import { config } from '../config.ts';
import { all, audit, get, run, type LoadBalancerRow, type ServerRow, type SiteRow } from '../db.ts';
import { badRequest, hostname, idParam, notFound, parse } from '../lib/validate.ts';
import { lbHostnames, lbOrigins, parseOrigin, syncCaddy, upstreamStats } from '../services/caddy.ts';

export const LB_POLICIES = ['round_robin', 'weighted_round_robin', 'least_conn', 'ip_hash', 'cookie', 'first', 'random', 'uri_hash'] as const;

const origin = z.object({
  address: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .refine((v) => {
      try {
        const p = parseOrigin(v);
        return !!p.host && !/[\s/]/.test(p.host);
      } catch {
        return false;
      }
    }, 'Origen no válido: usa IP:puerto, host:puerto o https://host:puerto'),
  weight: z.number().int().min(1).max(100).default(1),
  enabled: z.boolean().default(true),
  label: z.string().trim().max(80).default(''),
  server_id: z.number().int().min(0).nullable().default(null),
});

const lbInput = z.object({
  name: z.string().trim().min(1).max(80),
  hostnames: z.array(hostname).min(1, 'Añade al menos un dominio').max(50),
  path_prefix: z
    .string()
    .trim()
    .max(200)
    .refine((v) => v === '' || /^\/[\w./~-]*$/.test(v), 'La ruta debe empezar por / (por ejemplo /api)')
    .default(''),
  origins: z.array(origin).min(1, 'Añade al menos un servidor de origen').max(50),
  policy: z.enum(LB_POLICIES).default('round_robin'),
  sticky_cookie: z
    .string()
    .trim()
    .max(64)
    .refine((v) => v === '' || /^[A-Za-z0-9_-]+$/.test(v), 'Nombre de cookie no válido')
    .default(''),
  health_enabled: z.boolean().default(true),
  health_path: z.string().trim().regex(/^\/[^\s]*$/, 'La ruta de comprobación debe empezar por /').max(300).default('/'),
  health_interval: z.number().int().min(2).max(3600).default(10),
  health_timeout: z.number().int().min(1).max(60).default(5),
  health_status: z.number().int().min(100).max(599).default(200),
  max_fails: z.number().int().min(1).max(100).default(3),
  fail_duration: z.number().int().min(1).max(3600).default(30),
  retries: z.number().int().min(0).max(10).default(2),
  preserve_host: z.boolean().default(true),
  tls_skip_verify: z.boolean().default(false),
  enabled: z.boolean().default(true),
  note: z.string().max(500).default(''),
});

type LbInput = z.infer<typeof lbInput>;

function getLb(id: number) {
  const lb = get<LoadBalancerRow>('SELECT * FROM load_balancers WHERE id = ?', id);
  if (!lb) throw notFound('Balanceador');
  return lb;
}

function present(lb: LoadBalancerRow) {
  return {
    ...lb,
    hostnames: lbHostnames(lb),
    origins: lbOrigins(lb),
    health_enabled: !!lb.health_enabled,
    preserve_host: !!lb.preserve_host,
    tls_skip_verify: !!lb.tls_skip_verify,
    enabled: !!lb.enabled,
  };
}

/** Hostnames already served by a site cannot also be balanced at the root path. */
function validate(body: LbInput, exceptId?: number) {
  const schemes = new Set(body.origins.map((o) => parseOrigin(o.address).https));
  if (schemes.size > 1) throw badRequest('Todos los orígenes deben usar el mismo protocolo (todos http o todos https)');
  const dials = body.origins.map((o) => parseOrigin(o.address).dial);
  if (new Set(dials).size !== dials.length) throw badRequest('Hay orígenes repetidos');
  if (config.panelDomain && body.hostnames.includes(config.panelDomain)) throw badRequest('Ese dominio lo usa el panel');
  if (!body.path_prefix) {
    for (const s of all<SiteRow>('SELECT name, hostnames FROM sites')) {
      const clash = body.hostnames.find((h) => (JSON.parse(s.hostnames) as string[]).includes(h));
      if (clash) throw badRequest(`${clash} ya lo sirve el sitio "${s.name}". Usa otro dominio o una ruta (por ejemplo /api).`);
    }
  }
  for (const other of all<LoadBalancerRow>('SELECT * FROM load_balancers')) {
    if (other.id === exceptId || other.path_prefix !== body.path_prefix) continue;
    const clash = body.hostnames.find((h) => lbHostnames(other).includes(h));
    if (clash) throw badRequest(`${clash}${body.path_prefix} ya lo usa el balanceador "${other.name}"`);
  }
}

const values = (b: LbInput) => [
  b.name,
  JSON.stringify(b.hostnames),
  b.path_prefix,
  JSON.stringify(b.origins),
  b.policy,
  b.sticky_cookie,
  Number(b.health_enabled),
  b.health_path,
  b.health_interval,
  b.health_timeout,
  b.health_status,
  b.max_fails,
  b.fail_duration,
  b.retries,
  Number(b.preserve_host),
  Number(b.tls_skip_verify),
  Number(b.enabled),
  b.note,
];

const COLUMNS =
  'name, hostnames, path_prefix, origins, policy, sticky_cookie, health_enabled, health_path, health_interval, health_timeout, health_status, max_fails, fail_duration, retries, preserve_host, tls_skip_verify, enabled, note';

/** One HTTP request to an origin's health path, from this server. */
function probe(address: string, path: string, timeoutMs: number, insecure: boolean): Promise<{ ok: boolean; status: number | null; ms: number; error?: string }> {
  const started = performance.now();
  const p = parseOrigin(address);
  const [host, port] = [p.host.replace(/^\[|\]$/g, ''), Number(p.dial.slice(p.dial.lastIndexOf(':') + 1))];
  const fn = p.https ? httpsRequest : httpRequest;
  return new Promise((resolve) => {
    const req = fn(
      { host, port, path, method: 'GET', timeout: timeoutMs, rejectUnauthorized: !insecure, headers: { 'User-Agent': 'HostPanel-LB-Check' } },
      (res) => {
        res.resume();
        resolve({ ok: true, status: res.statusCode ?? null, ms: Math.round(performance.now() - started) });
      },
    );
    req.on('timeout', () => req.destroy(new Error('Sin respuesta (tiempo agotado)')));
    req.on('error', (err) => resolve({ ok: false, status: null, ms: Math.round(performance.now() - started), error: err.message }));
    req.end();
  });
}

export default async function loadBalancerRoutes(app: FastifyInstance) {
  app.get('/api/load-balancers', async () => all<LoadBalancerRow>('SELECT * FROM load_balancers ORDER BY name').map(present));

  app.get('/api/load-balancers/:id', async (req) => present(getLb(parse(idParam, req.params).id)));

  app.post('/api/load-balancers', async (req) => {
    const body = parse(lbInput, req.body);
    validate(body);
    const { id } = run(`INSERT INTO load_balancers (${COLUMNS}) VALUES (${COLUMNS.split(',').map(() => '?').join(', ')})`, ...values(body));
    try {
      await syncCaddy();
    } catch (err) {
      run('DELETE FROM load_balancers WHERE id = ?', id);
      throw badRequest((err as Error).message);
    }
    audit(req.user!.username, 'lb.create', body.name, req.ip);
    return present(getLb(id));
  });

  app.put('/api/load-balancers/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const prev = getLb(id);
    const body = parse(lbInput, req.body);
    validate(body, id);
    const set = COLUMNS.split(',').map((c) => `${c.trim()} = ?`).join(', ');
    run(`UPDATE load_balancers SET ${set} WHERE id = ?`, ...values(body), id);
    try {
      await syncCaddy();
    } catch (err) {
      // Caddy rejected it: keep the previous, working version.
      run(`UPDATE load_balancers SET ${set} WHERE id = ?`, ...values(parse(lbInput, present(prev))), id);
      throw badRequest((err as Error).message);
    }
    audit(req.user!.username, 'lb.update', body.name, req.ip);
    return present(getLb(id));
  });

  app.delete('/api/load-balancers/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const lb = getLb(id);
    run('DELETE FROM load_balancers WHERE id = ?', id);
    await syncCaddy();
    audit(req.user!.username, 'lb.delete', lb.name, req.ip);
    return { ok: true };
  });

  /** Live state of each origin: a check from this server plus Caddy's own counters. */
  app.get('/api/load-balancers/:id/status', async (req) => {
    const lb = getLb(parse(idParam, req.params).id);
    const stats = await upstreamStats();
    const origins = lbOrigins(lb);
    const checks = await Promise.all(
      origins.map(async (o) => {
        const dial = parseOrigin(o.address).dial;
        const caddy = stats.find((s) => s.address === dial);
        if (!o.enabled) return { address: o.address, state: 'disabled' as const, status: null, ms: null, requests: 0, fails: 0 };
        const r = await probe(o.address, lb.health_path || '/', Math.max(1, lb.health_timeout) * 1000, !!lb.tls_skip_verify);
        const healthy = r.ok && (lb.health_enabled ? r.status === lb.health_status : (r.status ?? 500) < 500);
        return {
          address: o.address,
          state: healthy ? ('healthy' as const) : ('unhealthy' as const),
          status: r.status,
          ms: r.ms,
          error: r.error ?? (r.ok && !healthy ? `Respondió ${r.status} (se espera ${lb.health_enabled ? lb.health_status : '< 500'})` : undefined),
          requests: caddy?.num_requests ?? 0,
          fails: caddy?.fails ?? 0,
        };
      }),
    );
    return { checked_at: new Date().toISOString(), origins: checks };
  });

  /** Servers registered in the panel, offered as origins. */
  app.get('/api/load-balancers-sources', async () => ({
    local: { id: 0, name: 'Este servidor', host: config.serverIp },
    servers: all<ServerRow>('SELECT id, name, host, status FROM servers ORDER BY name'),
  }));
}
