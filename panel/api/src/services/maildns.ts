/**
 * Mail DNS for a domain: every record mailboxes need to send and receive correctly
 * (MX, SPF, DKIM, DMARC, MTA-STS/TLS reporting, autoconfig/autodiscover SRV/CNAME) plus
 * webmail.<domain>. Records come from Stalwart, so they always match its keys and settings.
 */
import { config } from '../config.ts';
import { get, run, type DomainRow } from '../db.ts';
import * as dns from './dns.ts';
import * as mail from './mail.ts';

/** True when this server can host mail (a mail hostname is configured). */
export const mailAvailable = () => !!config.mailHostname || config.dev;

/** Publishes the mail DNS records Stalwart recommends into the domain's zone. */
export async function publishMailRecords(domain: string) {
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


/** Creates the mail domain (with its DKIM key) and publishes its DNS when the panel manages it. */
export async function enableMailForDomain(d: DomainRow) {
  await mail.ensureMailDomain(d.name);
  if (d.dns_enabled) await publishMailRecords(d.name);
  run('UPDATE domains SET mail_enabled = 1 WHERE id = ?', d.id);
  return get<DomainRow>('SELECT * FROM domains WHERE id = ?', d.id)!;
}
