/** PowerDNS Authoritative HTTP API client. Zones are the source of truth for DNS records. */
import { config } from '../config.ts';
import { HttpError } from '../lib/validate.ts';

export interface DnsRecord {
  name: string; // relative name: "@", "www", "mail"…
  type: string;
  ttl: number;
  content: string;
  disabled: boolean;
}

interface RRSet {
  name: string;
  type: string;
  ttl: number;
  records: { content: string; disabled: boolean }[];
}

export const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA', 'NS'] as const;

const fqdn = (name: string) => (name.endsWith('.') ? name : `${name}.`);

// In dev mode, keep zones in memory so the UI can be explored without PowerDNS.
const devZones = new Map<string, RRSet[]>();

async function pdns<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${config.pdnsApi}${path}`, {
      method,
      headers: { 'X-API-Key': config.pdnsKey, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new HttpError(502, 'No se pudo conectar con PowerDNS');
  }
  if (!res.ok) {
    let message = res.statusText;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {
      /* not json */
    }
    throw new HttpError(res.status === 404 ? 404 : 502, `PowerDNS: ${message}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

function toRelative(name: string, zone: string) {
  const z = fqdn(zone);
  if (name === z) return '@';
  return name.endsWith(`.${z}`) ? name.slice(0, -(z.length + 1)) : name;
}

function toAbsolute(name: string, zone: string) {
  if (!name || name === '@') return fqdn(zone);
  if (name.endsWith('.')) return name;
  return `${name}.${fqdn(zone)}`;
}

/** Normalizes content so PowerDNS accepts it (quotes TXT, trailing dots on hostnames). */
export function normalizeContent(type: string, content: string) {
  const c = content.trim();
  switch (type) {
    case 'TXT': {
      if (c.startsWith('"')) return c;
      const chunks = c.match(/.{1,255}/g) ?? [''];
      return chunks.map((ch) => `"${ch.replace(/"/g, '\\"')}"`).join(' ');
    }
    case 'CNAME':
    case 'NS':
      return fqdn(c);
    case 'MX': {
      const [prio, host] = c.split(/\s+/);
      return host ? `${prio} ${fqdn(host)}` : `10 ${fqdn(c)}`;
    }
    case 'SRV': {
      const parts = c.split(/\s+/);
      if (parts.length === 4) parts[3] = fqdn(parts[3]!);
      return parts.join(' ');
    }
    default:
      return c;
  }
}

async function getRRSets(zone: string): Promise<RRSet[]> {
  if (config.dev) return devZones.get(fqdn(zone)) ?? [];
  const data = await pdns<{ rrsets: RRSet[] }>('GET', `/zones/${fqdn(zone)}`);
  return data.rrsets;
}

async function patchRRSets(zone: string, rrsets: (RRSet & { changetype: 'REPLACE' | 'DELETE' })[]) {
  if (config.dev) {
    const z = devZones.get(fqdn(zone)) ?? [];
    for (const rr of rrsets) {
      const idx = z.findIndex((x) => x.name === rr.name && x.type === rr.type);
      if (idx >= 0) z.splice(idx, 1);
      if (rr.changetype === 'REPLACE' && rr.records.length) z.push({ name: rr.name, type: rr.type, ttl: rr.ttl, records: rr.records });
    }
    devZones.set(fqdn(zone), z);
    return;
  }
  await pdns('PATCH', `/zones/${fqdn(zone)}`, { rrsets });
}

export async function listZones(): Promise<string[]> {
  if (config.dev) return [...devZones.keys()];
  const zones = await pdns<{ name: string }[]>('GET', '/zones');
  return zones.map((z) => z.name.replace(/\.$/, ''));
}

export async function createZone(zone: string, defaults: { name: string; type: string; content: string; ttl?: number }[]) {
  const grouped = new Map<string, RRSet>();
  for (const r of defaults) {
    const name = toAbsolute(r.name, zone);
    const key = `${name}|${r.type}`;
    const rr = grouped.get(key) ?? { name, type: r.type, ttl: r.ttl ?? 3600, records: [] };
    const content = normalizeContent(r.type, r.content);
    if (!rr.records.some((x) => x.content === content)) rr.records.push({ content, disabled: false });
    grouped.set(key, rr);
  }
  if (config.dev) {
    devZones.set(fqdn(zone), [...grouped.values()]);
    return;
  }
  await pdns('POST', '/zones', {
    name: fqdn(zone),
    kind: 'Native',
    nameservers: [fqdn(config.ns1), fqdn(config.ns2)],
    soa_edit_api: 'DEFAULT',
    rrsets: [...grouped.values()].filter((r) => r.type !== 'NS' || r.name !== fqdn(zone)),
  });
}

export async function deleteZone(zone: string) {
  if (config.dev) {
    devZones.delete(fqdn(zone));
    return;
  }
  await pdns('DELETE', `/zones/${fqdn(zone)}`).catch((err: HttpError) => {
    if (err.statusCode !== 404) throw err;
  });
}

export async function listRecords(zone: string): Promise<DnsRecord[]> {
  const rrsets = await getRRSets(zone);
  const records: DnsRecord[] = [];
  for (const rr of rrsets) {
    for (const r of rr.records) {
      records.push({ name: toRelative(rr.name, zone), type: rr.type, ttl: rr.ttl, content: r.content, disabled: r.disabled });
    }
  }
  const order = (t: string) => ['SOA', 'NS', 'A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA'].indexOf(t);
  return records.sort((a, b) => order(a.type) - order(b.type) || a.name.localeCompare(b.name));
}

/** Adds a record to its rrset (other records with the same name/type are kept). */
export async function addRecord(zone: string, rec: { name: string; type: string; ttl: number; content: string }) {
  const name = toAbsolute(rec.name, zone);
  const content = normalizeContent(rec.type, rec.content);
  const rrsets = await getRRSets(zone);
  const existing = rrsets.find((r) => r.name === name && r.type === rec.type);
  if (rec.type === 'CNAME' && rrsets.some((r) => r.name === name && r.type !== 'CNAME')) {
    throw new HttpError(400, 'Un CNAME no puede coexistir con otros registros del mismo nombre');
  }
  const records = existing ? existing.records.filter((r) => r.content !== content) : [];
  records.push({ content, disabled: false });
  await patchRRSets(zone, [{ name, type: rec.type, ttl: rec.ttl, records, changetype: 'REPLACE' }]);
}

/** Replaces every record of a name/type (used for automatic records like DKIM). */
export async function setRecords(zone: string, name: string, type: string, contents: string[], ttl = 3600) {
  await patchRRSets(zone, [
    {
      name: toAbsolute(name, zone),
      type,
      ttl,
      records: contents.map((c) => ({ content: normalizeContent(type, c), disabled: false })),
      changetype: 'REPLACE',
    },
  ]);
}

export async function deleteRecord(zone: string, rec: { name: string; type: string; content: string }) {
  if (rec.type === 'SOA') throw new HttpError(400, 'El registro SOA no se puede borrar');
  const name = toAbsolute(rec.name, zone);
  const rrsets = await getRRSets(zone);
  const existing = rrsets.find((r) => r.name === name && r.type === rec.type);
  if (!existing) return;
  const records = existing.records.filter((r) => r.content !== rec.content);
  await patchRRSets(zone, [
    { name, type: rec.type, ttl: existing.ttl, records, changetype: records.length ? 'REPLACE' : 'DELETE' },
  ]);
}

/** Default records for a new zone: web on this server + nameservers. */
export function defaultZoneRecords(zone: string) {
  const recs: { name: string; type: string; content: string }[] = [
    { name: '@', type: 'NS', content: config.ns1 },
    { name: '@', type: 'NS', content: config.ns2 },
    { name: '@', type: 'A', content: config.serverIp },
    { name: 'www', type: 'CNAME', content: zone },
    { name: '@', type: 'CAA', content: '0 issue "letsencrypt.org"' },
    { name: '@', type: 'CAA', content: '0 issue "sectigo.com"' },
  ];
  if (config.serverIpv6) recs.push({ name: '@', type: 'AAAA', content: config.serverIpv6 });
  // Glue for our own nameservers / mail host when they live under this zone.
  for (const host of [config.ns1, config.ns2, config.mailHostname, config.panelDomain]) {
    if (host && host.endsWith(`.${zone}`)) {
      recs.push({ name: host.slice(0, -(zone.length + 1)), type: 'A', content: config.serverIp });
    }
  }
  return recs;
}

/** Points a zone at new nameservers: NS records and the primary server in its SOA. */
export async function setZoneNameservers(zone: string, nameservers: string[]) {
  const apex = fqdn(zone);
  const rrsets = await getRRSets(zone);
  const soa = rrsets.find((r) => r.name === apex && r.type === 'SOA');
  const changes: (RRSet & { changetype: 'REPLACE' | 'DELETE' })[] = [
    { name: apex, type: 'NS', ttl: 3600, records: nameservers.map((n) => ({ content: fqdn(n), disabled: false })), changetype: 'REPLACE' },
  ];
  if (soa?.records[0]) {
    const parts = soa.records[0].content.split(/\s+/);
    parts[0] = fqdn(nameservers[0]!);
    if (parts[2] && /^\d+$/.test(parts[2])) parts[2] = String(Number(parts[2]) + 1);
    changes.push({ name: apex, type: 'SOA', ttl: soa.ttl, records: [{ content: parts.join(' '), disabled: false }], changetype: 'REPLACE' });
  }
  await patchRRSets(zone, changes);
}
