import { createHash, randomBytes } from "node:crypto";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const KEY_BYTES = 32;
// ceil(256 bits / log2(62)) = 43 characters; shorter encodings are left-padded so every key has one length.
const ENCODED_LENGTH = 43;
const PREFIX = "mk_";
const DISPLAY_PREFIX_LENGTH = PREFIX.length + 4; // "mk_7Fq2"

/** Shape check only, so obvious garbage is rejected without a database lookup. */
export const API_KEY_PATTERN = /^mk_[0-9A-Za-z]{43}$/;

export interface GeneratedApiKey {
  /** The secret. Shown to the caller exactly once, never stored or logged. */
  key: string;
  hash: Buffer;
  displayPrefix: string;
}

function base62(bytes: Buffer): string {
  let n = BigInt(`0x${bytes.toString("hex")}`);
  let out = "";
  while (n > 0n) {
    out = BASE62[Number(n % 62n)] + out;
    n /= 62n;
  }
  return out.padStart(ENCODED_LENGTH, "0");
}

/**
 * sha256 is enough: keys carry 256 bits of randomness, so brute force is infeasible and a
 * slow KDF would only add latency to every request (DESIGN.md §4.1).
 */
export function hashApiKey(key: string): Buffer {
  return createHash("sha256").update(key, "utf8").digest();
}

export function generateApiKey(): GeneratedApiKey {
  const key = PREFIX + base62(randomBytes(KEY_BYTES));
  return { key, hash: hashApiKey(key), displayPrefix: key.slice(0, DISPLAY_PREFIX_LENGTH) };
}
