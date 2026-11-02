import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { config } from './config.ts';
import { authPlugin, ensureAdminUser } from './auth.ts';
import { HttpError } from './lib/validate.ts';
import { startAnalytics } from './services/analytics.ts';
import { syncCaddy } from './services/caddy.ts';
import { startCertSync } from './services/certsync.ts';
import { recoverInterruptedDeployments } from './services/deploy.ts';
import domainRoutes from './routes/domains.ts';
import siteRoutes from './routes/sites.ts';
import webhookRoutes from './routes/webhooks.ts';
import proxyRoutes from './routes/proxy.ts';
import mailRoutes from './routes/mail.ts';
import databaseRoutes from './routes/databases.ts';
import systemRoutes from './routes/system.ts';

const app = Fastify({
  logger: { level: config.dev ? 'info' : 'warn' },
  trustProxy: '127.0.0.1', // only Caddy, on the same host, sits in front of the panel
  bodyLimit: 2 * 1024 * 1024,
});

app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
  if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message });
  if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
  req.log.error(err);
  return reply.code(500).send({ error: err.message || 'Error interno' });
});

await app.register(cookie);
await authPlugin(app);
await app.register(systemRoutes);
await app.register(domainRoutes);
await app.register(siteRoutes);
await app.register(webhookRoutes);
await app.register(proxyRoutes);
await app.register(mailRoutes);
await app.register(databaseRoutes);

// Single-page app.
if (existsSync(config.webDist)) {
  await app.register(fastifyStatic, { root: config.webDist });
  app.setNotFoundHandler((req, reply) => {
    // Client-side routes get index.html; missing assets (paths with an extension) stay 404.
    const path = req.url.split('?')[0] ?? '';
    if (req.method === 'GET' && !path.startsWith('/api/') && !/\.[a-z0-9]+$/i.test(path)) {
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    }
    return reply.code(404).send({ error: 'No encontrado' });
  });
}

// Security headers for the panel itself.
app.addHook('onSend', async (_req, reply) => {
  reply.header('X-Frame-Options', 'DENY');
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'same-origin');
});

await ensureAdminUser();
recoverInterruptedDeployments();
startAnalytics();
startCertSync();

await app.listen({ host: config.listenHost, port: config.listenPort });
console.log(`HostPanel escuchando en http://${config.listenHost}:${config.listenPort}${config.dev ? ' (modo desarrollo)' : ''}`);

// Push the full proxy configuration on start (Caddy may have restarted without it).
syncCaddy().catch((err) => console.error('No se pudo sincronizar Caddy:', err.message));
