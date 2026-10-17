import { createHash, timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler } from "express";
import type { Pool } from "pg";
import { API_KEY_PATTERN, hashApiKey } from "../../domain/apiKeys.js";
import { AppError } from "../../domain/errors.js";
import { findAccountIdByKeyHash } from "../../repositories/apiKeys.js";
import type { ApiKeyCache } from "../apiKeyCache.js";

declare global {
  namespace Express {
    interface Request {
      /** Set only by requireApiKey. The one source of the tenant id: never the URL or body. */
      accountId?: string;
    }
  }
}

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Guards operator routes. Both sides are hashed first so timingSafeEqual always compares
 * equal-length buffers and the comparison time reveals nothing, not even the key length.
 */
export function requireAdminKey(adminApiKey: string): RequestHandler {
  const expected = createHash("sha256").update(adminApiKey).digest();
  return (req, _res, next) => {
    const provided = header(req, "x-admin-key");
    if (!provided) {
      throw new AppError(401, "MISSING_ADMIN_KEY", "Missing admin key", "Send the X-Admin-Key header");
    }
    const actual = createHash("sha256").update(provided).digest();
    if (!timingSafeEqual(actual, expected)) {
      throw new AppError(401, "INVALID_ADMIN_KEY", "Invalid admin key");
    }
    next();
  };
}

/**
 * Resolves X-API-Key to req.accountId, from the cache when it has the key (§7). Unknown and
 * revoked keys get the same answer.
 */
export function requireApiKey(pool: Pool, cache: ApiKeyCache): RequestHandler {
  return async (req, _res, next) => {
    const key = header(req, "x-api-key");
    if (!key) {
      throw new AppError(401, "MISSING_API_KEY", "Missing API key", "Send the X-API-Key header");
    }
    const accountId = API_KEY_PATTERN.test(key) ? await resolveKey(hashApiKey(key), pool, cache) : undefined;
    if (!accountId) {
      throw new AppError(401, "INVALID_API_KEY", "Invalid API key");
    }
    req.accountId = accountId;
    next();
  };
}

async function resolveKey(hash: Buffer, pool: Pool, cache: ApiKeyCache): Promise<string | undefined> {
  const cached = cache.get(hash);
  if (cached) return cached;
  const accountId = await findAccountIdByKeyHash(hash, pool);
  if (accountId) cache.set(hash, accountId);
  return accountId;
}

/** For handlers mounted behind requireApiKey. Missing means the router is wired wrong. */
export function authenticatedAccountId(req: Request): string {
  if (!req.accountId) throw new Error("authenticatedAccountId used on a route without requireApiKey");
  return req.accountId;
}
