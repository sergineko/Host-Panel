/**
 * Who can call what.
 *
 *   owner   the licence holder: everything
 *   admin   team member: everything except managing the owner and other team members
 *   client  a reseller's customer: only its own domains (with their DNS, mail, security and
 *           sites) and its own databases
 *
 * Clients are denied by default: a route works for them only if it is listed in RULES below,
 * and each rule checks that the resource belongs to the client. New routes are therefore
 * closed to clients until someone adds them here on purpose.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { SessionUser } from './auth.ts';
import { all, get, type DomainRow } from './db.ts';
import { HttpError, matchDomain } from './lib/validate.ts';
import { hasLicense } from './services/license.ts';

/** What still works without a licence: signing in/out, the licence itself and the first-run wizard. */
const WITHOUT_LICENSE = ['/api/auth/', '/api/license', '/api/setup/', '/api/branding/public'];

export const isStaff = (u: SessionUser | undefined) => !!u && u.role !== 'client';
export const isClient = (u: SessionUser | undefined): u is SessionUser & { clientId: number } => !!u && u.role === 'client' && u.clientId !== null;

// --- ownership checks ------------------------------------------------------------------------

export function clientDomainIds(clientId: number): number[] {
  return all<{ id: number }>('SELECT id FROM domains WHERE client_id = ?', clientId).map((d) => d.id);
}

export function ownsDomain(clientId: number, domainId: unknown) {
  return !!get('SELECT 1 FROM domains WHERE id = ? AND client_id = ?', Number(domainId), clientId);
}

export function ownsSite(clientId: number, siteId: unknown) {
  return !!get('SELECT 1 FROM sites s JOIN domains d ON d.id = s.domain_id WHERE s.id = ? AND d.client_id = ?', Number(siteId), clientId);
}

export function ownsDatabase(clientId: number, dbId: unknown) {
  return !!get('SELECT 1 FROM databases WHERE id = ? AND client_id = ?', Number(dbId), clientId);
}

/** The address belongs to one of the client's domains. */
export function ownsEmail(clientId: number, email: unknown) {
  if (typeof email !== 'string' || !email.includes('@')) return false;
  const domain = email.split('@').pop()!.trim().toLowerCase();
  return !!get('SELECT 1 FROM domains WHERE name = ? AND client_id = ?', domain, clientId);
}

/** Every hostname falls under a domain of this client (the most specific registered domain wins). */
export function ownsHosts(clientId: number, hosts: unknown) {
  if (!Array.isArray(hosts) || hosts.length === 0) return false;
  const domains = all<DomainRow>('SELECT * FROM domains');
  return hosts.every((h) => typeof h === 'string' && matchDomain(h.trim().toLowerCase().replace(/^\*\./, ''), domains)?.client_id === clientId);
}

/** Clients deploy only on this server (other VPS belong to the licence holder). */
const localOnly = (ids: unknown) => ids === undefined || (Array.isArray(ids) && ids.every((x) => x === 0));

// --- rules -----------------------------------------------------------------------------------

type Ctx = { req: FastifyRequest; clientId: number; username: string; params: Record<string, string>; body: Record<string, unknown>; query: Record<string, string> };
type Rule = (c: Ctx) => boolean;

const always: Rule = () => true;
const siteParam: Rule = (c) => ownsSite(c.clientId, c.params.id);
const domainParam: Rule = (c) => ownsDomain(c.clientId, c.params.id);
const databaseParam: Rule = (c) => ownsDatabase(c.clientId, c.params.id);
const newSite: Rule = (c) => {
  if (!ownsHosts(c.clientId, c.body.hostnames)) throw new HttpError(403, 'Solo puedes usar direcciones de tus propios dominios');
  if (!localOnly(c.body.server_ids)) throw new HttpError(403, 'Tu cuenta solo puede publicar en este servidor');
  return true;
};

/** Exact "METHOD /route/pattern" → rule. */
const RULES: Record<string, Rule> = {
  // Lists: the handlers return only the client's own rows.
  'GET /api/domains': always,
  'GET /api/sites': always,
  'GET /api/mail': always,
  'GET /api/databases': always,
  'GET /api/server/identity': always,
  'GET /api/servers': always,

  // Read-only catalogues the site form needs.
  'GET /api/php': always,
  'GET /api/nodejs': always,
  'GET /api/crons/preview': always,

  // Sites.
  'POST /api/sites': newSite,
  'POST /api/sites/wordpress': newSite,
  'PUT /api/sites/:id': (c) => {
    if (!siteParam(c)) return false;
    if (c.body.hostnames !== undefined && !ownsHosts(c.clientId, c.body.hostnames)) {
      throw new HttpError(403, 'Solo puedes usar direcciones de tus propios dominios');
    }
    if (!localOnly(c.body.server_ids)) throw new HttpError(403, 'Tu cuenta solo puede publicar en este servidor');
    return true;
  },
  'GET /api/deployments/:id': (c) => {
    const dep = get<{ site_id: number }>('SELECT site_id FROM deployments WHERE id = ?', Number(c.params.id));
    return !!dep && ownsSite(c.clientId, dep.site_id);
  },

  // Domains: clients manage the ones assigned to them but don't add or delete domains.
  'DELETE /api/domains/:id': () => {
    throw new HttpError(403, 'Para eliminar un dominio, pídeselo a tu proveedor');
  },

  // Mailboxes of their domains.
  'POST /api/mail/mailboxes': (c) => ownsEmail(c.clientId, c.body.email),
  'PUT /api/mail/mailboxes/:email': (c) => ownsEmail(c.clientId, c.params.email),
  'DELETE /api/mail/mailboxes/:email': (c) => ownsEmail(c.clientId, c.params.email),
  'POST /api/mail/mailboxes/:email/aliases': (c) => ownsEmail(c.clientId, c.params.email) && ownsEmail(c.clientId, c.body.alias),
  'DELETE /api/mail/mailboxes/:email/aliases/:alias': (c) => ownsEmail(c.clientId, c.params.email) && ownsEmail(c.clientId, c.params.alias),

  // Databases (new ones are created for the client).
  'POST /api/databases': always,

  // SSL status of their hostnames; IP rules of their domains.
  'GET /api/certificates': (c) => !!c.query.hosts && ownsHosts(c.clientId, c.query.hosts.split(',').filter(Boolean)),
  'POST /api/certificates/retry': always,
  'POST /api/ip-rules': (c) => c.body.domain_id != null && ownsDomain(c.clientId, c.body.domain_id),
  'DELETE /api/ip-rules/:id': (c) => {
    const rule = get<{ domain_id: number | null }>('SELECT domain_id FROM ip_rules WHERE id = ?', Number(c.params.id));
    return !!rule?.domain_id && ownsDomain(c.clientId, rule.domain_id);
  },

  // Background jobs they started themselves.
  'GET /api/jobs/:id': (c) => !!get('SELECT 1 FROM jobs WHERE id = ? AND created_by = ?', Number(c.params.id), c.username),
};

/** Everything under a resource the client owns (files, backups, DNS records…). */
const PREFIX_RULES: [string, Rule][] = [
  ['/api/auth/', always],
  ['/api/sites/:id/', siteParam],
  ['/api/domains/:id/', domainParam],
  ['/api/databases/:id/', databaseParam],
];
const EXACT_RESOURCE: Record<string, Rule> = {
  '/api/sites/:id': siteParam,
  '/api/domains/:id': domainParam,
  '/api/databases/:id': databaseParam,
};

export function clientRule(method: string, url: string): Rule | null {
  const exact = RULES[`${method} ${url}`];
  if (exact) return exact;
  if (EXACT_RESOURCE[url]) return EXACT_RESOURCE[url]!;
  for (const [prefix, rule] of PREFIX_RULES) if (url.startsWith(prefix)) return rule;
  return null;
}

export function accessPlugin(app: FastifyInstance) {
  app.addHook('preHandler', async (req) => {
    const user = req.user;
    if (!user) return;
    if (!hasLicense() && !WITHOUT_LICENSE.some((p) => (req.routeOptions.url ?? '').startsWith(p))) {
      throw new HttpError(402, 'El panel necesita una licencia activa');
    }
    if (isStaff(user)) return;
    const url = req.routeOptions.url ?? '';
    const rule = clientRule(req.method, url);
    if (!isClient(user) || !rule) throw new HttpError(403, 'Tu cuenta no tiene acceso a esta sección');
    const ok = rule({
      req,
      clientId: user.clientId,
      username: user.username,
      params: (req.params ?? {}) as Record<string, string>,
      body: (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>,
      query: (req.query ?? {}) as Record<string, string>,
    });
    // 404 rather than 403 on someone else's resource: don't confirm it exists.
    if (!ok) throw new HttpError(url.includes(':') ? 404 : 403, url.includes(':') ? 'No encontrado' : 'Tu cuenta no tiene acceso a esto');
  });
}

/** For handlers: the client id to filter by, or null for staff (sees everything). */
export const scopeOf = (req: FastifyRequest) => (isClient(req.user) ? req.user.clientId : null);
