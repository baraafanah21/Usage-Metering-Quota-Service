/**
 * API key → account id, in process (DESIGN.md §7). Saves the key lookup query on every
 * request after the first. Bounded in age (ttlMs) and in size (least recently used entries
 * go first). Only found keys are cached, so random keys can't fill it.
 *
 * Staleness: a key revoked in the database keeps working on an instance that has it cached
 * until its entry expires, at most ttlMs later (§17). ttlMs = 0 turns the cache off.
 */
export interface ApiKeyCache {
  get(keyHash: Buffer): string | undefined;
  set(keyHash: Buffer, accountId: string): void;
}

export function createApiKeyCache(ttlMs: number, maxEntries = 10_000, now: () => number = Date.now): ApiKeyCache {
  // A Map iterates in insertion order: deleting and re-inserting on every hit keeps the least
  // recently used entry first, where eviction takes it from.
  const entries = new Map<string, { accountId: string; expiresAt: number }>();
  return {
    get(keyHash) {
      if (ttlMs === 0) return undefined;
      const id = keyHash.toString("base64");
      const entry = entries.get(id);
      if (!entry) return undefined;
      entries.delete(id);
      if (entry.expiresAt <= now()) return undefined;
      entries.set(id, entry);
      return entry.accountId;
    },
    set(keyHash, accountId) {
      if (ttlMs === 0) return;
      const id = keyHash.toString("base64");
      entries.delete(id);
      entries.set(id, { accountId, expiresAt: now() + ttlMs });
      if (entries.size > maxEntries) entries.delete(entries.keys().next().value!);
    },
  };
}
