#!/usr/bin/env node
// Issues a signed licence (until the licence server does it automatically).
//
//   node tools/license/issue.mjs <plan> <email> [caduca-AAAA-MM-DD]
//
// The private key is read from ~/.hostpanel-license/license-private.pem (on Windows that is
// C:\Users\<usuario>\.hostpanel-license\license-private.pem), or from the file in HP_LICENSE_KEY.
//
// Plans: personal (1 acceso) · profesional (5) · empresa (20) · reseller (50 incluidos + extras, marca propia)
// The customer pastes the printed licence in "Ya tengo licencia", or runs: sudo hostpanel license <licencia>
import { createPrivateKey, randomBytes, sign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PLANS = ['personal', 'profesional', 'empresa', 'reseller'];
const [plan, email, expires] = process.argv.slice(2);
const keyFile = process.env.HP_LICENSE_KEY || join(homedir(), '.hostpanel-license', 'license-private.pem');

if (!plan || !PLANS.includes(plan) || !email?.includes('@')) {
  console.error(`Uso: node tools/license/issue.mjs <${PLANS.join('|')}> <email> [AAAA-MM-DD]`);
  process.exit(1);
}
if (expires && !/^\d{4}-\d{2}-\d{2}$/.test(expires)) {
  console.error('La fecha de caducidad debe ser AAAA-MM-DD');
  process.exit(1);
}
if (!existsSync(keyFile)) {
  console.error(`No se encuentra la clave privada en ${keyFile}.`);
  console.error('Créala una vez con: node tools/license/keygen.mjs   (o indica otra ruta en HP_LICENSE_KEY)');
  process.exit(1);
}

const payload = {
  v: 1,
  id: `HP-${randomBytes(6).toString('hex').toUpperCase()}`,
  plan,
  email: email.toLowerCase(),
  issued_at: new Date().toISOString(),
  ...(expires ? { expires_at: `${expires}T23:59:59Z` } : {}),
};
const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
const signature = sign(null, Buffer.from(body), createPrivateKey(readFileSync(keyFile))).toString('base64url');
console.error(`Licencia ${payload.id} · plan ${plan} · ${payload.email}${expires ? ` · caduca ${expires}` : ''}`);
console.log(`${body}.${signature}`);
