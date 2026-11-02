/**
 * Copies the certificate Caddy obtained for the mail hostname into Stalwart, so IMAP/SMTP
 * use the same trusted Let's Encrypt certificate as the webmail. Runs hourly.
 */
import { copyFile, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.ts';
import { exec } from '../lib/exec.ts';
import { reloadMailServer } from './mail.ts';

async function findCaddyCert(host: string) {
  const base = join(config.caddyDataDir, 'certificates');
  for (const issuer of await readdir(base).catch(() => [] as string[])) {
    const dir = join(base, issuer, host);
    const crt = join(dir, `${host}.crt`);
    const key = join(dir, `${host}.key`);
    try {
      await stat(crt);
      await stat(key);
      return { crt, key };
    } catch {
      /* try next issuer */
    }
  }
  return null;
}

async function syncMailCertificate() {
  if (config.dev || !config.mailHostname) return;
  const found = await findCaddyCert(config.mailHostname);
  if (!found) return;
  const targetCrt = join(config.stalwartCertDir, 'mail.crt');
  const [src, dst] = await Promise.all([readFile(found.crt, 'utf8'), readFile(targetCrt, 'utf8').catch(() => '')]);
  if (src === dst) return;
  await copyFile(found.crt, targetCrt);
  await copyFile(found.key, join(config.stalwartCertDir, 'mail.key'));
  await exec('chown', ['stalwart:stalwart', targetCrt, join(config.stalwartCertDir, 'mail.key')]);
  await exec('chmod', ['0600', join(config.stalwartCertDir, 'mail.key')]);
  await reloadMailServer();
  console.log(`Certificado de ${config.mailHostname} actualizado en Stalwart`);
}

export function startCertSync() {
  const tick = () => syncMailCertificate().catch((err) => console.error('certsync:', err));
  setTimeout(tick, 60_000).unref();
  setInterval(tick, 3600_000).unref();
}
