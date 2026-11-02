/**
 * GitHub webhook receiver. Configure in GitHub → Settings → Webhooks:
 *   Payload URL:  https://<panel>/api/webhooks/github/<siteId>
 *   Content type: application/json
 *   Secret:       the site's webhook secret (shown in the panel)
 *   Events:       Just the push event
 */
import type { FastifyInstance } from 'fastify';
import { createHmac } from 'node:crypto';
import { audit, get, type SiteRow } from '../db.ts';
import { safeEqual } from '../lib/crypto.ts';
import { HttpError } from '../lib/validate.ts';
import { enqueueDeploy } from '../services/deploy.ts';

export default async function webhookRoutes(app: FastifyInstance) {
  // Keep the raw body: the HMAC must be computed over the exact bytes GitHub sent.
  // (This plugin is encapsulated, so the change only affects the webhook routes.)
  app.removeContentTypeParser(['application/json']);
  app.addContentTypeParser(['application/json', 'application/x-www-form-urlencoded'], { parseAs: 'buffer', bodyLimit: 25 * 1024 * 1024 }, (_req, body, done) => {
    done(null, body);
  });

  app.post<{ Params: { id: string } }>('/api/webhooks/github/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const site = Number.isInteger(id) ? get<SiteRow>('SELECT * FROM sites WHERE id = ?', id) : undefined;
    // Same answer for unknown site and bad signature: don't reveal which sites exist.
    const raw = req.body as Buffer;
    const signature = String(req.headers['x-hub-signature-256'] ?? '');
    const expected = site ? `sha256=${createHmac('sha256', site.webhook_secret).update(raw).digest('hex')}` : '';
    if (!site || !signature || !safeEqual(signature, expected)) {
      throw new HttpError(401, 'Firma no válida');
    }

    const event = String(req.headers['x-github-event'] ?? '');
    if (event === 'ping') return { ok: true, message: 'pong' };
    if (event !== 'push') return reply.code(202).send({ ok: true, ignored: `evento ${event}` });

    let text = raw.toString('utf8');
    if (String(req.headers['content-type']).includes('x-www-form-urlencoded')) {
      text = new URLSearchParams(text).get('payload') ?? '{}';
    }
    const payload = JSON.parse(text) as { ref?: string; deleted?: boolean; head_commit?: { id?: string; message?: string }; pusher?: { name?: string } };
    if (payload.deleted) return reply.code(202).send({ ok: true, ignored: 'rama eliminada' });
    if (payload.ref !== `refs/heads/${site.branch}`) {
      return reply.code(202).send({ ok: true, ignored: `rama ${payload.ref} (se despliega ${site.branch})` });
    }
    if (!site.auto_deploy) return reply.code(202).send({ ok: true, ignored: 'despliegue automático desactivado' });

    const deploymentId = enqueueDeploy(site.id, `github push (${payload.pusher?.name ?? 'desconocido'})`);
    audit('github', 'site.deploy.webhook', `${site.name} ${payload.head_commit?.id?.slice(0, 7) ?? ''}`, req.ip);
    return reply.code(202).send({ ok: true, deployment_id: deploymentId });
  });
}
