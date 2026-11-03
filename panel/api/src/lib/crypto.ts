import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../config.ts';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, saltB64, keyB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length, SCRYPT);
  return timingSafeEqual(key, expected);
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** Password with letters and digits only, safe for shells, SQL and config files. */
export function randomPassword(length = 20) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(length);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export const hmac = (value: string, key = config.secret) => createHmac('sha256', key).update(value).digest('hex');

export function safeEqual(a: string, b: string) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// --- symmetric encryption for secrets the panel must read back (DB passwords) --------

const encKey = () => createHash('sha256').update(`hostpanel-enc:${config.secret}`).digest();

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encKey(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

export function decrypt(value: string): string {
  const [v, iv, tag, data] = value.split(':');
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('Valor cifrado no válido');
  const decipher = createDecipheriv('aes-256-gcm', encKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

// --- TOTP (RFC 6238) for two-factor login ---------------------------------------------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf: Buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text: string) {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text.replace(/=+$/, '').toUpperCase()) {
    const idx = B32.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function hotp(secret: Buffer, counter: number) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secret).update(msg).digest();
  const offset = h[h.length - 1]! & 15;
  return String((h.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

export const newTotpSecret = () => base32Encode(randomBytes(20));

export function totpCode(secret: string, now = Date.now()) {
  return hotp(base32Decode(secret), Math.floor(now / 30_000));
}

/**
 * Accepts the current code and one step before/after (clock drift). Returns the matched time
 * step (so the caller can refuse a code that was already used) or -1.
 */
export function totpStep(secret: string, code: string, now = Date.now()): number {
  const clean = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return -1;
  const key = base32Decode(secret);
  const step = Math.floor(now / 30_000);
  for (const d of [-1, 0, 1]) if (safeEqual(hotp(key, step + d), clean)) return step + d;
  return -1;
}

export const verifyTotp = (secret: string, code: string, now = Date.now()) => totpStep(secret, code, now) !== -1;

/**
 * otpauth:// link understood by every authenticator: Apple Passwords (iPhone, iPad, Mac),
 * Microsoft Authenticator, Google Authenticator, 1Password, Bitwarden, Authy…
 * SHA-1, 6 digits and 30 s are the only parameters all of them support.
 */
export function totpUri(secret: string, account: string, issuer = 'HostPanel') {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// --- 2FA recovery codes -------------------------------------------------------------------
const RC_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** Ten single-use codes like "k7mq-2xpa-9rtd" (~70 bits each). Only their hashes are stored. */
export function newRecoveryCodes(count = 10) {
  return Array.from({ length: count }, () => {
    const bytes = randomBytes(12);
    const chars = Array.from(bytes, (b) => RC_ALPHABET[b % RC_ALPHABET.length]).join('');
    return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
  });
}

/** Lower case, no spaces or dashes: users type codes in many ways. */
export const normalizeRecoveryCode = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, '');
export const hashRecoveryCode = (code: string) => sha256(`hp-recovery:${normalizeRecoveryCode(code)}`);
