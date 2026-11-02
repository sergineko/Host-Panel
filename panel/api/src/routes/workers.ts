import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.ts';
import { all, audit, get, run, type BucketRow, type DatabaseRow, type QueueRow, type WorkerRow } from '../db.ts';
import { encrypt, randomToken } from '../lib/crypto.ts';
import { badRequest, HOST_RE, idParam, notFound, parse } from '../lib/validate.ts';
import { scheduleCaddySync, syncCaddy } from '../services/caddy.ts';
import { nextRuns, parseCron } from '../services/cron.ts';
import { WORKER_TEMPLATES } from '../services/worker-templates.ts';
import {
  checkSyntax,
  launchWorker,
  removeWorkerFiles,
  stopWorkerProcess,
  triggerWorker,
  WORKER_NAME_RE,
  workerBindings,
  workerCrons,
  workerEvents,
  workerHostname,
  workerMetrics,
  workerPort,
  workerRoutes,
  type Binding,
} from '../services/workers.ts';
import * as dns from '../services/dns.ts';

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BINDING_TABLES = { sql: 'databases', nosql: 'nosql_databases', kv: 'kv_namespaces', bucket: 'buckets', queue: 'queues' } as const;

function getWorker(id: number) {
  const w = get<WorkerRow>('SELECT * FROM workers WHERE id = ?', id);
  if (!w) throw notFound('Worker');
  return w;
}

/** Resource names for the bindings, so the UI can show "DB → tienda". */
function bindingLabels(bindings: Binding[]) {
  return bindings.map((b) => {
    const table = BINDING_TABLES[b.type];
    const row = get<{ name: string }>(`SELECT name FROM ${table} WHERE id = ?`, b.id);
    return { ...b, resource: row?.name ?? '(eliminado)' };
  });
}

function present(w: WorkerRow) {
  const { token: _t, secrets, code: _c, ...rest } = w;
  const host = workerHostname(w);
  return {
    ...rest,
    enabled: !!w.enabled,
    subdomain: !!w.subdomain,
    routes: workerRoutes(w),
    crons: workerCrons(w).map((c) => {
      try {
        return { cron: c, next: nextRuns(c, 3) };
      } catch {
        return { cron: c, next: [] };
      }
    }),
    vars: JSON.parse(w.vars || '{}') as Record<string, string>,
    secrets: Object.keys(JSON.parse(secrets || '{}') as Record<string, string>),
    bindings: bindingLabels(workerBindings(w)),
    url: host ? `https://${host}` : null,
    port: workerPort(w.id),
    consumes: all<{ id: number; name: string }>('SELECT id, name FROM queues WHERE consumer_worker_id = ?', w.id),
  };
}

/** Ensures *.workers.<base> points here when the base domain's zone is ours. */
async function ensureWorkersDns() {
  if (!config.workersDomain || !config.baseDomain || !config.workersDomain.endsWith(`.${config.baseDomain}`)) return;
  try {
    const rel = config.workersDomain.slice(0, -(config.baseDomain.length + 1));
    await dns.setRecords(config.baseDomain, `*.${rel}`, 'A', [config.serverIp]);
  } catch {
    /* zone not managed here: the admin adds the record manually */
  }
}

const routePattern = z
  .string()
  .trim()
  .toLowerCase()
  .refine((v) => {
    const [host, ...rest] = v.replace(/^https?:\/\//, '').split('/');
    const path = `/${rest.join('/')}`;
    return HOST_RE.test(host ?? '') && /^\/[\w\-./*~%]*$/.test(path) && !path.slice(0, -1).includes('*');
  }, 'Ruta no válida. Ejemplos: ejemplo.com/*, api.ejemplo.com/v1/*, ejemplo.com/webhook');

const settingsInput = z.object({
  routes: z.array(routePattern).max(50).default([]),
  subdomain: z.boolean().default(true),
  crons: z
    .array(
      z
        .string()
        .trim()
        .refine((c) => {
          try {
            parseCron(c);
            return true;
          } catch {
            return false;
          }
        }, 'Expresión cron no válida (5 campos, por ejemplo */5 * * * *)'),
    )
    .max(5)
    .default([]),
  vars: z.record(z.string().regex(IDENT, 'Nombre de variable no válido'), z.string().max(5000)).default({}),
  bindings: z
    .array(z.object({ type: z.enum(['sql', 'nosql', 'kv', 'bucket', 'queue']), name: z.string().regex(IDENT, 'Nombre de binding no válido (p. ej. DB, KV, BUCKET)'), id: z.number().int().positive() }))
    .max(30)
    .default([]),
  memory_mb: z.number().int().min(64).max(2048).default(128),
  enabled: z.boolean().default(true),
});

function validateBindings(bindings: Binding[], vars: Record<string, string>) {
  const names = new Set<string>();
  for (const b of bindings) {
    if (names.has(b.name) || b.name in vars) throw badRequest(`El nombre ${b.name} está repetido`);
    names.add(b.name);
    const table = BINDING_TABLES[b.type];
    if (!get(`SELECT 1 FROM ${table} WHERE id = ?`, b.id)) throw badRequest(`El recurso del binding ${b.name} no existe`);
  }
}

/** Restarts a deployed Worker so new settings (vars, bindings, secrets) apply. */
async function restartWithSettings(w: WorkerRow) {
  if (!w.version) return { ok: true };
  if (!w.enabled) {
    await stopWorkerProcess(w.id);
    run("UPDATE workers SET status = 'stopped' WHERE id = ?", w.id);
    return { ok: true };
  }
  return launchWorker(w, w.code, w.code);
}

export default async function workerRoutesPlugin(app: FastifyInstance) {
  app.get('/api/workers/templates', async () =>
    Object.entries(WORKER_TEMPLATES).map(([id, t]) => ({ id, label: t.label, description: t.description })),
  );

  /** Everything a Worker can be bound to. */
  app.get('/api/workers/resources', async () => ({
    sql: all<DatabaseRow>('SELECT id, name FROM databases ORDER BY name'),
    nosql: all<{ id: number; name: string }>('SELECT id, name FROM nosql_databases ORDER BY name'),
    kv: all<{ id: number; name: string }>('SELECT id, name FROM kv_namespaces ORDER BY name'),
    bucket: all<BucketRow>('SELECT id, name FROM buckets ORDER BY name'),
    queue: all<QueueRow>('SELECT id, name FROM queues ORDER BY name'),
  }));

  app.get('/api/workers', async () => {
    const hour = Math.floor(Date.now() / 3600_000);
    return all<WorkerRow>('SELECT * FROM workers ORDER BY name').map((w) => {
      const m = get<{ requests: number; errors: number }>(
        'SELECT COALESCE(SUM(requests), 0) AS requests, COALESCE(SUM(errors), 0) AS errors FROM worker_metrics WHERE worker_id = ? AND hour > ?',
        w.id,
        hour - 24,
      )!;
      return { ...present(w), requests_24h: m.requests, errors_24h: m.errors };
    });
  });

  app.post('/api/workers', async (req) => {
    const body = parse(
      z.object({
        name: z.string().trim().toLowerCase().regex(WORKER_NAME_RE, 'Nombre: minúsculas, números y guiones (máx. 63)'),
        template: z.string().default('hello'),
      }),
      req.body,
    );
    if (get('SELECT 1 FROM workers WHERE name = ?', body.name)) throw badRequest('Ya existe un Worker con ese nombre');
    const code = (WORKER_TEMPLATES[body.template] ?? WORKER_TEMPLATES.hello!).code;
    const { id } = run('INSERT INTO workers (name, code, version, token) VALUES (?, ?, 1, ?)', body.name, code, randomToken(32));
    run('INSERT INTO worker_versions (worker_id, version, code, message, created_by) VALUES (?, 1, ?, ?, ?)', id, code, 'Versión inicial', req.user!.username);
    run("UPDATE workers SET deployed_at = datetime('now') WHERE id = ?", id);
    const result = await launchWorker(getWorker(id), code);
    await ensureWorkersDns();
    await syncCaddy().catch(() => {});
    audit(req.user!.username, 'worker.create', body.name, req.ip);
    return { ...present(getWorker(id)), deploy: result };
  });

  app.get('/api/workers/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const w = getWorker(id);
    return { ...present(w), code: w.code };
  });

  // Deploy new code (a new version). If it doesn't start, the previous one keeps running.
  app.put('/api/workers/:id/code', async (req) => {
    const { id } = parse(idParam, req.params);
    const w = getWorker(id);
    const body = parse(z.object({ code: z.string().min(1).max(2_000_000), message: z.string().trim().max(200).default('') }), req.body);
    const syntax = checkSyntax(body.code);
    if (syntax) return { ok: false, error: syntax, stage: 'syntax' };
    const version = w.version + 1;
    run('UPDATE workers SET code = ?, version = ?, deployed_at = datetime(\'now\') WHERE id = ?', body.code, version, id);
    run('INSERT INTO worker_versions (worker_id, version, code, message, created_by) VALUES (?, ?, ?, ?, ?)', id, version, body.code, body.message, req.user!.username);
    const updated = getWorker(id);
    const result = updated.enabled ? await launchWorker(updated, body.code, w.version ? w.code : undefined) : { ok: true };
    if (!result.ok && w.version) {
      // The previous version keeps serving: record that the new one failed.
      run('UPDATE workers SET code = ?, version = ? WHERE id = ?', w.code, w.version, id);
      run('DELETE FROM worker_versions WHERE worker_id = ? AND version = ?', id, version);
    }
    scheduleCaddySync();
    audit(req.user!.username, 'worker.deploy', `${w.name} v${result.ok ? version : w.version}`, req.ip);
    return { ...result, version: result.ok ? version : w.version, stage: result.ok ? 'done' : 'start' };
  });

  app.put('/api/workers/:id/settings', async (req) => {
    const { id } = parse(idParam, req.params);
    const w = getWorker(id);
    const body = parse(settingsInput, req.body);
    validateBindings(body.bindings, body.vars);
    for (const r of body.routes) {
      const other = all<WorkerRow>('SELECT id, name, routes FROM workers WHERE id != ?', id).find((x) => workerRoutes(x).includes(r));
      if (other) throw badRequest(`La ruta ${r} ya la usa el Worker "${other.name}"`);
    }
    run(
      'UPDATE workers SET routes = ?, subdomain = ?, crons = ?, vars = ?, bindings = ?, memory_mb = ?, enabled = ? WHERE id = ?',
      JSON.stringify([...new Set(body.routes)]),
      Number(body.subdomain),
      JSON.stringify([...new Set(body.crons)]),
      JSON.stringify(body.vars),
      JSON.stringify(body.bindings),
      body.memory_mb,
      Number(body.enabled),
      id,
    );
    const result = await restartWithSettings(getWorker(id));
    await syncCaddy().catch(() => {});
    audit(req.user!.username, 'worker.settings', w.name, req.ip);
    return { ...present(getWorker(id)), deploy: result };
  });

  app.put('/api/workers/:id/secrets', async (req) => {
    const { id } = parse(idParam, req.params);
    const w = getWorker(id);
    const body = parse(z.object({ name: z.string().regex(IDENT, 'Nombre no válido'), value: z.string().min(1).max(5000) }), req.body);
    const secrets = JSON.parse(w.secrets || '{}') as Record<string, string>;
    secrets[body.name] = encrypt(body.value);
    run('UPDATE workers SET secrets = ? WHERE id = ?', JSON.stringify(secrets), id);
    const result = await restartWithSettings(getWorker(id));
    audit(req.user!.username, 'worker.secret', `${w.name}: ${body.name}`, req.ip);
    return { ok: result.ok, error: result.error };
  });

  app.delete('/api/workers/:id/secrets/:name', async (req) => {
    const { id, name } = parse(idParam.extend({ name: z.string().regex(IDENT) }), req.params);
    const w = getWorker(id);
    const secrets = JSON.parse(w.secrets || '{}') as Record<string, string>;
    delete secrets[name];
    run('UPDATE workers SET secrets = ? WHERE id = ?', JSON.stringify(secrets), id);
    await restartWithSettings(getWorker(id));
    return { ok: true };
  });

  app.get('/api/workers/:id/versions', async (req) => {
    const { id } = parse(idParam, req.params);
    return all('SELECT id, version, message, created_by, created_at, length(code) AS size FROM worker_versions WHERE worker_id = ? ORDER BY version DESC LIMIT 50', id);
  });

  app.get('/api/workers/:id/versions/:version', async (req) => {
    const { id, version } = parse(idParam.extend({ version: z.coerce.number().int() }), req.params);
    const v = get('SELECT * FROM worker_versions WHERE worker_id = ? AND version = ?', id, version);
    if (!v) throw notFound('Versión');
    return v;
  });

  app.post('/api/workers/:id/rollback', async (req) => {
    const { id } = parse(idParam, req.params);
    const w = getWorker(id);
    const { version } = parse(z.object({ version: z.number().int() }), req.body);
    const v = get<{ code: string }>('SELECT code FROM worker_versions WHERE worker_id = ? AND version = ?', id, version);
    if (!v) throw notFound('Versión');
    const next = w.version + 1;
    run('UPDATE workers SET code = ?, version = ?, deployed_at = datetime(\'now\') WHERE id = ?', v.code, next, id);
    run('INSERT INTO worker_versions (worker_id, version, code, message, created_by) VALUES (?, ?, ?, ?, ?)', id, next, v.code, `Vuelta a la versión ${version}`, req.user!.username);
    const result = await launchWorker(getWorker(id), v.code, w.code);
    audit(req.user!.username, 'worker.rollback', `${w.name} → v${version}`, req.ip);
    return { ...result, version: next };
  });

  app.get('/api/workers/:id/events', async (req) => {
    const { id } = parse(idParam, req.params);
    const { after } = parse(z.object({ after: z.coerce.number().int().default(0) }), req.query);
    return workerEvents(id, after);
  });

  app.get('/api/workers/:id/metrics', async (req) => {
    const { id } = parse(idParam, req.params);
    const { hours } = parse(z.object({ hours: z.coerce.number().int().min(1).max(24 * 30).default(24) }), req.query);
    return workerMetrics(id, hours);
  });

  /** Sends a test request straight to the Worker (the editor's HTTP panel). */
  app.post('/api/workers/:id/test', async (req) => {
    const { id } = parse(idParam, req.params);
    const w = getWorker(id);
    const body = parse(
      z.object({
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).default('GET'),
        path: z.string().max(2000).default('/'),
        headers: z.record(z.string(), z.string()).default({}),
        body: z.string().max(1_000_000).optional(),
      }),
      req.body,
    );
    if (w.status !== 'running') throw badRequest('El Worker no está en marcha');
    const host = workerHostname(w) ?? workerRoutes(w)[0]?.split('/')[0] ?? 'localhost';
    const started = performance.now();
    const res = await fetch(`http://127.0.0.1:${workerPort(id)}${body.path.startsWith('/') ? body.path : `/${body.path}`}`, {
      method: body.method,
      headers: { 'x-forwarded-host': host, 'x-forwarded-proto': 'https', 'x-forwarded-for': req.ip, ...body.headers },
      body: ['GET', 'HEAD'].includes(body.method) ? undefined : body.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    }).catch((err: Error) => {
      throw badRequest(`No se pudo contactar con el Worker: ${err.message}`);
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const type = res.headers.get('content-type') ?? '';
    const isText = /text|json|xml|javascript|html|csv/.test(type) || (!type && buf.length < 100_000);
    return {
      status: res.status,
      statusText: res.statusText,
      headers: Object.fromEntries(res.headers.entries()),
      duration: Math.round((performance.now() - started) * 10) / 10,
      size: buf.length,
      body: isText ? buf.subarray(0, 256 * 1024).toString('utf8') : null,
      truncated: isText && buf.length > 256 * 1024,
    };
  });

  app.post('/api/workers/:id/cron', async (req) => {
    const { id } = parse(idParam, req.params);
    const w = getWorker(id);
    const { cron } = parse(z.object({ cron: z.string().default('manual') }), req.body ?? {});
    const res = await triggerWorker(w, '/__hp/scheduled', { cron, scheduledTime: Date.now() }, 60_000);
    return { ok: res.ok };
  });

  app.delete('/api/workers/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const w = getWorker(id);
    run('DELETE FROM workers WHERE id = ?', id);
    await syncCaddy().catch(() => {});
    await removeWorkerFiles(id);
    audit(req.user!.username, 'worker.delete', w.name, req.ip);
    return { ok: true };
  });
}
