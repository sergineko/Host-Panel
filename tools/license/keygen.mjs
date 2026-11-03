#!/usr/bin/env node
// Creates the Ed25519 key pair that signs HostPanel licences.
//
//   node tools/license/keygen.mjs <carpeta-segura>
//
// Writes license-private.pem (KEEP IT SECRET, never commit it: whoever has it can issue
// licences) and license-public.pem, whose content goes in panel/api/src/services/license.ts.
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv[2] ?? '');
if (!process.argv[2]) {
  console.error('Uso: node tools/license/keygen.mjs <carpeta-segura-fuera-del-repo>');
  process.exit(1);
}
const priv = join(dir, 'license-private.pem');
if (existsSync(priv)) {
  console.error(`Ya existe ${priv}. No se sobrescribe: las licencias emitidas dejarían de valer.`);
  process.exit(1);
}
mkdirSync(dir, { recursive: true });
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
writeFileSync(priv, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
const pub = publicKey.export({ type: 'spki', format: 'pem' });
writeFileSync(join(dir, 'license-public.pem'), pub);
console.log(`Clave privada: ${priv}  (guárdala con copia de seguridad; no la subas nunca)`);
console.log(`Clave pública (va en el panel):\n${pub}`);
