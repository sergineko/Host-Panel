import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.ts';
import { all, audit, get, run, type DomainRow, type IpRuleRow, type SecurityRow } from '../db.ts';
import { randomToken } from '../lib/crypto.ts';
import { badRequest, domainName, HttpError, idParam, notFound, parse } from '../lib/validate.ts';
import { DEFAULT_SECURITY, syncCaddy } from '../services/caddy.ts';
import * as dns from '../services/dns.ts';
import * as mail from '../services/mail.ts';

function getDomain(id: number) {
  const d = get<DomainRow>('SELECT * FROM domains WHERE id = ?', id);
  if (!d) throw notFound('Dominio');
  return d;
}

function getSecurity(domainId: number): SecurityRow {
  return get<SecurityRow>('SELECT * FROM security WHERE domain_id = ?', domainId) ?? { domain_id: domainId, ...DEFAULT_SECURITY };
}

/** Publishes the mail DNS records Stalwart recommends into the domain's zone. */
async function publishMailRecords(domain: string) {
  const records = await mail.mailDnsRecords(domain);
  const grouped = new Map<string, { name: string; type: string; contents: string[] }>();
  for (const r of records) {
    if (!['MX', 'TXT', 'SRV', 'CNAME', 'TLSA'].includes(r.type)) continue;
    const key = `${r.name}|${r.type}`;
    const g = grouped.get(key) ?? { name: r.name, type: r.type, contents: [] };
    g.contents.push(r.content);
    grouped.set(key, g);
  }
  const existing = await dns.listRecords(domain);
  for (const g of grouped.values()) {
    if (g.type === 'TXT') {
      // Keep unrelated TXT records (site verifications…) on the same name.
      const rel = g.name.replace(/\.$/, '') === domain ? '@' : g.name.replace(/\.$/, '').replace(`.${domain}`, '');
      const kind = (c: string) => (c.includes('v=spf1') ? 'spf' : c.includes('v=DMARC1') ? 'dmarc' : c.includes('v=DKIM1') ? 'dkim' : 'other');
      const kinds = new Set(g.contents.map(kind));
      const keep = existing
        .filter((r) => r.type === 'TXT' && r.name === rel && !kinds.has(kind(r.content)))
        .map((r) => r.content);
      await dns.setRecords(domain, g.name, 'TXT', [...keep, ...g.contents]);
    } else {
      await dns.setRecords(domain, g.name, g.type, g.contents);
    }
  }
  if (config.mailHostname && config.mailHostname.endsWith(`.${domain}`)) {
    await dns.setRecords(domain, config.mailHostname.slice(0, -(domain.length + 1)), 'A', [config.serverIp]);
  }
  // webmail.<domain> → Roundcube (served by this server).
  await dns.setRecords(domain, 'webmail', 'A', [config.serverIp]);
}

export default async function domainRoutes(app: FastifyInstance) {
  app.get('/api/domains', async () => {
    return all<DomainRow & { sites: number }>(
      `SELECT d.*, (SELECT COUNT(*) FROM sites s WHERE s.domain_id = d.id) AS sites FROM domains d ORDER BY d.name`,
    );
  });

  app.post('/api/domains', async (req) => {
    const body = parse(z.object({ name: domainName, dns: z.boolean().default(true) }), req.body);
    if (get('SELECT 1 FROM domains WHERE name = ?', body.name)) throw badRequest('El dominio ya existe');
    if (body.dns) await dns.createZone(body.name, dns.defaultZoneRecords(body.name));
    const { id } = run('INSERT INTO domains (name, dns_enabled) VALUES (?, ?)', body.name, body.dns ? 1 : 0);
    run('INSERT INTO security (domain_id) VALUES (?)', id);
    audit(req.user!.username, 'domain.create', body.name, req.ip);
    return getDomain(id);
  });

  app.get('/api/domains/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const d = getDomain(id);
    return {
      ...d,
      nameservers: [config.ns1, config.ns2],
      serverIp: config.serverIp,
      mailHostname: config.mailHostname,
      sites: all('SELECT id, name, type, status, hostnames FROM sites WHERE domain_id = ?', id),
    };
  });

  app.delete('/api/domains/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const d = getDomain(id);
    const sites = get<{ n: number }>('SELECT COUNT(*) n FROM sites WHERE domain_id = ?', id)!;
    if (sites.n > 0) throw badRequest('Elimina antes los sitios de este dominio');
    if (d.mail_enabled) await mail.removeMailDomain(d.name).catch(() => {});
    if (d.dns_enabled) await dns.deleteZone(d.name);
    run('DELETE FROM proxy_routes WHERE hostname = ? OR hostname LIKE ?', d.name, `%.${d.name}`);
    run('DELETE FROM redirects WHERE hostname = ? OR hostname LIKE ?', d.name, `%.${d.name}`);
    run('DELETE FROM domains WHERE id = ?', id);
    await syncCaddy();
    audit(req.user!.username, 'domain.delete', d.name, req.ip);
    return { ok: true };
  });

  // --- DNS -------------------------------------------------------------------------
  const recordSchema = z.object({
    name: z.string().trim().max(253).regex(/^(@|\*|[a-zA-Z0-9_*.-]+)$/, 'Nombre no válido'),
    type: z.enum(dns.RECORD_TYPES),
    ttl: z.coerce.number().int().min(60).max(86400).default(3600),
    content: z.string().trim().min(1).max(4000),
  });

  function validateContent(type: string, content: string) {
    const ipv4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
    if (type === 'A' && !ipv4.test(content)) throw badRequest('Dirección IPv4 no válida');
    if (type === 'AAAA' && !/^[0-9a-fA-F:]+$/.test(content)) throw badRequest('Dirección IPv6 no válida');
  }

  app.get('/api/domains/:id/dns', async (req) => {
    const { id } = parse(idParam, req.params);
    const d = getDomain(id);
    if (!d.dns_enabled) throw badRequest('El DNS de este dominio no está gestionado por el panel');
    return dns.listRecords(d.name);
  });

  app.post('/api/domains/:id/dns', async (req) => {
    const { id } = parse(idParam, req.params);
    const d = getDomain(id);
    const rec = parse(recordSchema, req.body);
    validateContent(rec.type, rec.content);
    await dns.addRecord(d.name, rec);
    audit(req.user!.username, 'dns.add', `${rec.name}.${d.name} ${rec.type} ${rec.content}`, req.ip);
    return dns.listRecords(d.name);
  });

  app.put('/api/domains/:id/dns', async (req) => {
    const { id } = parse(idParam, req.params);
    const d = getDomain(id);
    const body = parse(z.object({ old: recordSchema, record: recordSchema }), req.body);
    validateContent(body.record.type, body.record.content);
    await dns.deleteRecord(d.name, body.old);
    await dns.addRecord(d.name, body.record);
    audit(req.user!.username, 'dns.update', `${body.record.name}.${d.name} ${body.record.type}`, req.ip);
    return dns.listRecords(d.name);
  });

  app.post('/api/domains/:id/dns/delete', async (req) => {
    const { id } = parse(idParam, req.params);
    const d = getDomain(id);
    const rec = parse(recordSchema.pick({ name: true, type: true, content: true }), req.body);
    await dns.deleteRecord(d.name, rec);
    audit(req.user!.username, 'dns.delete', `${rec.name}.${d.name} ${rec.type}`, req.ip);
    return dns.listRecords(d.name);
  });

  // --- Mail per domain -------------------------------------------------------------
  app.post('/api/domains/:id/mail', async (req) => {
    const { id } = parse(idParam, req.params);
    const d = getDomain(id);
    if (!config.mailHostname && !config.dev) throw new HttpError(400, 'El servidor de correo no está configurado (HP_MAIL_HOSTNAME)');
    await mail.ensureMailDomain(d.name);
    if (d.dns_enabled) await publishMailRecords(d.name);
    run('UPDATE domains SET mail_enabled = 1 WHERE id = ?', id);
    await syncCaddy();
    audit(req.user!.username, 'mail.enable', d.name, req.ip);
    return getDomain(id);
  });

  app.post('/api/domains/:id/mail/dns', async (req) => {
    const { id } = parse(idParam, req.params);
    const d = getDomain(id);
    await publishMailRecords(d.name);
    return { ok: true };
  });

  app.get('/api/domains/:id/mail/records', async (req) => {
    const { id } = parse(idParam, req.params);
    return mail.mailDnsRecords(getDomain(id).name);
  });

  app.delete('/api/domains/:id/mail', async (req) => {
    const { id } = parse(idParam, req.params);
    const d = getDomain(id);
    await mail.removeMailDomain(d.name);
    run('UPDATE domains SET mail_enabled = 0 WHERE id = ?', id);
    await syncCaddy();
    audit(req.user!.username, 'mail.disable', d.name, req.ip);
    return getDomain(id);
  });

  // --- Security (WAF) --------------------------------------------------------------
  app.get('/api/domains/:id/security', async (req) => {
    const { id } = parse(idParam, req.params);
    getDomain(id);
    const sec = getSecurity(id);
    return {
      ...sec,
      under_attack_token: undefined,
      ip_rules: all<IpRuleRow>('SELECT * FROM ip_rules WHERE domain_id = ? ORDER BY id DESC', id),
    };
  });

  app.put('/api/domains/:id/security', async (req) => {
    const { id } = parse(idParam, req.params);
    const d = getDomain(id);
    const body = parse(
      z.object({
        waf_mode: z.enum(['off', 'detect', 'block']),
        paranoia: z.number().int().min(1).max(4),
        rate_limit_rpm: z.number().int().min(0).max(100000),
        block_bots: z.boolean(),
        under_attack: z.boolean(),
        security_headers: z.boolean(),
        hsts: z.boolean(),
        compression: z.boolean(),
        block_sensitive: z.boolean().default(true),
        hotlink: z.boolean().default(false),
        max_body_mb: z.number().int().min(0).max(10240).default(0),
        cache_static: z.boolean().default(true),
        cache_ttl: z.number().int().min(0).max(31536000).default(604800),
      }),
      req.body,
    );
    const prev = getSecurity(id);
    // New token each time the mode is switched on (old clearance cookies stop working).
    const token = body.under_attack ? (prev.under_attack && prev.under_attack_token ? prev.under_attack_token : randomToken(18)) : '';
    run(
      `INSERT INTO security (domain_id, waf_mode, paranoia, rate_limit_rpm, block_bots, under_attack, under_attack_token, security_headers, hsts, compression,
         block_sensitive, hotlink, max_body_mb, cache_static, cache_ttl)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(domain_id) DO UPDATE SET waf_mode = excluded.waf_mode, paranoia = excluded.paranoia,
         rate_limit_rpm = excluded.rate_limit_rpm, block_bots = excluded.block_bots, under_attack = excluded.under_attack,
         under_attack_token = excluded.under_attack_token, security_headers = excluded.security_headers,
         hsts = excluded.hsts, compression = excluded.compression, block_sensitive = excluded.block_sensitive,
         hotlink = excluded.hotlink, max_body_mb = excluded.max_body_mb, cache_static = excluded.cache_static, cache_ttl = excluded.cache_ttl`,
      id,
      body.waf_mode,
      body.paranoia,
      body.rate_limit_rpm,
      Number(body.block_bots),
      Number(body.under_attack),
      token,
      Number(body.security_headers),
      Number(body.hsts),
      Number(body.compression),
      Number(body.block_sensitive),
      Number(body.hotlink),
      body.max_body_mb,
      Number(body.cache_static),
      body.cache_ttl,
    );
    await syncCaddy();
    audit(req.user!.username, 'security.update', d.name, req.ip);
    return { ok: true };
  });

  const cidr = z
    .string()
    .trim()
    .regex(/^([0-9a-fA-F:.]+)(\/\d{1,3})?$/, 'IP o rango CIDR no válido');

  app.post('/api/ip-rules', async (req) => {
    const body = parse(
      z.object({ domain_id: z.number().int().nullable(), cidr, action: z.enum(['allow', 'block']), note: z.string().max(200).default('') }),
      req.body,
    );
    if (body.domain_id !== null) getDomain(body.domain_id);
    run('INSERT INTO ip_rules (domain_id, cidr, action, note) VALUES (?, ?, ?, ?)', body.domain_id, body.cidr, body.action, body.note);
    await syncCaddy();
    audit(req.user!.username, `ip.${body.action}`, body.cidr, req.ip);
    return { ok: true };
  });

  app.get('/api/ip-rules', async () => all('SELECT * FROM ip_rules WHERE domain_id IS NULL ORDER BY id DESC'));

  app.delete('/api/ip-rules/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    run('DELETE FROM ip_rules WHERE id = ?', id);
    await syncCaddy();
    return { ok: true };
  });
}
