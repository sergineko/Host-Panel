import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../db.ts';
import { badRequest, idParam, notFound, parse } from '../lib/validate.ts';
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

  app.get('/api/domains/:id/delegation', async (req) => {
    const d = domainById(parse(idParam, req.params).id);
    if (!d) throw notFound('Dominio');
    const [status, records] = await Promise.all([delegationStatus(d), externalRecords(d).catch(() => [])]);
    return { ...status, identity: serverIdentity(), records };
  });
}
