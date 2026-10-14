import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { API_KEY_PATTERN, generateApiKey, hashApiKey } from "../../src/domain/apiKeys.js";

describe("generateApiKey", () => {
  it("produces mk_ + 43 base62 characters", () => {
    for (let i = 0; i < 200; i++) {
      expect(generateApiKey().key).toMatch(API_KEY_PATTERN);
    }
  });

  it("never repeats", () => {
    const keys = new Set(Array.from({ length: 1_000 }, () => generateApiKey().key));
    expect(keys.size).toBe(1_000);
  });

  it("returns the sha256 of the key and a short display prefix", () => {
    const { key, hash, displayPrefix } = generateApiKey();
    expect(hash).toEqual(createHash("sha256").update(key).digest());
    expect(hash).toEqual(hashApiKey(key));
    expect(displayPrefix).toBe(key.slice(0, 7));
    expect(displayPrefix.startsWith("mk_")).toBe(true);
  });
});
