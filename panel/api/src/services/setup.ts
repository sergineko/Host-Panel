/**
 * First-run setup. A fresh install has no panel users: the installer prints a one-time link
 * (https://IP:2087/setup?token=…) and the first visit walks through
 *
 *   1. the administrator account (non-obvious username, strong password, contact email)
 *   2. two-factor authentication (recommended)
 *   3. the server's main domain and time zone: the domain becomes ns1/ns2 (nameservers of every
 *      hosted domain), mail and panel, and its DNS zone is managed from the panel
 *   4. what to change at the registrar (glue records, nameservers) and the VPS provider (PTR)
 *
 * The token stops anyone who finds the IP first from claiming the panel. Setup state:
 *   setup_completed = '0'  wizard running (set when the first account is created)
 *   setup_completed = '1'  done (also set for servers installed before the wizard existed)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { join } from 'node:path';
import { config } from '../config.ts';
import { get, getSetting, run, setSetting } from '../db.ts';
import { randomToken, safeEqual, sha256 } from '../lib/crypto.ts';
import { exec } from '../lib/exec.ts';
import { HttpError } from '../lib/validate.ts';
import * as dns from './dns.ts';
import { serverIdentity, setMainDomain } from './identity.ts';

const TOKEN_TTL = 7 * 24 * 3600 * 1000;

export const userCount = () => get<{ n: number }>('SELECT COUNT(*) n FROM users')!.n;
export const setupPending = () => getSetting('setup_completed') === '0';

/** Called at boot. */
export function ensureSetupState() {
  const users = userCount();
  const state = getSetting('setup_completed');
  if (users > 0) {
    // Installed before the wizard existed: nothing to ask.
    if (state === undefined) setSetting('setup_completed', '1');
    return;
  }
  setSetting('setup_completed', '0');
  if (config.dev) {
    console.log(`Configuración inicial pendiente: abre http://localhost:${config.listenPort}/setup`);
    return;
  }
  if (!validTokenRecord()) {
    const token = newSetupToken();
    console.log(`Configuración inicial pendiente: ${setupUrls(token)[0]}  (nuevo enlace: sudo hostpanel setup-link)`);
  }
}

function validTokenRecord() {
  const raw = getSetting('setup_token');
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw) as { hash: string; expires: number };
    return rec.expires > Date.now() ? rec : null;
  } catch {
    return null;
  }
}

/** New one-time setup token (replaces the previous one). Only its hash is stored. */
export function newSetupToken() {
  const token = randomToken(24);
  setSetting('setup_token', JSON.stringify({ hash: sha256(token), expires: Date.now() + TOKEN_TTL }));
  // Root-only copy so `hostpanel info` can show it again while setup is pending.
  try {
    writeFileSync(join(config.dataDir, 'setup-url'), `${setupUrls(token).join('\n')}\n`, { mode: 0o600 });
  } catch {
    /* data dir not writable (tests): the console line is enough */
  }
  return token;
}

export function setupUrls(token: string) {
  // Behind a router the local address comes first: it's the one that works from the same network.
  const urls = [
    ...(config.localIp ? [`https://${config.localIp}:${config.panelPort}/setup?token=${token}`] : []),
    `https://${config.serverIp}:${config.panelPort}/setup?token=${token}`,
  ];
  if (config.panelDomain) urls.push(`https://${config.panelDomain}/setup?token=${token}`);
  return urls;
}

export function checkSetupToken(token: string | undefined) {
  if (config.dev) return true;
  const rec = validTokenRecord();
  return !!rec && !!token && safeEqual(sha256(token), rec.hash);
}

export function consumeSetupToken() {
  run("DELETE FROM settings WHERE key = 'setup_token'");
  const file = join(config.dataDir, 'setup-url');
  if (existsSync(file)) writeFileSync(file, '');
}

/** True when the IP the installer detected can't be reached from the internet (NAT, private network). */
export function isPrivateIp(ip: string) {
  if (!isIPv4(ip)) return false;
  const [a = 0, b = 0] = ip.split('.').map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
}

// --- time zone ------------------------------------------------------------------------------

export function currentTimezone() {
  const saved = getSetting('timezone');
  if (saved) return saved;
  try {
    if (!config.dev && existsSync('/etc/timezone')) return readFileSync('/etc/timezone', 'utf8').trim() || 'UTC';
  } catch {
    /* fall through */
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function validTimezone(tz: string) {
  return tz === 'UTC' || Intl.supportedValuesOf('timeZone').includes(tz);
}

/** System time zone: schedules (backups, cron, nightly updates) and logs follow it. */
export async function setTimezone(tz: string) {
  if (!validTimezone(tz)) throw new HttpError(400, 'Zona horaria no válida');
  await exec('timedatectl', ['set-timezone', tz]);
  setSetting('timezone', tz);
}

// --- main domain ------------------------------------------------------------------------------

/**
 * Adds the domain with its DNS zone managed here (if it isn't already) and makes it the main
 * domain of the server. Returns the job id, or null when it already is the main domain.
 */
export async function configureMainDomain(name: string, email: string, user: string): Promise<number | null> {
  const identity = serverIdentity();
  if (identity.nameservers_ready && identity.base_domain === name && identity.admin_email === email) return null;
  let row = get<{ id: number; dns_enabled: number }>('SELECT id, dns_enabled FROM domains WHERE name = ?', name);
  if (row && !row.dns_enabled) {
    throw new HttpError(400, `${name} ya está añadido con el DNS en otro proveedor. Actívale el DNS del panel o elige otro dominio.`);
  }
  if (!row) {
    const zones = await dns.listZones();
    if (!zones.includes(name)) await dns.createZone(name, dns.defaultZoneRecords(name));
    row = { id: run('INSERT INTO domains (name, dns_enabled) VALUES (?, 1)', name).id, dns_enabled: 1 };
    run('INSERT OR IGNORE INTO security (domain_id) VALUES (?)', row.id);
  }
  return setMainDomain(name, email, user);
}
