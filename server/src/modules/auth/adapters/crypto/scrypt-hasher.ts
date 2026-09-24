import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { ScryptOptions } from "node:crypto";
import type { PasswordHasher } from "../../domain/ports/password-hasher.js";

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 16384, r: 8, p: 1 };

const SALT_BYTES = 16;
const KEY_BYTES = 64;

function derive(password: string, salt: Buffer, keylen: number, params: ScryptParams): Promise<Buffer> {
  const options: ScryptOptions = {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 256 * params.N * params.r + 1024 * 1024,
  };

  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

interface ParsedHash {
  params: ScryptParams;
  salt: Buffer;
  key: Buffer;
}

function parse(stored: string): ParsedHash | null {
  const [scheme, n, r, p, salt, key, ...rest] = stored.split("$");

  if (scheme !== "scrypt" || rest.length > 0 || !salt || !key) {
    return null;
  }

  const params = { N: Number(n), r: Number(r), p: Number(p) };

  if (!Object.values(params).every((value) => Number.isSafeInteger(value) && value > 0)) {
    return null;
  }

  const saltBytes = Buffer.from(salt, "base64");
  const keyBytes = Buffer.from(key, "base64");

  return saltBytes.length > 0 && keyBytes.length > 0
    ? { params, salt: saltBytes, key: keyBytes }
    : null;
}

export function createScryptHasher(params: ScryptParams = DEFAULT_SCRYPT_PARAMS): PasswordHasher {
  return {
    async hash(password) {
      const salt = randomBytes(SALT_BYTES);
      const key = await derive(password, salt, KEY_BYTES, params);

      return [
        "scrypt",
        params.N,
        params.r,
        params.p,
        salt.toString("base64"),
        key.toString("base64"),
      ].join("$");
    },

    async verify(password, stored) {
      const parsed = parse(stored);

      if (!parsed) {
        return false;
      }

      try {
        const candidate = await derive(password, parsed.salt, parsed.key.length, parsed.params);

        return timingSafeEqual(candidate, parsed.key);
      } catch {
        return false;
      }
    },
  };
}
