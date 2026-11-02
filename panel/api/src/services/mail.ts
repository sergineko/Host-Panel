/** Stalwart Mail Server management API client. Stalwart is the source of truth for mailboxes. */
import { config } from '../config.ts';
import { HttpError } from '../lib/validate.ts';

export interface Mailbox {
  email: string;
  name: string;
  aliases: string[];
  quotaMb: number;
  usedMb: number;
}

interface Principal {
  id?: number;
  type: string;
  name: string;
  description?: string;
  emails?: string[] | string;
  quota?: number;
  usedQuota?: number;
}

const devBoxes = new Map<string, Principal>();
const devDomains = new Set<string>();

async function stalwart<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${config.stalwartApi}/api${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.stalwartUser}:${config.stalwartPassword}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new HttpError(502, 'No se pudo conectar con el servidor de correo (Stalwart)');
  }
  const text = await res.text();
  let data: { data?: unknown; error?: string; details?: string } = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    /* not json */
  }
  if (!res.ok || data.error) {
    const msg = data.details ?? data.error ?? res.statusText;
    throw new HttpError(res.status === 404 ? 404 : res.ok ? 400 : 502, `Correo: ${msg}`);
  }
  return data.data as T;
}

const asArray = (v: string[] | string | undefined) => (Array.isArray(v) ? v : v ? [v] : []);
const MB = 1024 * 1024;

function toMailbox(p: Principal): Mailbox {
  const emails = asArray(p.emails);
  return {
    email: p.name,
    name: p.description ?? '',
    aliases: emails.filter((e) => e !== p.name),
    quotaMb: Math.round((p.quota ?? 0) / MB),
    usedMb: Math.round((p.usedQuota ?? 0) / MB),
  };
}

export async function ensureMailDomain(domain: string) {
  if (config.dev) {
    devDomains.add(domain);
    return;
  }
  try {
    await stalwart('POST', '/principal', { type: 'domain', name: domain, description: `HostPanel: ${domain}` });
  } catch (err) {
    if (!(err instanceof HttpError) || !/exist/i.test(err.message)) throw err;
  }
  // DKIM key (RSA for maximum compatibility). Ignore "already exists".
  await stalwart('POST', '/dkim', { id: null, algorithm: 'Rsa', domain, selector: null }).catch(() => {});
}

export async function removeMailDomain(domain: string) {
  if (config.dev) {
    devDomains.delete(domain);
    return;
  }
  for (const box of await listMailboxes(domain)) await deleteMailbox(box.email);
  await stalwart('DELETE', `/principal/${encodeURIComponent(domain)}`).catch(() => {});
}

/** DNS records Stalwart recommends for a domain (MX, SPF, DKIM, DMARC, SRV autoconfig…). */
export async function mailDnsRecords(domain: string): Promise<{ type: string; name: string; content: string }[]> {
  if (config.dev) {
    const host = config.mailHostname || `mail.${domain}`;
    return [
      { type: 'MX', name: `${domain}.`, content: `10 ${host}.` },
      { type: 'TXT', name: `${domain}.`, content: 'v=spf1 mx ra=postmaster -all' },
      { type: 'TXT', name: `202611r._domainkey.${domain}.`, content: 'v=DKIM1; k=rsa; h=sha256; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwVh2…IDAQAB' },
      { type: 'TXT', name: `_dmarc.${domain}.`, content: `v=DMARC1; p=reject; rua=mailto:postmaster@${domain}; ruf=mailto:postmaster@${domain}` },
      { type: 'TXT', name: `mta-sts.${domain}.`, content: 'v=STSv1; id=1730000000' },
      { type: 'TXT', name: `_smtp._tls.${domain}.`, content: `v=TLSRPTv1; rua=mailto:postmaster@${domain}` },
      { type: 'SRV', name: `_imaps._tcp.${domain}.`, content: `0 1 993 ${host}.` },
      { type: 'SRV', name: `_submissions._tcp.${domain}.`, content: `0 1 465 ${host}.` },
      { type: 'CNAME', name: `autoconfig.${domain}.`, content: `${host}.` },
      { type: 'CNAME', name: `autodiscover.${domain}.`, content: `${host}.` },
    ];
  }
  return stalwart('GET', `/dns/records/${encodeURIComponent(domain)}`);
}

export async function listMailboxes(domain?: string): Promise<Mailbox[]> {
  let items: Principal[];
  if (config.dev) items = [...devBoxes.values()];
  else {
    const data = await stalwart<{ items: Principal[] }>('GET', '/principal?types=individual&limit=1000');
    items = data.items;
  }
  return items
    .map(toMailbox)
    .filter((m) => !domain || m.email.endsWith(`@${domain}`))
    .sort((a, b) => a.email.localeCompare(b.email));
}

export async function createMailbox(input: { email: string; password: string; name: string; quotaMb: number }) {
  const principal: Principal & { secrets: string[]; roles: string[] } = {
    type: 'individual',
    name: input.email,
    description: input.name,
    emails: [input.email],
    quota: input.quotaMb * MB,
    secrets: [input.password],
    roles: ['user'],
  };
  if (config.dev) {
    devBoxes.set(input.email, principal);
    return;
  }
  await stalwart('POST', '/principal', principal);
}

async function patchPrincipal(name: string, ops: { action: string; field: string; value: unknown }[]) {
  if (config.dev) {
    const p = devBoxes.get(name);
    if (!p) return;
    for (const op of ops) {
      if (op.field === 'emails') {
        const list = asArray(p.emails);
        p.emails = op.action === 'addItem' ? [...list, op.value as string] : list.filter((e) => e !== op.value);
      }
      if (op.field === 'quota') p.quota = op.value as number;
      if (op.field === 'description') p.description = op.value as string;
    }
    return;
  }
  await stalwart('PATCH', `/principal/${encodeURIComponent(name)}`, ops);
}

export async function updateMailbox(email: string, input: { password?: string; name?: string; quotaMb?: number }) {
  const ops: { action: string; field: string; value: unknown }[] = [];
  if (input.password) ops.push({ action: 'set', field: 'secrets', value: [input.password] });
  if (input.name !== undefined) ops.push({ action: 'set', field: 'description', value: input.name });
  if (input.quotaMb !== undefined) ops.push({ action: 'set', field: 'quota', value: input.quotaMb * MB });
  if (ops.length) await patchPrincipal(email, ops);
}

export const addAlias = (email: string, alias: string) =>
  patchPrincipal(email, [{ action: 'addItem', field: 'emails', value: alias }]);
export const removeAlias = (email: string, alias: string) =>
  patchPrincipal(email, [{ action: 'removeItem', field: 'emails', value: alias }]);

export async function deleteMailbox(email: string) {
  if (config.dev) {
    devBoxes.delete(email);
    return;
  }
  await stalwart('DELETE', `/principal/${encodeURIComponent(email)}`);
}

/** Asks Stalwart to reload its configuration (e.g. after a certificate renewal). */
export async function reloadMailServer() {
  if (config.dev) return;
  await stalwart('GET', '/reload').catch(() => {});
}
