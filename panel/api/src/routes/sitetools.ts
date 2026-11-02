/**
 * Day-to-day tools of a site: file manager, backups, cron jobs and PHP settings.
 */
import type { FastifyInstance } from 'fastify';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import { all, audit, get, run, type BackupRow, type SiteCronRow, type SiteRow } from '../db.ts';
import { badRequest, idParam, notFound, parse } from '../lib/validate.ts';
import { backupArchive, backupDatabases, createBackup, deleteBackup, pruneBackups, restoreBackup } from '../services/backups.ts';
import { nextRuns, parseCron } from '../services/cron.ts';
import { enqueueDeploy } from '../services/deploy.ts';
import {
  extractArchive,
  fileRoots,
  folderSize,
  listDir,
  makeDir,
  openDownload,
  readText,
  removePaths,
  renamePath,
  saveUpload,
  writeText,
} from '../services/files.ts';
import { runningJob, startJob } from '../services/jobs.ts';
import { CRON_PRESETS, runSiteCron } from '../services/sitecrons.ts';
import { PHP_DEFAULTS, phpSettings } from '../services/system.ts';

function getSite(id: number) {
  const s = get<SiteRow>('SELECT * FROM sites WHERE id = ?', id);
  if (!s) throw notFound('Sitio');
  return s;
}

const rootQuery = z.object({ root: z.enum(['site', 'shared']).default('site'), path: z.string().max(4096).default('') });
const rootBody = z.object({ root: z.enum(['site', 'shared']).default('site') });

/** Uploads arrive as raw bodies (any content type), streamed to disk. */
async function uploadRoutes(app: FastifyInstance) {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', (_req, payload, done) => done(null, payload));
  app.put('/api/sites/:id/files/upload', async (req) => {
    const site = getSite(parse(idParam, req.params).id);
    const q = parse(rootQuery.extend({ overwrite: z.coerce.boolean().default(false) }), req.query);
    const r = await saveUpload(site, q.root, q.path, (req.body as Readable | undefined) ?? req.raw, q.overwrite);
    audit(req.user!.username, 'files.upload', `${site.name}: ${q.path}`, req.ip);
    return r;
  });
}

const cronInput = z.object({
  schedule: z
    .string()
    .trim()
    .max(100)
    .refine((v) => {
      try {
        parseCron(v);
        return true;
      } catch {
        return false;
      }
    }, 'Expresión cron no válida (5 campos: minuto hora día mes día-semana)'),
  command: z.string().trim().min(1, 'Escribe el comando').max(2000),
  note: z.string().trim().max(200).default(''),
  enabled: z.boolean().default(true),
});

const presentCron = (c: SiteCronRow) => {
  let next: string[] = [];
  try {
    next = c.enabled ? nextRuns(c.schedule, 3) : [];
  } catch {
    /* invalid legacy expression */
  }
  return { ...c, enabled: !!c.enabled, next };
};

const phpInput = z.object({
  memory_limit_mb: z.number().int().min(32).max(8192),
  upload_max_mb: z.number().int().min(1).max(4096),
  max_execution_time: z.number().int().min(5).max(3600),
  max_input_vars: z.number().int().min(100).max(100000),
  display_errors: z.boolean(),
  timezone: z.string().trim().regex(/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$|^UTC$/, 'Zona horaria no válida'),
});

export default async function siteToolRoutes(app: FastifyInstance) {
  await app.register(uploadRoutes);

  // --- file manager -----------------------------------------------------------------------
  app.get('/api/sites/:id/files/roots', async (req) => {
    const site = getSite(parse(idParam, req.params).id);
    const roots = fileRoots(site);
    return Promise.all(roots.map(async (r) => ({ ...r, size: await folderSize(site, r.id).catch(() => null) })));
  });

  app.get('/api/sites/:id/files', async (req) => {
    const site = getSite(parse(idParam, req.params).id);
    const q = parse(rootQuery, req.query);
    return listDir(site, q.root, q.path);
  });

  app.get('/api/sites/:id/files/content', async (req) => {
    const site = getSite(parse(idParam, req.params).id);
    const q = parse(rootQuery, req.query);
    return readText(site, q.root, q.path);
  });

  app.put('/api/sites/:id/files/content', async (req) => {
    const site = getSite(parse(idParam, req.params).id);
    const b = parse(
      rootBody.extend({ path: z.string().min(1).max(4096), content: z.string(), create: z.boolean().default(false), expected_modified: z.string().optional() }),
      req.body,
    );
    const r = await writeText(site, b.root, b.path, b.content, { create: b.create, expectedModified: b.expected_modified });
    audit(req.user!.username, b.create ? 'files.create' : 'files.edit', `${site.name}: ${b.path}`, req.ip);
    return r;
  });

  app.post('/api/sites/:id/files/mkdir', async (req) => {
    const site = getSite(parse(idParam, req.params).id);
    const b = parse(rootBody.extend({ path: z.string().min(1).max(4096) }), req.body);
    await makeDir(site, b.root, b.path);
    return { ok: true };
  });

  app.post('/api/sites/:id/files/rename', async (req) => {
    const site = getSite(parse(idParam, req.params).id);
    const b = parse(rootBody.extend({ from: z.string().min(1).max(4096), to: z.string().min(1).max(4096) }), req.body);
    await renamePath(site, b.root, b.from, b.to);
    audit(req.user!.username, 'files.rename', `${site.name}: ${b.from} → ${b.to}`, req.ip);
    return { ok: true };
  });

  app.post('/api/sites/:id/files/delete', async (req) => {
    const site = getSite(parse(idParam, req.params).id);
    const b = parse(rootBody.extend({ paths: z.array(z.string().min(1).max(4096)).min(1).max(500) }), req.body);
    await removePaths(site, b.root, b.paths);
    audit(req.user!.username, 'files.delete', `${site.name}: ${b.paths.join(', ').slice(0, 300)}`, req.ip);
    return { ok: true };
  });

  app.post('/api/sites/:id/files/extract', async (req) => {
    const site = getSite(parse(idParam, req.params).id);
    const b = parse(rootBody.extend({ path: z.string().min(1).max(4096) }), req.body);
    await extractArchive(site, b.root, b.path);
    audit(req.user!.username, 'files.extract', `${site.name}: ${b.path}`, req.ip);
    return { ok: true };
  });

  app.get('/api/sites/:id/files/download', async (req, reply) => {
    const site = getSite(parse(idParam, req.params).id);
    const q = parse(rootQuery, req.query);
    const f = await openDownload(site, q.root, q.path);
    return reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Length', f.size)
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`)
      .send(f.stream);
  });

  // --- backups ----------------------------------------------------------------------------
  app.get('/api/sites/:id/backups', async (req) => {
    const site = getSite(parse(idParam, req.params).id);
    const job = runningJob(`backup-${site.id}`);
    return {
      schedule: site.backup_schedule,
      keep: site.backup_keep,
      database_ids: JSON.parse(site.backup_databases || '[]') as number[],
      included_databases: backupDatabases(site).map((d) => ({ id: d.id, name: d.name })),
      available_databases: all<{ id: number; name: string }>('SELECT id, name FROM databases ORDER BY name'),
      wordpress: site.source === 'wordpress',
      job: job ?? null,
      backups: all<BackupRow>('SELECT * FROM backups WHERE site_id = ? ORDER BY id DESC LIMIT 200', site.id).map((b) => ({
        ...b,
        includes: JSON.parse(b.includes) as string[],
      })),
    };
  });

  app.put('/api/sites/:id/backups/settings', async (req) => {
    const site = getSite(parse(idParam, req.params).id);
    const b = parse(
      z.object({ schedule: z.enum(['off', 'daily', 'weekly']), keep: z.number().int().min(1).max(60), database_ids: z.array(z.number().int()).max(50).default([]) }),
      req.body,
    );
    const ids = b.database_ids.length ? all<{ id: number }>(`SELECT id FROM databases WHERE id IN (${b.database_ids.map(() => '?').join(',')})`, ...b.database_ids).map((d) => d.id) : [];
    run('UPDATE sites SET backup_schedule = ?, backup_keep = ?, backup_databases = ? WHERE id = ?', b.schedule, b.keep, JSON.stringify(ids), site.id);
    pruneBackups({ ...site, backup_keep: b.keep });
    audit(req.user!.username, 'backups.settings', `${site.name}: ${b.schedule}, ${b.keep}`, req.ip);
    return { ok: true };
  });

  app.post('/api/sites/:id/backups', async (req) => {
    const site = getSite(parse(idParam, req.params).id);
    const { note } = parse(z.object({ note: z.string().trim().max(200).default('') }), req.body ?? {});
    if (runningJob(`backup-${site.id}`)) throw badRequest('Ya hay una copia o restauración en curso para este sitio');
    audit(req.user!.username, 'backups.create', site.name, req.ip);
    return {
      job_id: startJob(`backup-${site.id}`, `Copia de seguridad de ${site.name}`, req.user!.username, async (log) => {
        await createBackup(site, 'manual', log, note);
      }),
    };
  });

  app.post('/api/sites/:id/backups/:backupId/restore', async (req) => {
    const p = parse(idParam.extend({ backupId: z.coerce.number().int() }), req.params);
    const site = getSite(p.id);
    const b = get<BackupRow>("SELECT * FROM backups WHERE id = ? AND site_id = ? AND status = 'success'", p.backupId, site.id);
    if (!b) throw notFound('Copia');
    const parts = parse(z.object({ files: z.boolean().default(true), databases: z.boolean().default(true) }), req.body ?? {});
    if (!parts.files && !parts.databases) throw badRequest('Elige qué restaurar');
    if (runningJob(`backup-${site.id}`)) throw badRequest('Ya hay una copia o restauración en curso para este sitio');
    audit(req.user!.username, 'backups.restore', `${site.name}: ${b.file}`, req.ip);
    return {
      job_id: startJob(`backup-${site.id}`, `Restaurar ${site.name} (${b.created_at})`, req.user!.username, (log) => restoreBackup(site, b, parts, log)),
    };
  });

  app.get('/api/sites/:id/backups/:backupId/download', async (req, reply) => {
    const p = parse(idParam.extend({ backupId: z.coerce.number().int() }), req.params);
    const site = getSite(p.id);
    const b = get<BackupRow>("SELECT * FROM backups WHERE id = ? AND site_id = ? AND status = 'success'", p.backupId, site.id);
    if (!b) throw notFound('Copia');
    audit(req.user!.username, 'backups.download', `${site.name}: ${b.file}`, req.ip);
    const safe = site.name.replace(/[^\w.-]+/g, '-').toLowerCase();
    return reply
      .header('Content-Type', 'application/x-tar')
      .header('Content-Disposition', `attachment; filename="${safe}-${b.file}.tar"`)
      .send(backupArchive(b));
  });

  app.delete('/api/sites/:id/backups/:backupId', async (req) => {
    const p = parse(idParam.extend({ backupId: z.coerce.number().int() }), req.params);
    const site = getSite(p.id);
    const b = get<BackupRow>('SELECT * FROM backups WHERE id = ? AND site_id = ?', p.backupId, site.id);
    if (!b) throw notFound('Copia');
    if (b.status === 'running') throw badRequest('La copia todavía se está creando');
    deleteBackup(b);
    audit(req.user!.username, 'backups.delete', `${site.name}: ${b.file}`, req.ip);
    return { ok: true };
  });

  // --- cron jobs -----------------------------------------------------------------------------
  app.get('/api/sites/:id/crons', async (req) => {
    const site = getSite(parse(idParam, req.params).id);
    return {
      presets: CRON_PRESETS,
      crons: all<SiteCronRow>('SELECT * FROM site_crons WHERE site_id = ? ORDER BY id', site.id).map(presentCron),
    };
  });

  app.get('/api/crons/preview', async (req) => {
    const { schedule } = parse(z.object({ schedule: z.string().max(100) }), req.query);
    try {
      return { ok: true, next: nextRuns(schedule, 3) };
    } catch (err) {
      return { ok: false, error: (err as Error).message, next: [] };
    }
  });

  app.post('/api/sites/:id/crons', async (req) => {
    const site = getSite(parse(idParam, req.params).id);
    const b = parse(cronInput, req.body);
    if ((get<{ n: number }>('SELECT COUNT(*) n FROM site_crons WHERE site_id = ?', site.id)?.n ?? 0) >= 50) throw badRequest('Máximo 50 tareas por sitio');
    const { id } = run('INSERT INTO site_crons (site_id, schedule, command, note, enabled) VALUES (?, ?, ?, ?, ?)', site.id, b.schedule, b.command, b.note, Number(b.enabled));
    audit(req.user!.username, 'cron.create', `${site.name}: ${b.schedule} ${b.command}`, req.ip);
    return presentCron(get<SiteCronRow>('SELECT * FROM site_crons WHERE id = ?', id)!);
  });

  app.put('/api/sites/:id/crons/:cronId', async (req) => {
    const p = parse(idParam.extend({ cronId: z.coerce.number().int() }), req.params);
    const site = getSite(p.id);
    const b = parse(cronInput, req.body);
    const r = run('UPDATE site_crons SET schedule = ?, command = ?, note = ?, enabled = ? WHERE id = ? AND site_id = ?', b.schedule, b.command, b.note, Number(b.enabled), p.cronId, site.id);
    if (!r.changes) throw notFound('Tarea');
    audit(req.user!.username, 'cron.update', `${site.name}: ${b.schedule} ${b.command}`, req.ip);
    return presentCron(get<SiteCronRow>('SELECT * FROM site_crons WHERE id = ?', p.cronId)!);
  });

  app.delete('/api/sites/:id/crons/:cronId', async (req) => {
    const p = parse(idParam.extend({ cronId: z.coerce.number().int() }), req.params);
    const site = getSite(p.id);
    run('DELETE FROM site_crons WHERE id = ? AND site_id = ?', p.cronId, site.id);
    audit(req.user!.username, 'cron.delete', site.name, req.ip);
    return { ok: true };
  });

  app.post('/api/sites/:id/crons/:cronId/run', async (req) => {
    const p = parse(idParam.extend({ cronId: z.coerce.number().int() }), req.params);
    const site = getSite(p.id);
    const job = get<SiteCronRow>('SELECT * FROM site_crons WHERE id = ? AND site_id = ?', p.cronId, site.id);
    if (!job) throw notFound('Tarea');
    if (job.last_status === 'running') throw badRequest('Esta tarea ya se está ejecutando');
    audit(req.user!.username, 'cron.run', `${site.name}: ${job.command}`, req.ip);
    // Short jobs answer directly; long ones keep running and the list shows the result later.
    const result = await Promise.race([runSiteCron(job), new Promise<null>((r) => setTimeout(() => r(null), 20_000))]);
    return result ? presentCron(result) : { ...presentCron(job), last_status: 'running' };
  });

  // --- PHP settings ------------------------------------------------------------------------
  app.get('/api/sites/:id/php-settings', async (req) => {
    const site = getSite(parse(idParam, req.params).id);
    return { settings: phpSettings(site), defaults: PHP_DEFAULTS };
  });

  app.put('/api/sites/:id/php-settings', async (req) => {
    const site = getSite(parse(idParam, req.params).id);
    if (site.type !== 'php') throw badRequest('Solo los sitios PHP tienen ajustes de PHP');
    const b = parse(phpInput, req.body);
    run('UPDATE sites SET php_settings = ? WHERE id = ?', JSON.stringify(b), site.id);
    audit(req.user!.username, 'site.php-settings', site.name, req.ip);
    // Republishing the live release rewrites the PHP-FPM pool everywhere and reloads it.
    const deployment_id = site.active_release ? enqueueDeploy(site.id, `ajustes de PHP (${req.user!.username})`, { rollbackRelease: site.active_release }) : null;
    return { ok: true, deployment_id };
  });
}

