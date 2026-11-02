/**
 * Server identity: the main domain the server is known by.
 *
 *   panel.<dominio>   the control panel
 *   mail.<dominio>    the mail server (MX of every domain, IMAP/SMTP, its PTR record)
 *   ns1/ns2.<dominio> the nameservers every hosted domain is delegated to
 *
 * A server installed with only its IP has none of these, so it can't host mail and has no
 * real nameservers. Choosing a main domain here re-runs the installer with it (installs the
 * mail server, opens its ports, rewrites the configuration) and, when the panel starts
 * again, every zone is pointed at the new nameservers.
 */
import { Resolver } from 'node:dns/promises';
import { join } from 'node:path';
import { config } from '../config.ts';
import { all, get, getSetting, setSetting, type DomainRow } from '../db.ts';
import { exec } from '../lib/exec.ts';
import { HttpError } from '../lib/validate.ts';
import { syncCaddy } from './caddy.ts';
import * as dns from './dns.ts';
import { runningJob, startDetachedJob, startJob } from './jobs.ts';
import { enableMailForDomain, mailAvailable, publishMailRecords } from './maildns.ts';

export function serverIdentity() {
  return {
    base_domain: config.baseDomain || null,
    panel_domain: config.panelDomain || null,
    mail_hostname: config.mailHostname || null,
    nameservers: [config.ns1, config.ns2],
    /** Nameservers that really exist: they live under the main domain. */
    nameservers_ready: !!config.baseDomain && [config.ns1, config.ns2].every((n) => n.endsWith(`.${config.baseDomain}`)),
    mail_ready: mailAvailable() && !!config.mailHostname,
    server_ip: config.serverIp,
    server_ipv6: config.serverIpv6 || null,
    admin_email: config.adminEmail,
    job: runningJob('identity') ?? null,
  };
}

const identityKey = () => JSON.stringify([config.ns1, config.ns2, config.mailHostname]);

/**
 * Runs at boot: when the nameservers or the mail hostname changed since last time, points
 * every zone at the new nameservers, adds the main domain's own records (ns1, ns2, mail,
 * panel) and, if the server just got a mail server, turns mail on for every domain.
 */
export async function reconcileIdentity(force = false) {
  const previous = getSetting('server_identity');
  const current = identityKey();
  if (!force && previous === current) return;
  if (previous === undefined && !force) {
    // First run of this version: remember the state, change nothing.
    setSetting('server_identity', current);
    return;
  }
  const [, , prevMail] = previous ? (JSON.parse(previous) as string[]) : ['', '', ''];
  const domains = all<DomainRow>('SELECT * FROM domains');
  for (const d of domains.filter((x) => x.dns_enabled)) {
    await dns.setZoneNameservers(d.name, [config.ns1, config.ns2]).catch((err) => console.error(`NS de ${d.name}: ${(err as Error).message}`));
  }
  const base = config.baseDomain && domains.find((d) => d.name === config.baseDomain && d.dns_enabled);
  if (base) {
    for (const host of [config.ns1, config.ns2, config.mailHostname, config.panelDomain]) {
      if (!host?.endsWith(`.${base.name}`)) continue;
      const rel = host.slice(0, -(base.name.length + 1));
      await dns.setRecords(base.name, rel, 'A', [config.serverIp]);
      if (config.serverIpv6) await dns.setRecords(base.name, rel, 'AAAA', [config.serverIpv6]);
    }
  }
  if (mailAvailable() && config.mailHostname) {
    for (const d of domains) {
      try {
        // New mail server: every domain gets mail. Same server, new name: refresh MX & co.
        if (!d.mail_enabled && !prevMail) await enableMailForDomain(d);
        else if (d.mail_enabled && d.dns_enabled && prevMail !== config.mailHostname) await publishMailRecords(d.name);
      } catch (err) {
        console.error(`Correo de ${d.name}: ${(err as Error).message}`);
      }
    }
  }
  setSetting('server_identity', current);
  await syncCaddy().catch(() => {});
}

/** Re-runs the installer with a new main domain (survives the panel restarting itself). */
export async function setMainDomain(domain: string, email: string | undefined, user: string): Promise<number> {
  if (runningJob('identity') || runningJob('update')) throw new HttpError(409, 'Hay otra tarea del sistema en curso; espera a que termine');
  const title = `Usar ${domain} como dominio principal del servidor`;
  if (config.dev) {
    return startJob('identity', title, user, async (log) => {
      log(`[dev] bash install.sh --yes --keep-code --domain ${domain}${email ? ` --email ${email}` : ''}`);
      Object.assign(config, {
        baseDomain: domain,
        panelDomain: `panel.${domain}`,
        mailHostname: `mail.${domain}`,
        ns1: `ns1.${domain}`,
        ns2: `ns2.${domain}`,
        workersDomain: `workers.${domain}`,
        ...(email ? { adminEmail: email } : {}),
      });
      log('[dev] Instalando Stalwart y Roundcube, abriendo los puertos de correo…');
      await new Promise((r) => setTimeout(r, 800));
      await reconcileIdentity(true);
      log(`Nameservers: ns1.${domain} y ns2.${domain} · correo: mail.${domain}`);
    });
  }
  const logFile = join(config.logDir, `identity-${Date.now()}.log`);
  const id = startDetachedJob('identity', title, user, logFile);
  const args = ['--yes', '--keep-code', '--domain', domain, ...(email ? ['--email', email] : [])].map((a) => `'${a.replace(/'/g, '')}'`).join(' ');
  // Transient unit: the installer restarts the panel, so it must not run inside it.
  await exec('systemd-run', [
    `--unit=hostpanel-identity-${id}`,
    '--collect',
    '--quiet',
    '--property=Type=oneshot',
    '/bin/bash',
    '-c',
    `bash ${join(config.appDir, 'install.sh')} ${args} >>'${logFile}' 2>&1; echo "HP_JOB_DONE rc=$?" >>'${logFile}'`,
  ]);
  return id;
}

// --- delegation check ---------------------------------------------------------------------

const resolver = new Resolver({ timeout: 3000, tries: 1 });
resolver.setServers(['1.1.1.1', '8.8.8.8']);

const norm = (h: string) => h.toLowerCase().replace(/\.$/, '');

/** What the internet sees for a domain right now, compared with what the panel expects. */
export async function delegationStatus(d: DomainRow) {
  const expected = [config.ns1, config.ns2].map(norm);
  const isMain = !!config.baseDomain && d.name === config.baseDomain;
  let current: string[] = [];
  let a: string[] = [];
  let mx: string[] = [];
  if (config.dev) {
    // Believable sample: the main domain is delegated, the rest still use the registrar's DNS.
    current = isMain ? expected : ['dns1.registrar-servers.com', 'dns2.registrar-servers.com'];
    a = isMain ? [config.serverIp] : ['192.0.2.44'];
    mx = isMain ? [config.mailHostname] : [];
  } else {
    [current, a, mx] = await Promise.all([
      resolver.resolveNs(d.name).catch(() => [] as string[]),
      resolver.resolve4(d.name).catch(() => [] as string[]),
      resolver.resolveMx(d.name).then((r) => r.map((x) => x.exchange)).catch(() => [] as string[]),
    ]);
  }
  current = current.map(norm).sort();
  const delegated = current.length > 0 && expected.every((n) => current.includes(n));
  return {
    domain: d.name,
    is_main: isMain,
    expected_nameservers: expected,
    current_nameservers: current,
    delegated,
    /** Child nameservers ("glue") to create at the registrar of the main domain. */
    glue: isMain
      ? expected.map((host) => ({ host, ipv4: config.serverIp, ipv6: config.serverIpv6 || null }))
      : [],
    public_a: a,
    public_mx: mx.map(norm),
    points_here: a.includes(config.serverIp),
    mail_ok: !!config.mailHostname && mx.map(norm).includes(norm(config.mailHostname)),
  };
}

/** Records to copy into another DNS provider when the domain isn't delegated to this server. */
export async function externalRecords(d: DomainRow) {
  if (!d.dns_enabled) return [];
  const recs = await dns.listRecords(d.name);
  return recs.filter((r) => r.type !== 'SOA' && !(r.type === 'NS' && r.name === '@'));
}

export const mainDomainCandidates = () => all<{ id: number; name: string }>('SELECT id, name FROM domains WHERE dns_enabled = 1 ORDER BY name');
export const domainById = (id: number) => get<DomainRow>('SELECT * FROM domains WHERE id = ?', id);
