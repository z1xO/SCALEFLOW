import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

export function sha256(input: string | Buffer): Buffer {
  return createHash('sha256').update(input).digest();
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** URL-safe random token with `bytes` bytes of entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/**
 * Password hashing with scrypt (memory-hard, built into Node - no native addon to build).
 * Format: `scrypt$<logN>$<r>$<p>$<salt b64>$<hash b64>`; parameters travel with the hash so the
 * cost can be raised later and old hashes still verify (and can be rehashed on login).
 */
export async function hashPassword(password: string, logN: number): Promise<string> {
  const r = 8;
  const p = 1;
  const salt = randomBytes(16);
  const N = 2 ** logN;
  const key = await scrypt(password, salt, 32, { N, r, p, maxmem: 256 * N * r });
  return ['scrypt', logN, r, p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, logNs, rs, ps, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const N = 2 ** Number(logNs);
  const r = Number(rs);
  const p = Number(ps);
  const expected = Buffer.from(hashB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N,
    r,
    p,
    maxmem: 256 * N * r,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export function passwordNeedsRehash(stored: string, logN: number): boolean {
  const parts = stored.split('$');
  return parts[0] !== 'scrypt' || Number(parts[1]) < logN;
}

/** Canonical JSON (sorted keys) so semantically equal requests produce the same fingerprint. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
