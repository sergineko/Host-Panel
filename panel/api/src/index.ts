import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { config } from './config.ts';
import { authPlugin } from './auth.ts';
import { accessPlugin } from './access.ts';
import clientRoutes from './routes/clients.ts';
import licenseRoutes from './routes/license.ts';
import { ensureSetupState } from './services/setup.ts';
import setupRoutes from './routes/setup.ts';
import { HttpError } from './lib/validate.ts';
import { startAnalytics } from './services/analytics.ts';
import { syncCaddy } from './services/caddy.ts';
import { startCertSync } from './services/certsync.ts';
import { recoverInterruptedDeployments } from './services/deploy.ts';
import { recoverJobs } from './services/jobs.ts';
import { startServerHealth } from './services/servers.ts';
import { startAutoUpdates } from './services/updates.ts';
import domainRoutes from './routes/domains.ts';
import siteRoutes from './routes/sites.ts';
import webhookRoutes from './routes/webhooks.ts';
import proxyRoutes from './routes/proxy.ts';
import mailRoutes from './routes/mail.ts';
import databaseRoutes from './routes/databases.ts';
import systemRoutes from './routes/system.ts';
import serverRoutes from './routes/servers.ts';
import storageRoutes from './routes/storage.ts';
import adminRoutes from './routes/admin.ts';
import workerRoutes from './routes/workers.ts';
import queueRoutes from './routes/queues.ts';
import kvRoutes from './routes/kv.ts';
import nosqlRoutes from './routes/nosql.ts';
import loadBalancerRoutes from './routes/loadbalancers.ts';
import nodeRoutes from './routes/nodejs.ts';
import certificateRoutes from './routes/certificates.ts';
import siteToolRoutes from './routes/sitetools.ts';
import siteAccessRoutes from './routes/siteaccess.ts';
import identityRoutes from './routes/identity.ts';
import { reconcileIdentity } from './services/identity.ts';
import wpToolkitRoutes from './routes/wptoolkit.ts';
import { startWpAutoUpdates } from './services/wptoolkit.ts';
import { startBackupScheduler } from './services/backups.ts';
import { startSiteCronScheduler } from './services/sitecrons.ts';
import { startInternalServer } from './internal.ts';
import { startCronScheduler, startQueueDispatcher } from './services/queues.ts';
import { startKvJanitor } from './services/kv.ts';
import { startWorkersOnBoot } from './services/workers.ts';

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
accessPlugin(app);
await app.register(setupRoutes);
await app.register(clientRoutes);
await app.register(licenseRoutes);
await app.register(systemRoutes);
await app.register(domainRoutes);
await app.register(siteRoutes);
await app.register(webhookRoutes);
await app.register(proxyRoutes);
await app.register(mailRoutes);
await app.register(databaseRoutes);
await app.register(serverRoutes);
await app.register(storageRoutes);
await app.register(adminRoutes);
await app.register(workerRoutes);
await app.register(queueRoutes);
await app.register(kvRoutes);
await app.register(nosqlRoutes);
await app.register(loadBalancerRoutes);
await app.register(nodeRoutes);
await app.register(certificateRoutes);
await app.register(siteToolRoutes);
await app.register(siteAccessRoutes);
await app.register(identityRoutes);
await app.register(wpToolkitRoutes);

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

ensureSetupState();
recoverInterruptedDeployments();
recoverJobs();
startServerHealth();
startAutoUpdates();
startAnalytics();
startCertSync();

await app.listen({ host: config.listenHost, port: config.listenPort });
await startInternalServer();
startQueueDispatcher();
startCronScheduler();
startSiteCronScheduler();
// New main domain or nameservers since last boot: update every zone (and mail) to match.
reconcileIdentity().catch((err) => console.error('Identidad del servidor:', err.message));
startBackupScheduler();
startWpAutoUpdates();
startKvJanitor();
startWorkersOnBoot().catch((err) => console.error('Workers:', err.message));
console.log(`HostPanel escuchando en http://${config.listenHost}:${config.listenPort}${config.dev ? ' (modo desarrollo)' : ''}`);

// Push the full proxy configuration on start (Caddy may have restarted without it).
syncCaddy().catch((err) => console.error('No se pudo sincronizar Caddy:', err.message));
