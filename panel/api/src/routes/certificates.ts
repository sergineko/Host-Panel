import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../db.ts';
import { parse } from '../lib/validate.ts';
import { syncCaddy } from '../services/caddy.ts';
import { certificateSettings, certificateStatus } from '../services/certificates.ts';

export default async function certificateRoutes(app: FastifyInstance) {
  /** All public hostnames, or only ?hosts=a.com,b.com (a site's domains). */
  app.get('/api/certificates', async (req) => {
    const { hosts } = parse(z.object({ hosts: z.string().max(5000).optional() }), req.query);
    const only = hosts ? hosts.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean) : undefined;
    return { ...certificateSettings(), certificates: await certificateStatus(only) };
  });

  /** Reloads Caddy so it asks Let's Encrypt again right away for hosts without a certificate. */
  app.post('/api/certificates/retry', async (req) => {
    await syncCaddy(true);
    audit(req.user!.username, 'certificates.retry', '', req.ip);
    return { ok: true };
  });
}
