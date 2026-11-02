import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Loads KEY=VALUE lines into process.env without overriding existing variables. */
function loadEnvFile(path: string) {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(process.env.HP_ENV_FILE ?? '/etc/hostpanel/hostpanel.env');

const env = (key: string, fallback = '') => process.env[key] ?? fallback;
const phpVersion = env('HP_PHP_VERSION', '8.3');

export const config = {
  /** Dev mode: system commands are logged instead of executed (lets the UI run on any OS). */
  dev: env('HP_DEV') === '1',
  listenHost: env('HP_LISTEN_HOST', '127.0.0.1'),
  listenPort: Number(env('HP_LISTEN_PORT', '3000')),
  dataDir: env('HP_DATA_DIR', '/var/lib/hostpanel'),
  sitesDir: env('HP_SITES_DIR', '/srv/hostpanel/sites'),
  logDir: env('HP_LOG_DIR', '/var/log/hostpanel'),
  storageDir: env('HP_STORAGE_DIR', '/srv/hostpanel/storage'),
  appDir: env('HP_APP_DIR', fileURLToPath(new URL('../../..', import.meta.url))),
  /** Max size of one uploaded object (bytes). */
  maxObjectSize: Number(env('HP_MAX_OBJECT_MB', '5120')) * 1024 * 1024,
  webDist: env('HP_WEB_DIST', fileURLToPath(new URL('../../web/dist', import.meta.url))),
  secret: env('HP_SECRET', 'dev-secret-change-me'),

  adminUser: env('HP_ADMIN_USER', 'admin'),
  adminPassword: env('HP_ADMIN_PASSWORD'),
  adminEmail: env('HP_ADMIN_EMAIL', 'admin@example.com'),

  serverIp: env('HP_SERVER_IP', '127.0.0.1'),
  serverIpv6: env('HP_SERVER_IPV6'),
  panelDomain: env('HP_PANEL_DOMAIN'),
  panelPort: Number(env('HP_PANEL_PORT', '2087')),
  ns1: env('HP_NS1', 'ns1.example.com'),
  ns2: env('HP_NS2', 'ns2.example.com'),
  mailHostname: env('HP_MAIL_HOSTNAME'),

  caddyAdmin: env('HP_CADDY_ADMIN', 'http://127.0.0.1:2019'),
  caddyUser: env('HP_CADDY_USER', 'caddy'),
  caddyDataDir: env('HP_CADDY_DATA', '/var/lib/caddy/caddy'),

  pdnsApi: env('HP_PDNS_API', 'http://127.0.0.1:8081/api/v1/servers/localhost'),
  pdnsKey: env('HP_PDNS_KEY'),

  stalwartApi: env('HP_STALWART_API', 'http://127.0.0.1:8080'),
  stalwartUser: env('HP_STALWART_USER', 'admin'),
  stalwartPassword: env('HP_STALWART_PASSWORD'),
  stalwartCertDir: env('HP_STALWART_CERTS', '/opt/stalwart/etc/certs'),

  mysqlSocket: env('HP_MYSQL_SOCKET', '/run/mysqld/mysqld.sock'),

  /** PHP version chosen at install time (Roundcube runs on it; first default for sites). */
  phpVersion,
  roundcubeDir: env('HP_ROUNDCUBE_DIR', '/var/www/roundcube'),
};

export type Config = typeof config;
