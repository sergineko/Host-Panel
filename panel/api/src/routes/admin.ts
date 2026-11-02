import type { FastifyInstance } from 'fastify';
import { BlockList, isIP } from 'node:net';
import { z } from 'zod';
import { audit, getSetting, setSetting } from '../db.ts';
import { badRequest, idParam, notFound, parse } from '../lib/validate.ts';
import { scheduleCaddySync } from '../services/caddy.ts';
import { getJob, listJobs, runningJob, startJob } from '../services/jobs.ts';
import {
  defaultPhpVersion,
  installedPhpVersions,
  installPhp,
  phpUsage,
  removePhp,
  setDefaultPhpVersion,
  SUPPORTED_PHP,
} from '../services/php.ts';
import { autoUpdateMode, checkUpdates, isValidComponent, runUpdate } from '../services/updates.ts';

const phpVersion = z.object({ version: z.enum(SUPPORTED_PHP) });

export default async function adminRoutes(app: FastifyInstance) {
  // --- jobs -------------------------------------------------------------------------------
  app.get('/api/jobs', async () => listJobs());
  app.get('/api/jobs/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const job = getJob(id);
    if (!job) throw notFound('Tarea');
    return job;
  });

  // --- PHP versions -----------------------------------------------------------------------
  app.get('/api/php', async () => {
    const installed = installedPhpVersions();
    const usage = phpUsage();
    return {
      default: defaultPhpVersion(),
      versions: SUPPORTED_PHP.map((v) => ({ version: v, installed: installed.includes(v), sites: usage[v] ?? 0 })),
      job: runningJob('php') ?? null,
    };
  });

  app.post('/api/php/install', async (req) => {
    const { version } = parse(phpVersion, req.body);
    if (installedPhpVersions().includes(version)) throw badRequest(`PHP ${version} ya está instalado`);
    if (runningJob('php')) throw badRequest('Ya se está instalando otra versión de PHP; espera a que termine');
    audit(req.user!.username, 'php.install', version, req.ip);
    return { job_id: startJob('php', `Instalar PHP ${version}`, req.user!.username, (log) => installPhp(version, log)) };
  });

  app.post('/api/php/remove', async (req) => {
    const { version } = parse(phpVersion, req.body);
    if (!installedPhpVersions().includes(version)) throw badRequest(`PHP ${version} no está instalado`);
    if (phpUsage()[version]) throw badRequest(`Hay sitios usando PHP ${version}`);
    if (runningJob('php')) throw badRequest('Hay otra operación de PHP en curso');
    audit(req.user!.username, 'php.remove', version, req.ip);
    return { job_id: startJob('php', `Desinstalar PHP ${version}`, req.user!.username, (log) => removePhp(version, log)) };
  });

  app.put('/api/php/default', async (req) => {
    const { version } = parse(phpVersion, req.body);
    try {
      setDefaultPhpVersion(version);
    } catch (err) {
      throw badRequest((err as Error).message);
    }
    audit(req.user!.username, 'php.default', version, req.ip);
    return { default: version };
  });

  // --- updates ----------------------------------------------------------------------------
  app.get('/api/updates', async (req) => {
    const { refresh } = parse(z.object({ refresh: z.coerce.boolean().default(false) }), req.query);
    return {
      components: await checkUpdates(refresh),
      checked_at: getSetting('updates_checked_at') ?? null,
      auto: autoUpdateMode(),
      job: runningJob('update') ?? null,
    };
  });

  app.post('/api/updates/run', async (req) => {
    const { component } = parse(z.object({ component: z.string().max(20).refine(isValidComponent, 'Componente desconocido') }), req.body);
    audit(req.user!.username, 'update.run', component, req.ip);
    return { job_id: await runUpdate(component, req.user!.username) };
  });

  // --- panel-wide settings -----------------------------------------------------------------
  app.get('/api/panel-settings', async () => ({
    auto_update: autoUpdateMode(),
    panel_allow_ips: getSetting('panel_allow_ips') ?? '',
  }));

  app.put('/api/panel-settings', async (req) => {
    const body = parse(
      z.object({
        auto_update: z.enum(['off', 'system', 'all']),
        panel_allow_ips: z
          .string()
          .max(4000)
          .refine(
            (v) =>
              v
                .split(/[\s,]+/)
                .filter(Boolean)
                .every((c) => {
                  const [addr = '', prefix] = c.split('/');
                  const kind = isIP(addr);
                  return kind !== 0 && (prefix === undefined || (/^\d+$/.test(prefix) && Number(prefix) <= (kind === 6 ? 128 : 32)));
                }),
            'Lista de IPs no válida (una IP o rango CIDR por línea)',
          ),
      }),
      req.body,
    );
    const ips = body.panel_allow_ips.split(/[\s,]+/).filter(Boolean);
    const list = new BlockList();
    for (const c of ips) {
      const [addr, prefix] = c.split('/') as [string, string | undefined];
      const type = isIP(addr) === 6 ? 'ipv6' : 'ipv4';
      if (prefix) list.addSubnet(addr, Number(prefix), type);
      else list.addAddress(addr, type);
    }
    const me = req.ip.replace(/^::ffff:/, '');
    const local = me === '127.0.0.1' || me === '::1';
    if (ips.length && !local && !list.check(me, isIP(me) === 6 ? 'ipv6' : 'ipv4')) {
      throw badRequest(`Incluye tu IP actual (${req.ip}) o te quedarás sin acceso al panel`);
    }
    setSetting('auto_update', body.auto_update);
    setSetting('panel_allow_ips', ips.join('\n'));
    scheduleCaddySync();
    audit(req.user!.username, 'settings.update', `auto_update=${body.auto_update}, allow=${ips.length}`, req.ip);
    return { ok: true };
  });
}
