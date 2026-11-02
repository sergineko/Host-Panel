/**
 * Maintenance commands used by the installer and the `hostpanel` CLI:
 *   node src/cli.ts reset-password [usuario] [contraseña]
 *   node src/cli.ts sync-proxy
 *   node src/cli.ts bootstrap-domain <dominio>   (zona DNS + correo del dominio principal)
 */
import { setUserPassword } from './auth.ts';
import { config } from './config.ts';
import { get, run, setSetting } from './db.ts';
import { randomPassword } from './lib/crypto.ts';
import { DOMAIN_RE } from './lib/validate.ts';
import { syncCaddy } from './services/caddy.ts';
import * as dns from './services/dns.ts';
import * as mail from './services/mail.ts';

const [command, ...args] = process.argv.slice(2);

async function bootstrapDomain(name: string) {
  if (!DOMAIN_RE.test(name)) throw new Error(`Dominio no válido: ${name}`);
  let row = get<{ id: number }>('SELECT id FROM domains WHERE name = ?', name);
  if (!row) {
    const zones = await dns.listZones();
    if (!zones.includes(name)) await dns.createZone(name, dns.defaultZoneRecords(name));
    row = { id: run('INSERT INTO domains (name, dns_enabled) VALUES (?, 1)', name).id };
    run('INSERT OR IGNORE INTO security (domain_id) VALUES (?)', row.id);
    console.log(`Dominio ${name} creado con su zona DNS.`);
  }
  if (config.mailHostname) {
    try {
      await mail.ensureMailDomain(name);
      for (const r of await mail.mailDnsRecords(name)) {
        if (['MX', 'TXT', 'SRV', 'CNAME'].includes(r.type)) await dns.addRecord(name, { name: r.name, type: r.type, ttl: 3600, content: r.content });
      }
      run('UPDATE domains SET mail_enabled = 1 WHERE id = ?', row.id);
      console.log(`Correo activado para ${name}.`);
    } catch (err) {
      console.warn(`No se pudo activar el correo todavía (${(err as Error).message}). Actívalo desde el panel.`);
    }
  }
  await syncCaddy().catch((err) => console.warn('Caddy:', (err as Error).message));
}

try {
  switch (command) {
    case 'reset-password': {
      const username = args[0] || 'admin';
      const password = args[1] || randomPassword(16);
      await setUserPassword(username, password);
      console.log(`Usuario:    ${username}\nContraseña: ${password}`);
      break;
    }
    case 'disable-2fa': {
      const username = args[0] || 'admin';
      const r = run("UPDATE users SET totp_secret = '' WHERE username = ?", username);
      console.log(r.changes ? `2FA desactivado para ${username}.` : `No existe el usuario ${username}.`);
      break;
    }
    case 'panel-access-reset':
      // Recovery when the panel IP allowlist locks you out.
      setSetting('panel_allow_ips', '');
      await syncCaddy();
      console.log('Restricción de IPs del panel eliminada.');
      break;
    case 'sync-proxy':
      await syncCaddy();
      console.log('Configuración del proxy aplicada.');
      break;
    case 'bootstrap-domain':
      if (!args[0]) throw new Error('Falta el dominio');
      await bootstrapDomain(args[0]);
      break;
    default:
      console.log('Uso: cli.ts reset-password [usuario] [contraseña] | disable-2fa [usuario] | panel-access-reset | sync-proxy | bootstrap-domain <dominio>');
      process.exit(1);
  }
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
