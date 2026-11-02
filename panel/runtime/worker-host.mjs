// =====================================================================================
//  HostPanel Workers runtime
//
//  Runs ONE Worker module with the Cloudflare Workers API:
//    export default { fetch(request, env, ctx), queue(batch, env, ctx), scheduled(event, env, ctx) }
//
//  Usage: node --permission --allow-fs-read=<dir> worker-host.mjs <dir>
//  <dir> contains worker.mjs (the code) and config.json (port, token, vars, bindings).
//  Bindings (D1, R2, KV, Queues) are proxied to the panel's internal API with the
//  Worker's own token, which only grants access to the resources bound to it.
//  No dependencies on purpose: this file runs as an unprivileged, sandboxed process.
// =====================================================================================
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { inspect } from 'node:util';

const dir = process.argv[2];
if (!dir) {
  console.error('Uso: worker-host.mjs <directorio del worker>');
  process.exit(2);
}
const cfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
const API = cfg.internal;
const AUTH = { authorization: `Bearer ${cfg.token}` };

// --- logging: console output is attached to the request that produced it ------------
const als = new AsyncLocalStorage();
const pending = [];
const fmt = (a) => (typeof a === 'string' ? a : inspect(a, { depth: 4, breakLength: 120 }));
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    const message = args.map(fmt).join(' ').slice(0, 4000);
    const store = als.getStore();
    if (store) {
      if (store.logs.length < 200) store.logs.push({ level, message });
    } else {
      pending.push({ type: 'log', ts: Date.now(), logs: [{ level, message }] });
    }
    original(...args);
  };
}

function report(event) {
  pending.push(event);
  if (pending.length > 1000) pending.splice(0, pending.length - 1000);
}
async function flush() {
  if (!pending.length) return;
  const events = pending.splice(0, pending.length);
  try {
    await fetch(`${API}/events`, { method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: JSON.stringify({ events }) });
  } catch {
    /* panel restarting: drop these log lines */
  }
}
setInterval(flush, 700).unref();

// --- bindings ----------------------------------------------------------------------
async function call(path, body) {
  const res = await fetch(`${API}${path}`, { method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

function d1Binding(id) {
  const run = (statements, raw = false) => call(`/d1/${id}`, { statements, raw });
  const shape = (r) => ({ success: true, results: r.results, meta: r.meta });
  class Statement {
    constructor(sql, params = []) {
      this.sql = sql;
      this.params = params;
    }
    bind(...params) {
      return new Statement(this.sql, params);
    }
    async all() {
      return shape((await run([{ sql: this.sql, params: this.params }])).results[0]);
    }
    async run() {
      return this.all();
    }
    async first(column) {
      const row = (await run([{ sql: this.sql, params: this.params }])).results[0].results[0];
      if (!row) return null;
      return column === undefined ? row : (row[column] ?? null);
    }
    async raw(options = {}) {
      const r = (await run([{ sql: this.sql, params: this.params }], true)).results[0];
      return options.columnNames ? [r.columns, ...r.rows] : r.rows;
    }
  }
  return {
    prepare: (sql) => new Statement(sql),
    batch: async (statements) => (await run(statements.map((s) => ({ sql: s.sql, params: s.params })))).results.map(shape),
    exec: async (sql) => {
      const statements = sql.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);
      const started = performance.now();
      if (statements.length) await run(statements.map((s) => ({ sql: s, params: [] })));
      return { count: statements.length, duration: performance.now() - started };
    },
  };
}

const toBody = (value) => (value instanceof ReadableStream || value instanceof ArrayBuffer || ArrayBuffer.isView(value) || value instanceof Blob || typeof value === 'string' ? value : JSON.stringify(value));
const streamInit = (body) => (body instanceof ReadableStream ? { body, duplex: 'half' } : { body });

function kvBinding(id) {
  const url = (key) => `${API}/kv/${id}/value?key=${encodeURIComponent(key)}`;
  const read = async (res, type) => {
    if (type === 'json') return res.json();
    if (type === 'arrayBuffer') return res.arrayBuffer();
    if (type === 'stream') return res.body;
    return res.text();
  };
  const get = async (key, options) => {
    const type = typeof options === 'string' ? options : (options?.type ?? 'text');
    const res = await fetch(url(key), { headers: AUTH });
    if (res.status === 404) return { value: null, metadata: null };
    if (!res.ok) throw new Error(`KV: ${res.status}`);
    const meta = res.headers.get('x-hp-metadata');
    return { value: await read(res, type), metadata: meta ? JSON.parse(meta) : null };
  };
  return {
    get: async (key, options) => (await get(key, options)).value,
    getWithMetadata: get,
    async put(key, value, options = {}) {
      const headers = { ...AUTH };
      if (options.expirationTtl) headers['x-hp-ttl'] = String(options.expirationTtl);
      if (options.expiration) headers['x-hp-expiration'] = String(options.expiration);
      if (options.metadata !== undefined) headers['x-hp-metadata'] = JSON.stringify(options.metadata);
      const res = await fetch(url(key), { method: 'PUT', headers, ...streamInit(toBody(value)) });
      if (!res.ok) throw new Error(`KV put: ${(await res.json().catch(() => ({}))).error ?? res.status}`);
    },
    async delete(key) {
      await fetch(url(key), { method: 'DELETE', headers: AUTH });
    },
    list: (options = {}) => call(`/kv/${id}/list`, options),
  };
}

function r2Binding(id) {
  const url = (key) => `${API}/r2/${id}/object?key=${encodeURIComponent(key)}`;
  const object = (key, res, withBody) => {
    const h = res.headers;
    const obj = {
      key,
      size: Number(h.get('content-length') ?? 0),
      etag: (h.get('etag') ?? '').replace(/"/g, ''),
      httpEtag: h.get('etag') ?? '',
      uploaded: new Date(h.get('last-modified') ?? Date.now()),
      httpMetadata: { contentType: h.get('content-type') ?? undefined },
      customMetadata: {},
      writeHttpMetadata(headers) {
        if (this.httpMetadata.contentType) headers.set('content-type', this.httpMetadata.contentType);
      },
    };
    if (withBody) {
      Object.assign(obj, {
        body: res.body,
        get bodyUsed() {
          return res.bodyUsed;
        },
        text: () => res.text(),
        json: () => res.json(),
        arrayBuffer: () => res.arrayBuffer(),
        blob: () => res.blob(),
      });
    }
    return obj;
  };
  return {
    async get(key) {
      const res = await fetch(url(key), { headers: AUTH });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`R2 get: ${res.status}`);
      return object(key, res, true);
    },
    async head(key) {
      const res = await fetch(url(key), { method: 'HEAD', headers: AUTH });
      if (res.status === 404) return null;
      return object(key, res, false);
    },
    async put(key, value, options = {}) {
      const headers = { ...AUTH };
      const type = options.httpMetadata?.contentType ?? (options.httpMetadata instanceof Headers ? options.httpMetadata.get('content-type') : undefined);
      if (type) headers['content-type'] = type;
      const res = await fetch(url(key), { method: 'PUT', headers, ...streamInit(toBody(value ?? '')) });
      if (!res.ok) throw new Error(`R2 put: ${(await res.json().catch(() => ({}))).error ?? res.status}`);
      return this.head(key);
    },
    async delete(keys) {
      await call(`/r2/${id}/delete`, { keys: Array.isArray(keys) ? keys : [keys] });
    },
    list: (options = {}) => call(`/r2/${id}/list`, options),
  };
}

function queueBinding(id) {
  const message = (m, defaults = {}) => ({
    body: m.body,
    contentType: m.contentType ?? defaults.contentType ?? 'json',
    delaySeconds: m.delaySeconds ?? defaults.delaySeconds ?? 0,
  });
  return {
    async send(body, options = {}) {
      await call(`/queues/${id}/send`, { messages: [message({ body, ...options })] });
    },
    async sendBatch(messages, options = {}) {
      await call(`/queues/${id}/send`, { messages: messages.map((m) => message(m, options)) });
    },
  };
}

const env = { ...cfg.vars, ...cfg.secrets };
for (const b of cfg.bindings) {
  if (b.type === 'd1') env[b.name] = d1Binding(b.id);
  else if (b.type === 'kv') env[b.name] = kvBinding(b.id);
  else if (b.type === 'r2') env[b.name] = r2Binding(b.id);
  else if (b.type === 'queue') env[b.name] = queueBinding(b.id);
}

// --- the Worker ----------------------------------------------------------------------
let mod;
try {
  mod = (await import(pathToFileURL(join(dir, 'worker.mjs')).href)).default;
} catch (err) {
  console.error('No se pudo cargar el Worker:', err);
  await flush();
  process.exit(1);
}
if (!mod || typeof mod !== 'object') {
  console.error('El Worker debe exportar por defecto un objeto: export default { async fetch(request, env, ctx) { … } }');
  await flush();
  process.exit(1);
}

function makeCtx() {
  const waits = [];
  return {
    waits,
    ctx: {
      waitUntil(promise) {
        waits.push(Promise.resolve(promise).catch((err) => console.error(err)));
      },
      passThroughOnException() {},
    },
  };
}

const errorText = (err) => (err instanceof Error ? err.stack || err.message : String(err)).slice(0, 4000);

async function handleFetch(req, res) {
  const started = performance.now();
  const store = { logs: [] };
  await als.run(store, async () => {
    const proto = req.headers['x-forwarded-proto'] || 'https';
    // Caddy sets X-Forwarded-Host to the real domain (and overwrites any value from clients).
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const url = `${proto}://${host}${req.url}`;
    const headers = new Headers();
    for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
    const init = { method: req.method, headers };
    if (req.method !== 'GET' && req.method !== 'HEAD') Object.assign(init, { body: Readable.toWeb(req), duplex: 'half' });
    const request = new Request(url, init);
    // Like Cloudflare's request.cf, with what this server knows.
    request.cf = { clientIp: headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? req.socket.remoteAddress };
    const { ctx, waits } = makeCtx();
    let response;
    let exception = null;
    try {
      if (typeof mod.fetch !== 'function') throw new Error('Este Worker no tiene un manejador fetch()');
      response = await mod.fetch(request, env, ctx);
      if (!(response instanceof Response)) throw new Error('fetch() debe devolver un objeto Response');
    } catch (err) {
      exception = errorText(err);
      console.error(err);
      response = new Response('Error interno del Worker', { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    const out = {};
    response.headers.forEach((value, key) => {
      if (key !== 'set-cookie') out[key] = value;
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) out['set-cookie'] = cookies;
    res.writeHead(response.status, response.statusText, out);
    try {
      if (response.body && req.method !== 'HEAD') await pipeline(Readable.fromWeb(response.body), res);
      else res.end();
    } catch (err) {
      exception ??= errorText(err);
      res.destroy();
    }
    await Promise.allSettled(waits);
    report({
      type: 'fetch',
      ts: Date.now(),
      method: req.method,
      url,
      status: response.status,
      duration: Math.round((performance.now() - started) * 10) / 10,
      ip: request.cf.clientIp,
      logs: store.logs,
      exception,
    });
  });
}

async function readJson(req) {
  let text = '';
  for await (const chunk of req) text += chunk;
  return JSON.parse(text || '{}');
}

async function handleQueue(req, res) {
  const input = await readJson(req);
  const started = performance.now();
  const store = { logs: [] };
  const results = new Map();
  let all = null;
  let exception = null;
  await als.run(store, async () => {
    const messages = input.messages.map((m) => ({
      id: String(m.id),
      timestamp: new Date(m.timestamp),
      body: m.body,
      attempts: m.attempts,
      ack: () => results.set(String(m.id), { action: 'ack' }),
      retry: (o = {}) => results.set(String(m.id), { action: 'retry', delaySeconds: o.delaySeconds }),
    }));
    const batch = {
      queue: input.queue,
      messages,
      ackAll: () => (all = { action: 'ack' }),
      retryAll: (o = {}) => (all = { action: 'retry', delaySeconds: o.delaySeconds }),
    };
    const { ctx, waits } = makeCtx();
    try {
      if (typeof mod.queue !== 'function') throw new Error('Este Worker no tiene un manejador queue()');
      await mod.queue(batch, env, ctx);
      await Promise.allSettled(waits);
    } catch (err) {
      exception = errorText(err);
      console.error(err);
    }
  });
  // Messages not explicitly acked/retried: acked on success, retried on error.
  const fallback = all ?? (exception ? { action: 'retry' } : { action: 'ack' });
  const out = input.messages.map((m) => ({ id: m.id, ...(results.get(String(m.id)) ?? fallback) }));
  report({ type: 'queue', ts: Date.now(), queue: input.queue, count: input.messages.length, duration: Math.round(performance.now() - started), logs: store.logs, exception });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ results: out }));
}

async function handleScheduled(req, res) {
  const input = await readJson(req);
  const started = performance.now();
  const store = { logs: [] };
  let exception = null;
  await als.run(store, async () => {
    const { ctx, waits } = makeCtx();
    try {
      if (typeof mod.scheduled !== 'function') throw new Error('Este Worker no tiene un manejador scheduled()');
      await mod.scheduled({ type: 'scheduled', cron: input.cron, scheduledTime: input.scheduledTime }, env, ctx);
      await Promise.allSettled(waits);
    } catch (err) {
      exception = errorText(err);
      console.error(err);
    }
  });
  report({ type: 'scheduled', ts: Date.now(), cron: input.cron, duration: Math.round(performance.now() - started), logs: store.logs, exception });
  res.writeHead(exception ? 500 : 200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: !exception }));
}

const server = http.createServer((req, res) => {
  // Internal triggers from the panel (queue batches, cron) carry the Worker's token.
  if (req.url.startsWith('/__hp/')) {
    if (req.headers['x-hp-token'] !== cfg.token) {
      res.writeHead(403).end();
      return;
    }
    const handler = req.url === '/__hp/queue' ? handleQueue : req.url === '/__hp/scheduled' ? handleScheduled : null;
    if (!handler) {
      res.writeHead(404).end();
      return;
    }
    handler(req, res).catch((err) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    });
    return;
  }
  handleFetch(req, res).catch((err) => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
    console.error(err);
  });
});
server.keepAliveTimeout = 65_000;
server.listen(cfg.port, '127.0.0.1', () => console.info(`Worker "${cfg.name}" v${cfg.version} listo en el puerto ${cfg.port}`));

const stop = () => {
  server.close();
  flush().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('unhandledRejection', (err) => console.error('Promesa rechazada sin capturar:', err));
