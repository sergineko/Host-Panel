import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../db.ts';
import { badRequest, parse } from '../lib/validate.ts';
import { runningJob, startJob } from '../services/jobs.ts';
import { availableNodeVersions, installedNodeVersions, installNode, NODE_DIR, nodeUsage, removeNode } from '../services/nodejs.ts';

const versionBody = z.object({ version: z.string().regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/, 'Versión no válida (por ejemplo 22.11.0)') });

export default async function nodeRoutes(app: FastifyInstance) {
  app.get('/api/nodejs', async (req) => {
    const { refresh } = parse(z.object({ refresh: z.coerce.boolean().default(false) }), req.query);
    const installed = installedNodeVersions(refresh);
    const usage = nodeUsage();
    return {
      dir: NODE_DIR,
      latest: installed[0]?.version ?? null,
      installed: installed.map((n) => ({ ...n, sites: usage[n.version] ?? [] })),
      missing: usage.missing ?? [],
      job: runningJob('nodejs') ?? null,
    };
  });

  app.get('/api/nodejs/available', async () => availableNodeVersions());

  app.post('/api/nodejs/install', async (req) => {
    const { version } = parse(versionBody, req.body);
    if (installedNodeVersions(true).some((n) => n.version === version)) throw badRequest(`Node.js ${version} ya está instalado`);
    if (runningJob('nodejs')) throw badRequest('Hay otra operación de Node.js en curso; espera a que termine');
    audit(req.user!.username, 'nodejs.install', version, req.ip);
    return { job_id: startJob('nodejs', `Instalar Node.js ${version}`, req.user!.username, (log) => installNode(version, log)) };
  });

  app.post('/api/nodejs/remove', async (req) => {
    const { version } = parse(versionBody, req.body);
    if (runningJob('nodejs')) throw badRequest('Hay otra operación de Node.js en curso');
    audit(req.user!.username, 'nodejs.remove', version, req.ip);
    return { job_id: startJob('nodejs', `Eliminar Node.js ${version}`, req.user!.username, (log) => removeNode(version, log)) };
  });
}
