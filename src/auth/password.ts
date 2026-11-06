import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";

// Password hashing with Node's built-in scrypt (no dependency).
// Stored as: scrypt$N$r$p$<salt base64url>$<hash base64url>, so parameters can
// be raised later without breaking existing hashes.

const N = 32768;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
const MAXMEM = 64 * 1024 * 1024;

function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LENGTH, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

const STORED = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const match = STORED.exec(stored);
  if (!match) return false;
  const [n, r, p] = [Number(match[1]), Number(match[2]), Number(match[3])];
  // Refuse silly parameters rather than let a tampered hash burn CPU or memory.
  if (n < 16384 || n > 1_048_576 || r < 1 || r > 32 || p < 1 || p > 16) return false;
  const salt = Buffer.from(match[4] ?? "", "base64url");
  const expected = Buffer.from(match[5] ?? "", "base64url");
  if (salt.length < 16 || expected.length !== KEY_LENGTH) return false;
  try {
    const actual = await scrypt(password, salt, expected.length, { N: n, r, p, maxmem: MAXMEM });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function passwordProblem(password: string): string | null {
  if (password.length < 12) return "Use at least 12 characters.";
  if (password.length > 128) return "Use at most 128 characters.";
  return null;
}
