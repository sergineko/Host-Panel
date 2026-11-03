import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { checkThrottle, registerFailure, startSession } from '../auth.ts';
import { config } from '../config.ts';
import { audit, get, getSetting, run, setSetting } from '../db.ts';
import { isEmail, normalizeUsername, passwordProblem, usernameProblem } from '../lib/accounts.ts';
import { hashPassword } from '../lib/crypto.ts';
import { badRequest, domainName, HttpError, parse } from '../lib/validate.ts';
import { mainDomainCandidates, serverIdentity } from '../services/identity.ts';
import { hasLicense, installLicense, LICENSE_STORE_URL, PLANS } from '../services/license.ts';
import { runningJob } from '../services/jobs.ts';
import {
  checkSetupToken,
  configureMainDomain,
  consumeSetupToken,
  currentTimezone,
  isPrivateIp,
  setTimezone,
  setupPending,
  userCount,
  validTimezone,
} from '../services/setup.ts';

const tokenBody = z.object({ token: z.string().max(200).optional() });

function requireToken(ip: string, token: string | undefined) {
  checkThrottle(ip);
  if (userCount() > 0) throw new HttpError(409, 'El panel ya está configurado. Inicia sesión.');
  if (!checkSetupToken(token)) {
    registerFailure(ip);
    throw new HttpError(403, 'El enlace de configuración no es válido o ha caducado. Genera uno nuevo en el servidor con: sudo hostpanel setup-link');
  }
}

function requireSetup() {
  if (!setupPending()) throw new HttpError(409, 'La configuración inicial ya está terminada');
}

export default async function setupRoutes(app: FastifyInstance) {
  // Public: tells the interface whether to show the login or the setup wizard.
  app.get('/api/setup/status', async () => ({
    required: setupPending(),
    account: userCount() > 0,
    token_required: !config.dev,
    license: hasLicense(),
    store_url: LICENSE_STORE_URL,
    plans: Object.values(PLANS),
  }));

  app.post('/api/setup/verify', async (req) => {
    const { token } = parse(tokenBody, req.body);
    requireToken(req.ip, token);
    return { ok: true, server_ip: config.serverIp, admin_email: /@example\.com$/.test(config.adminEmail) ? '' : config.adminEmail };
  });

  // Step 0: the licence (every plan is paid). Needs the one-time link, like the account.
  app.post('/api/setup/license', async (req) => {
    const body = parse(tokenBody.extend({ license: z.string().min(20).max(4000) }), req.body);
    requireToken(req.ip, body.token);
    const license = installLicense(body.license);
    audit(license.email, 'license.install', `${license.id} (${license.plan})`, req.ip);
    return { plan: PLANS[license.plan], email: license.email, id: license.id };
  });

  // Step 1: the administrator account. Logs in straight away.
  app.post('/api/setup/account', async (req, reply) => {
    const body = parse(
      tokenBody.extend({
        username: z.string().max(200),
        email: z.string().trim().toLowerCase().max(200),
        password: z.string().max(256),
      }),
      req.body,
    );
    requireToken(req.ip, body.token);
    if (!hasLicense()) throw new HttpError(402, 'Introduce primero la licencia');
    const username = normalizeUsername(body.username);
    const problem = usernameProblem(username) ?? (isEmail(body.email) ? null : 'Escribe un correo electrónico válido') ?? passwordProblem(body.password, username);
    if (problem) throw badRequest(problem);
    const hash = await hashPassword(body.password);
    // Checked again after the (async) hash so two simultaneous requests can't both create one.
    if (userCount() > 0) throw new HttpError(409, 'El panel ya está configurado. Inicia sesión.');
    const { id } = run('INSERT INTO users (username, password_hash, email) VALUES (?, ?, ?)', username, hash, body.email);
    setSetting('setup_completed', '0');
    consumeSetupToken();
    startSession(req, reply, id);
    audit(username, 'setup.account', body.email, req.ip);
    return { username };
  });

  // Everything below needs the session created in step 1.
  app.get('/api/setup/state', async (req) => {
    const u = get<{ totp_secret: string; email: string }>('SELECT totp_secret, email FROM users WHERE id = ?', req.user!.id)!;
    const identity = serverIdentity();
    return {
      pending: setupPending(),
      username: req.user!.username,
      email: u.email,
      totp: !!u.totp_secret,
      twofa_done: !!u.totp_secret || getSetting('setup_2fa_done') === '1',
      timezone: currentTimezone(),
      private_ip: isPrivateIp(config.serverIp),
      local_ip: config.localIp || null,
      identity: { ...identity, candidates: mainDomainCandidates() },
      main_domain_id: identity.base_domain ? (get<{ id: number }>('SELECT id FROM domains WHERE name = ?', identity.base_domain)?.id ?? null) : null,
    };
  });

  app.post('/api/setup/2fa/skip', async (req) => {
    requireSetup();
    setSetting('setup_2fa_done', '1');
    audit(req.user!.username, 'setup.2fa_skip', '', req.ip);
    return { ok: true };
  });

  // Step 3: main domain + time zone. Re-runs the installer with the domain (background job).
  app.post('/api/setup/domain', async (req) => {
    requireSetup();
    // Already configuring (double click, page reloaded while the installer runs): follow that job.
    const running = runningJob('identity');
    if (running) return { job_id: running.id };
    const body = parse(
      z.object({
        domain: domainName.transform((d) => d.replace(/^www\./, '')),
        email: z.email('Email no válido'),
        timezone: z.string().max(64).refine(validTimezone, 'Zona horaria no válida'),
      }),
      req.body,
    );
    if (/\.(local|localhost|test|example|invalid|internal|lan)$/.test(body.domain)) {
      throw badRequest('Usa un dominio registrado en internet (no .local, .test, .lan…)');
    }
    if (body.timezone !== currentTimezone()) await setTimezone(body.timezone);
    run('UPDATE users SET email = ? WHERE id = ? AND email = ?', body.email, req.user!.id, '');
    audit(req.user!.username, 'setup.domain', `${body.domain} · ${body.timezone}`, req.ip);
    return { job_id: await configureMainDomain(body.domain, body.email, req.user!.username) };
  });

  app.post('/api/setup/finish', async (req) => {
    requireSetup();
    if (!serverIdentity().nameservers_ready) throw badRequest('Configura primero el dominio principal');
    setSetting('setup_completed', '1');
    audit(req.user!.username, 'setup.finish', '', req.ip);
    return { ok: true };
  });
}
