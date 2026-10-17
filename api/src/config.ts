import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.url({
    protocol: /^postgres(ql)?$/,
    error: "must be a postgres:// or postgresql:// URL",
  }),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  // Not used until Phase 2 (admin routes), but validated now so a bad deploy fails at boot.
  ADMIN_API_KEY: z.string().min(32, "must be at least 32 characters"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(20),
  // How long a resolved API key is trusted without asking the database (§7); 0 = no cache.
  API_KEY_CACHE_TTL_MS: z.coerce.number().int().min(0).max(300_000).default(30_000),
});

export type Config = z.infer<typeof envSchema>;

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Parses and validates the environment. Throws ConfigError listing every invalid variable. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new ConfigError(`Invalid environment configuration:\n${problems}`);
  }
  return result.data;
}
