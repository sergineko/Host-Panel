import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../db.ts';
import { badRequest, idParam, notFound, parse } from '../lib/validate.ts';
import { disableSecondary, enableSecondary, resyncSecondary, SECONDARY_SCRIPT, secondaryStatus } from '../services/dnssecondary.ts';
import { config } from '../config.ts';
import { delegationStatus, domainById, externalRecords, mainDomainCandidates, serverIdentity, setMainDomain } from '../services/identity.ts';
import { scopeOf } from '../access.ts';

export default async function identityRoutes(app: FastifyInstance) {
  app.get('/api/server/identity', async (req) => ({ ...serverIdentity(), candidates: scopeOf(req) === null ? mainDomainCandidates() : [] }));

  app.post('/api/server/main-domain', async (req) => {
    const body = parse(z.object({ domain_id: z.number().int(), email: z.email('Email no válido').optional() }), req.body);
    const d = domainById(body.domain_id);
    if (!d) throw notFound('Dominio');
    if (!d.dns_enabled) throw badRequest('El dominio principal debe tener el DNS gestionado por el panel');
    audit(req.user!.username, 'server.main-domain', d.name, req.ip);
    return { job_id: await setMainDomain(d.name, body.email, req.user!.username) };
  });

  // --- secondary nameserver (staff only: clients are denied in access.ts) -------------------
  app.get('/api/dns/secondary', async () => ({
    ...(await secondaryStatus()),
    command: `curl -fsSL https://raw.githubusercontent.com/sergineko/Host-Panel/main/${SECONDARY_SCRIPT} | sudo bash -s -- --primary ${config.serverIp} --ns ${config.ns2}`,
  }));

  app.put('/api/dns/secondary', async (req) => {
    const body = parse(z.object({ ip: z.string().max(64), ipv6: z.string().max(64).nullable().optional() }), req.body);
    const status = await enableSecondary(body);
    audit(req.user!.username, 'dns.secondary.add', body.ip, req.ip);
    return status;
  });

  app.post('/api/dns/secondary/sync', async (req) => {
    await resyncSecondary();
    audit(req.user!.username, 'dns.secondary.sync', '', req.ip);
    return { ok: true };
  });

  app.delete('/api/dns/secondary', async (req) => {
    await disableSecondary();
    audit(req.user!.username, 'dns.secondary.remove', '', req.ip);
    return { ok: true };
  });

  app.get('/api/domains/:id/delegation', async (req) => {
    const d = domainById(parse(idParam, req.params).id);
    if (!d) throw notFound('Dominio');
    const [status, records] = await Promise.all([delegationStatus(d), externalRecords(d).catch(() => [])]);
    return { ...status, identity: serverIdentity(), records };
  });
}
