import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.ts';
import { all, get } from '../db.ts';
import { parse } from '../lib/validate.ts';
import { recentRequests, trafficSeries } from '../services/analytics.ts';
import { caddyState } from '../services/caddy.ts';
import { servicesStatus, systemInfo } from '../services/system.ts';
import { defaultPhpVersion } from '../services/php.ts';

export default async function systemRoutes(app: FastifyInstance) {
  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/dashboard', async () => {
    const count = (table: string) => get<{ n: number }>(`SELECT COUNT(*) n FROM ${table}`)!.n;
    const { series } = trafficSeries(24);
    return {
      system: systemInfo(),
      services: await servicesStatus(),
      caddy: caddyState(),
      counts: {
        domains: count('domains'),
        sites: count('sites'),
        proxies: count('proxy_routes'),
        databases: count('databases'),
        buckets: count('buckets'),
        servers: count('servers'),
        serversOnline: get<{ n: number }>("SELECT COUNT(*) n FROM servers WHERE status = 'online'")!.n,
        mailDomains: get<{ n: number }>('SELECT COUNT(*) n FROM domains WHERE mail_enabled = 1')!.n,
      },
      traffic24h: series.reduce(
        (acc, s) => ({ requests: acc.requests + s.requests, bytes: acc.bytes + s.bytes, blocked: acc.blocked + s.blocked }),
        { requests: 0, bytes: 0, blocked: 0 },
      ),
      series,
      recentDeployments: all(
        `SELECT d.id, d.site_id, s.name site_name, d.status, d.trigger, d.commit_message, d.created_at
         FROM deployments d JOIN sites s ON s.id = d.site_id ORDER BY d.id DESC LIMIT 8`,
      ),
      panel: { domain: config.panelDomain, ip: config.serverIp, port: config.panelPort, dev: config.dev },
    };
  });

  app.get('/api/analytics', async (req) => {
    const q = parse(z.object({ hours: z.coerce.number().int().min(1).max(24 * 90).default(24), host: z.string().optional() }), req.query);
    return trafficSeries(q.hours, q.host || undefined);
  });

  app.get('/api/analytics/live', async (req) => {
    const q = parse(z.object({ host: z.string().optional() }), req.query);
    return recentRequests(q.host || undefined);
  });

  app.get('/api/audit', async () => all('SELECT * FROM audit ORDER BY id DESC LIMIT 200'));

  app.get('/api/settings', async () => ({
    serverIp: config.serverIp,
    serverIpv6: config.serverIpv6,
    panelDomain: config.panelDomain,
    panelPort: config.panelPort,
    nameservers: [config.ns1, config.ns2],
    mailHostname: config.mailHostname,
    adminEmail: config.adminEmail,
    phpVersion: defaultPhpVersion(),
  }));
}
