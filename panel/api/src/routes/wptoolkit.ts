/**
 * WordPress toolkit routes: /api/sites/:id/wordpress/toolkit/…
 * Long operations (updates, staging clone and push) run as jobs, one at a time per site.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, get, type SiteRow } from '../db.ts';
import { badRequest, hostname, idParam, notFound, parse } from '../lib/validate.ts';
import { runningJob, startJob } from '../services/jobs.ts';
import {
  clearDebugLog,
  cloneToStaging,
  createStagingSite,
  itemAction,
  pushStagingToLive,
  readDebugLog,
  runUpdates,
  setAutoUpdate,
  setDebugLog,
  setMaintenance,
  siteUrl,
  stagingPair,
  wpStatus,
} from '../services/wptoolkit.ts';

function getWpSite(id: number) {
  const s = get<SiteRow>('SELECT * FROM sites WHERE id = ?', id);
  if (!s) throw notFound('Sitio');
  if (s.source !== 'wordpress') throw badRequest('Este sitio no es un WordPress');
  return s;
}

function getInstalled(id: number) {
  const s = getWpSite(id);
  if (!s.active_release) throw badRequest('WordPress todavía no está instalado');
  return s;
}

const jobKind = (siteId: number) => `wordpress-${siteId}`;

function assertIdle(siteId: number) {
  const job = runningJob(jobKind(siteId));
  if (job) throw badRequest('Ya hay una operación de WordPress en curso en este sitio. Espera a que termine.');
}

const slugList = z.array(z.string().regex(/^[A-Za-z0-9._-]{1,200}$/)).max(200);
const updateInput = z.object({
  core: z.boolean().default(false),
  plugins: z.union([z.literal('all'), slugList]).default([]),
  themes: z.union([z.literal('all'), slugList]).default([]),
});

const itemParams = idParam.extend({
  kind: z.enum(['plugins', 'themes']),
  name: z.string().regex(/^[A-Za-z0-9._-]{1,200}$/, 'Nombre no válido'),
});

const settingsInput = z.object({
  maintenance: z.boolean().optional(),
  debug_log: z.boolean().optional(),
  auto_update: z.object({ core_minor: z.boolean(), plugins_minor: z.boolean() }).optional(),
});

const stagingInput = z.object({ hostname: hostname.refine((h) => !h.startsWith('*.'), 'Usa un subdominio concreto, no un comodín') });
const pushInput = z.object({ files: z.boolean().default(true), database: z.boolean().default(true) }).refine((v) => v.files || v.database, 'Elige archivos, base de datos o ambos');

export default async function wpToolkitRoutes(app: FastifyInstance) {
  app.get('/api/sites/:id/wordpress/toolkit', async (req) => {
    const site = getWpSite(parse(idParam, req.params).id);
    // A push started from the staging side runs as a job of the live site: show it on both.
    const pair = stagingPair(site);
    const job = runningJob(jobKind(site.id)) ?? (pair && pair.live.id !== site.id ? runningJob(jobKind(pair.live.id)) : undefined);
    return { ...(await wpStatus(site)), job: job ? { id: job.id, title: job.title } : null };
  });

  app.post('/api/sites/:id/wordpress/toolkit/update', async (req) => {
    const site = getInstalled(parse(idParam, req.params).id);
    const body = parse(updateInput, req.body);
    if (!body.core && !body.plugins.length && !body.themes.length) throw badRequest('No hay nada que actualizar');
    assertIdle(site.id);
    const what = [body.core && 'núcleo', body.plugins === 'all' ? 'todos los plugins' : body.plugins.length && `${body.plugins.length} plugin(s)`, body.themes === 'all' ? 'todos los temas' : body.themes.length && `${body.themes.length} tema(s)`]
      .filter(Boolean)
      .join(', ');
    const jobId = startJob(jobKind(site.id), `Actualizar WordPress (${what}) · ${site.name}`, req.user!.username, (log) => runUpdates(site, body, log));
    audit(req.user!.username, 'wordpress.update', `${site.name}: ${what}`, req.ip);
    return { job_id: jobId };
  });

  app.post('/api/sites/:id/wordpress/toolkit/:kind/:name/:action', async (req) => {
    const p = parse(itemParams.extend({ action: z.enum(['activate', 'deactivate', 'delete']) }), req.params);
    const site = getInstalled(p.id);
    assertIdle(site.id);
    await itemAction(site, p.kind === 'plugins' ? 'plugin' : 'theme', p.name, p.action);
    audit(req.user!.username, `wordpress.${p.kind}.${p.action}`, `${site.name}: ${p.name}`, req.ip);
    return { ok: true };
  });

  app.put('/api/sites/:id/wordpress/toolkit/settings', async (req) => {
    const site = getInstalled(parse(idParam, req.params).id);
    const body = parse(settingsInput, req.body);
    if (body.maintenance !== undefined) await setMaintenance(site, body.maintenance);
    if (body.debug_log !== undefined) await setDebugLog(site, body.debug_log);
    if (body.auto_update) await setAutoUpdate(site, body.auto_update);
    audit(req.user!.username, 'wordpress.settings', `${site.name}: ${JSON.stringify(body)}`, req.ip);
    return { ok: true };
  });

  app.get('/api/sites/:id/wordpress/toolkit/debug-log', async (req) => {
    const site = getInstalled(parse(idParam, req.params).id);
    return { log: readDebugLog(site) };
  });

  app.delete('/api/sites/:id/wordpress/toolkit/debug-log', async (req) => {
    const site = getInstalled(parse(idParam, req.params).id);
    await clearDebugLog(site);
    return { ok: true };
  });

  // --- staging ---------------------------------------------------------------------------
  app.post('/api/sites/:id/wordpress/toolkit/staging', async (req) => {
    const live = getInstalled(parse(idParam, req.params).id);
    const { hostname: host } = parse(stagingInput, req.body);
    assertIdle(live.id);
    const stagingId = await createStagingSite(live, host);
    const staging = get<SiteRow>('SELECT * FROM sites WHERE id = ?', stagingId)!;
    const jobId = startJob(jobKind(live.id), `Crear staging de ${live.name} en ${host}`, req.user!.username, (log) => cloneToStaging(live, staging, log));
    audit(req.user!.username, 'wordpress.staging.create', `${live.name} → ${host}`, req.ip);
    return { job_id: jobId, staging_id: stagingId, url: siteUrl(staging) };
  });

  app.post('/api/sites/:id/wordpress/toolkit/staging/push', async (req) => {
    const site = getInstalled(parse(idParam, req.params).id);
    const parts = parse(pushInput, req.body);
    const pair = stagingPair(site);
    if (!pair) throw badRequest('Este WordPress no tiene staging');
    if (!pair.staging.active_release) throw badRequest('El staging todavía se está preparando');
    assertIdle(pair.live.id);
    assertIdle(pair.staging.id);
    const jobId = startJob(jobKind(pair.live.id), `Publicar staging en ${pair.live.name}`, req.user!.username, (log) =>
      pushStagingToLive(pair.live, pair.staging, parts, log),
    );
    audit(req.user!.username, 'wordpress.staging.push', `${pair.staging.name} → ${pair.live.name}`, req.ip);
    return { job_id: jobId, live_id: pair.live.id };
  });
}
