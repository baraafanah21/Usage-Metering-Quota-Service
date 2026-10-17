import { describe, expect, it } from "vitest";
import { createApiKeyCache } from "../../src/http/apiKeyCache.js";

const hash = (s: string) => Buffer.from(s);

describe("createApiKeyCache", () => {
  it("returns a cached account until the TTL has passed", () => {
    let now = 1_000;
    const cache = createApiKeyCache(30_000, 10, () => now);
    cache.set(hash("k"), "acct");

    now += 29_999;
    expect(cache.get(hash("k"))).toBe("acct");
    now += 1;
    expect(cache.get(hash("k"))).toBeUndefined();
  });

  it("caches nothing when the TTL is 0", () => {
    const cache = createApiKeyCache(0);
    cache.set(hash("k"), "acct");
    expect(cache.get(hash("k"))).toBeUndefined();
  });

  it("evicts the least recently used entry when full", () => {
    const cache = createApiKeyCache(30_000, 2);
    cache.set(hash("a"), "A");
    cache.set(hash("b"), "B");
    cache.get(hash("a")); // a is now more recent than b
    cache.set(hash("c"), "C");

    expect(cache.get(hash("a"))).toBe("A");
    expect(cache.get(hash("b"))).toBeUndefined();
    expect(cache.get(hash("c"))).toBe("C");
  });
});
