/**
 * Licence plans and access limits.
 *
 * Every login counts as one access (owner, team or client), as long as it can sign in: disabled
 * logins and users of suspended client accounts don't count.
 *
 *   personal      1 access (the owner alone)
 *   profesional   up to 5 accesses
 *   empresa       up to 20 accesses
 *   reseller      50 included, each extra access is billed; own branding allowed
 *
 * The plan comes from a licence token signed with Ed25519 by the vendor ("<payload>.<signature>",
 * both base64url). The panel only holds the public key, so a licence can't be made up or edited.
 * Every plan is paid: without a valid licence the panel can't be used (the first-run wizard asks
 * for it before anything else; websites and mail are not affected).
 *
 * Going over the limit (for example after moving to a smaller plan) never disables anyone:
 * existing accesses keep working, but no new one can be created or re-enabled.
 */
import { createPublicKey, verify } from 'node:crypto';
import { config } from '../config.ts';
import { get, getSetting, setSetting } from '../db.ts';
import { HttpError } from '../lib/validate.ts';

export type PlanId = 'personal' | 'profesional' | 'empresa' | 'reseller';

export interface Plan {
  id: PlanId;
  name: string;
  /** Hard limit of accesses, or null for no limit. */
  max: number | null;
  /** Accesses included in the base price (the rest are billed one by one). */
  included: number;
  branding: boolean;
}

export const PLANS: Record<PlanId, Plan> = {
  personal: { id: 'personal', name: 'Personal', max: 1, included: 1, branding: false },
  profesional: { id: 'profesional', name: 'Profesional', max: 5, included: 5, branding: false },
  empresa: { id: 'empresa', name: 'Empresa', max: 20, included: 20, branding: false },
  reseller: { id: 'reseller', name: 'Reseller', max: null, included: 50, branding: true },
};

/**
 * Where customers buy a licence (shown in the first-run wizard and the "licence needed" screen).
 * Empty: no buy button, the screen tells them to ask their provider.
 */
export const LICENSE_STORE_URL = '';

/** Vendor public key. The private key never ships with the panel (see tools/license). */
const LICENSE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA8tP/vAoVXpoYq7le4aePqxAkLA+eoFkaE0l3qFmukcc=
-----END PUBLIC KEY-----`;

export interface LicensePayload {
  v: 1;
  /** Licence id (shown to the customer and used by the licence server). */
  id: string;
  plan: PlanId;
  email: string;
  issued_at: string;
  /** End of the paid period (ISO date); suspension rules use it later. */
  expires_at?: string;
}

const b64url = (s: string) => Buffer.from(s, 'base64url');

/** Payload of a correctly signed token, or null. */
export function verifyLicenseToken(token: string, publicKeyPem = LICENSE_PUBLIC_KEY): LicensePayload | null {
  const [payload, signature, extra] = token.trim().split('.');
  if (!payload || !signature || extra !== undefined) return null;
  try {
    const ok = verify(null, Buffer.from(payload), createPublicKey(publicKeyPem), b64url(signature));
    if (!ok) return null;
    const data = JSON.parse(b64url(payload).toString('utf8')) as LicensePayload;
    if (data.v !== 1 || !(data.plan in PLANS) || typeof data.id !== 'string') return null;
    return data;
  } catch {
    return null;
  }
}

export function currentLicense(): { plan: Plan | null; license: LicensePayload | null } {
  const token = getSetting('license_token');
  const license = token ? verifyLicenseToken(token) : null;
  if (license) return { plan: PLANS[license.plan], license };
  // Development only: pick a plan with HP_LICENSE_PLAN while no licence is installed.
  const devPlan = process.env.HP_LICENSE_PLAN;
  if (config.dev && devPlan && devPlan in PLANS) return { plan: PLANS[devPlan as PlanId], license: null };
  return { plan: null, license: null };
}

export const hasLicense = () => currentLicense().plan !== null;

export function installLicense(token: string) {
  const license = verifyLicenseToken(token);
  if (!license) throw new HttpError(400, 'La licencia no es válida. Cópiala completa, tal como la recibiste.');
  setSetting('license_token', token.trim());
  return license;
}

/** Logins that can sign in right now. */
export function accessesInUse() {
  return get<{ n: number }>(
    `SELECT COUNT(*) n FROM users u LEFT JOIN clients c ON c.id = u.client_id
     WHERE u.disabled = 0 AND (u.role != 'client' OR c.status = 'active')`,
  )!.n;
}

export function licenseUsage() {
  const { plan, license } = currentLicense();
  const used = accessesInUse();
  return {
    plan,
    license: license ? { id: license.id, email: license.email, issued_at: license.issued_at, expires_at: license.expires_at ?? null } : null,
    used,
    max: plan ? plan.max : 0,
    included: plan?.included ?? 0,
    /** Billed on top of the base price (Reseller plan). */
    extra: plan && plan.max === null ? Math.max(0, used - plan.included) : 0,
    over_limit: !!plan && plan.max !== null && used > plan.max,
    store_url: LICENSE_STORE_URL,
  };
}

/** Throws when `adding` more accesses would go over the plan. */
export function assertAccessAvailable(adding = 1) {
  const { plan } = currentLicense();
  if (!plan) throw new HttpError(402, 'Necesitas una licencia para usar el panel');
  if (plan.max === null) return;
  const used = accessesInUse();
  if (used + adding > plan.max) {
    throw new HttpError(
      402,
      `Tu plan ${plan.name} permite ${plan.max} ${plan.max === 1 ? 'acceso' : 'accesos'} y ya ${used === 1 ? 'hay 1 en uso' : `hay ${used} en uso`}. ` +
        'Desactiva alguno o cambia a un plan superior.',
    );
  }
}

/** Accesses a client account would bring back if re-activated. */
export function clientAccesses(clientId: number) {
  return get<{ n: number }>('SELECT COUNT(*) n FROM users WHERE client_id = ? AND disabled = 0', clientId)!.n;
}
