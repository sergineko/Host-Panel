import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.ts';
import { all, audit, get, type DomainRow } from '../db.ts';
import { randomPassword } from '../lib/crypto.ts';
import { badRequest, parse } from '../lib/validate.ts';
import * as mail from '../services/mail.ts';

const email = z.string().trim().toLowerCase().email('Email no válido');

function assertMailDomain(address: string) {
  const domain = address.split('@')[1] ?? '';
  const row = get<DomainRow>('SELECT * FROM domains WHERE name = ?', domain);
  if (!row) throw badRequest(`El dominio ${domain} no está dado de alta en el panel`);
  if (!row.mail_enabled) throw badRequest(`El correo no está activado para ${domain}`);
}

export default async function mailRoutes(app: FastifyInstance) {
  app.get('/api/mail', async (req) => {
    const { domain } = parse(z.object({ domain: z.string().optional() }), req.query);
    const domains = all<DomainRow>('SELECT * FROM domains WHERE mail_enabled = 1 ORDER BY name');
    return {
      domains: domains.map((d) => ({ id: d.id, name: d.name })),
      mailboxes: domains.length ? await mail.listMailboxes(domain) : [],
      server: {
        hostname: config.mailHostname,
        // Each mail domain also gets its own webmail.<domain> address.
        webmail: !config.mailHostname ? '' : domain && domains.some((d) => d.name === domain) ? `https://webmail.${domain}` : `https://${config.mailHostname}`,
        imap: { host: config.mailHostname, port: 993, security: 'SSL/TLS' },
        smtp: { host: config.mailHostname, port: 465, security: 'SSL/TLS', alt: 587 },
      },
    };
  });

  app.post('/api/mail/mailboxes', async (req) => {
    const body = parse(
      z.object({
        email,
        name: z.string().max(100).default(''),
        password: z.string().min(10, 'Mínimo 10 caracteres').optional(),
        quotaMb: z.number().int().min(0).max(1_000_000).default(2048),
      }),
      req.body,
    );
    assertMailDomain(body.email);
    const password = body.password ?? randomPassword(16);
    await mail.createMailbox({ ...body, password });
    audit(req.user!.username, 'mailbox.create', body.email, req.ip);
    return { email: body.email, password: body.password ? undefined : password };
  });

  app.put('/api/mail/mailboxes/:email', async (req) => {
    const { email: address } = parse(z.object({ email }), req.params);
    const body = parse(
      z.object({
        name: z.string().max(100).optional(),
        password: z.string().min(10, 'Mínimo 10 caracteres').optional(),
        quotaMb: z.number().int().min(0).max(1_000_000).optional(),
      }),
      req.body,
    );
    await mail.updateMailbox(address, body);
    audit(req.user!.username, 'mailbox.update', address, req.ip);
    return { ok: true };
  });

  app.delete('/api/mail/mailboxes/:email', async (req) => {
    const { email: address } = parse(z.object({ email }), req.params);
    await mail.deleteMailbox(address);
    audit(req.user!.username, 'mailbox.delete', address, req.ip);
    return { ok: true };
  });

  app.post('/api/mail/mailboxes/:email/aliases', async (req) => {
    const { email: address } = parse(z.object({ email }), req.params);
    const { alias } = parse(z.object({ alias: email }), req.body);
    assertMailDomain(alias);
    await mail.addAlias(address, alias);
    audit(req.user!.username, 'alias.create', `${alias} → ${address}`, req.ip);
    return { ok: true };
  });

  app.delete('/api/mail/mailboxes/:email/aliases/:alias', async (req) => {
    const { email: address, alias } = parse(z.object({ email, alias: email }), req.params);
    await mail.removeAlias(address, alias);
    return { ok: true };
  });
}
