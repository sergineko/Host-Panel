import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, audit, get, run, type ProxyRouteRow, type RedirectRow } from '../db.ts';
import { badRequest, hostname, idParam, notFound, parse } from '../lib/validate.ts';
import { buildCaddyConfig, caddyState, listCertificates, syncCaddy } from '../services/caddy.ts';

const upstream = z
  .string()
  .trim()
  .regex(/^(https?:\/\/)?[\w.-]+(:\d{1,5})?\/?$/, 'Upstream no válido (ej. 127.0.0.1:8080 o https://backend.local)');

const pathPrefix = z
  .string()
  .trim()
  .max(200)
  .refine((v) => v === '' || /^\/[\w./~-]*$/.test(v), 'La ruta debe empezar por /')
  .default('');

const proxyInput = z.object({
  hostname,
  path_prefix: pathPrefix,
  strip_prefix: z.boolean().default(false),
  upstreams: z.array(upstream).min(1, 'Añade al menos un upstream').max(20),
  lb_policy: z.enum(['round_robin', 'least_conn', 'random', 'ip_hash', 'first']).default('round_robin'),
  preserve_host: z.boolean().default(true),
  tls_skip_verify: z.boolean().default(false),
  enabled: z.boolean().default(true),
  note: z.string().max(200).default(''),
});

const redirectInput = z.object({
  hostname,
  path: pathPrefix.refine((v) => !v.includes('{'), 'Ruta no válida'),
  target: z.string().trim().url('Destino no válido (URL completa)'),
  code: z.union([z.literal(301), z.literal(302), z.literal(307), z.literal(308)]).default(301),
  preserve_path: z.boolean().default(false),
  enabled: z.boolean().default(true),
});

function presentProxy(r: ProxyRouteRow) {
  return {
    ...r,
    upstreams: JSON.parse(r.upstreams) as string[],
    strip_prefix: !!r.strip_prefix,
    preserve_host: !!r.preserve_host,
    tls_skip_verify: !!r.tls_skip_verify,
    enabled: !!r.enabled,
  };
}

export default async function proxyRoutes(app: FastifyInstance) {
  // --- reverse proxy routes --------------------------------------------------------
  app.get('/api/proxy', async () => all<ProxyRouteRow>('SELECT * FROM proxy_routes ORDER BY hostname, path_prefix').map(presentProxy));

  const saveProxy = (body: z.infer<typeof proxyInput>, id?: number) => {
    const clash = get<{ id: number }>(
      'SELECT id FROM proxy_routes WHERE hostname = ? AND path_prefix = ? AND id != ?',
      body.hostname,
      body.path_prefix,
      id ?? 0,
    );
    if (clash) throw badRequest('Ya existe una ruta para ese host y ruta');
    const values = [
      body.hostname,
      body.path_prefix,
      Number(body.strip_prefix),
      JSON.stringify(body.upstreams),
      body.lb_policy,
      Number(body.preserve_host),
      Number(body.tls_skip_verify),
      Number(body.enabled),
      body.note,
    ] as const;
    if (id) {
      run(
        `UPDATE proxy_routes SET hostname = ?, path_prefix = ?, strip_prefix = ?, upstreams = ?, lb_policy = ?, preserve_host = ?,
           tls_skip_verify = ?, enabled = ?, note = ? WHERE id = ?`,
        ...values,
        id,
      );
      return id;
    }
    return run(
      `INSERT INTO proxy_routes (hostname, path_prefix, strip_prefix, upstreams, lb_policy, preserve_host, tls_skip_verify, enabled, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ...values,
    ).id;
  };

  app.post('/api/proxy', async (req) => {
    const body = parse(proxyInput, req.body);
    const id = saveProxy(body);
    await syncCaddy();
    audit(req.user!.username, 'proxy.create', `${body.hostname}${body.path_prefix}`, req.ip);
    return presentProxy(get<ProxyRouteRow>('SELECT * FROM proxy_routes WHERE id = ?', id)!);
  });

  app.put('/api/proxy/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    if (!get('SELECT 1 FROM proxy_routes WHERE id = ?', id)) throw notFound('Ruta');
    const body = parse(proxyInput, req.body);
    saveProxy(body, id);
    await syncCaddy();
    audit(req.user!.username, 'proxy.update', `${body.hostname}${body.path_prefix}`, req.ip);
    return presentProxy(get<ProxyRouteRow>('SELECT * FROM proxy_routes WHERE id = ?', id)!);
  });

  app.delete('/api/proxy/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    run('DELETE FROM proxy_routes WHERE id = ?', id);
    await syncCaddy();
    audit(req.user!.username, 'proxy.delete', String(id), req.ip);
    return { ok: true };
  });

  // --- redirects -------------------------------------------------------------------
  app.get('/api/redirects', async () =>
    all<RedirectRow>('SELECT * FROM redirects ORDER BY hostname, path').map((r) => ({
      ...r,
      preserve_path: !!r.preserve_path,
      enabled: !!r.enabled,
    })),
  );

  app.post('/api/redirects', async (req) => {
    const b = parse(redirectInput, req.body);
    run(
      'INSERT INTO redirects (hostname, path, target, code, preserve_path, enabled) VALUES (?, ?, ?, ?, ?, ?)',
      b.hostname,
      b.path,
      b.target,
      b.code,
      Number(b.preserve_path),
      Number(b.enabled),
    );
    await syncCaddy();
    audit(req.user!.username, 'redirect.create', `${b.hostname}${b.path} → ${b.target}`, req.ip);
    return { ok: true };
  });

  app.put('/api/redirects/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(redirectInput, req.body);
    run(
      'UPDATE redirects SET hostname = ?, path = ?, target = ?, code = ?, preserve_path = ?, enabled = ? WHERE id = ?',
      b.hostname,
      b.path,
      b.target,
      b.code,
      Number(b.preserve_path),
      Number(b.enabled),
      id,
    );
    await syncCaddy();
    return { ok: true };
  });

  app.delete('/api/redirects/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    run('DELETE FROM redirects WHERE id = ?', id);
    await syncCaddy();
    return { ok: true };
  });

  // --- proxy engine status ---------------------------------------------------------
  app.get('/api/proxy/status', async () => ({ ...caddyState(), certificates: await listCertificates() }));
  app.get('/api/proxy/config', async () => buildCaddyConfig());
  app.post('/api/proxy/sync', async () => {
    await syncCaddy();
    return { ok: true };
  });
}
