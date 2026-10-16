import { z } from "zod";

const envSchema = z.object({
  METERING_API_URL: z.url().default("http://localhost:3000"),
  // The demo also plays the operator, so it needs the admin key to create accounts.
  // A real client app would only ever hold its own account's API key.
  ADMIN_API_KEY: z.string().min(32, "must be at least 32 characters"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  // Where DocuCorp's API key is kept across restarts (a named volume in compose).
  DATA_DIR: z.string().min(1).default("/data"),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    console.error(`Invalid environment configuration:\n${problems}`);
    process.exit(1);
  }
  return result.data;
}
