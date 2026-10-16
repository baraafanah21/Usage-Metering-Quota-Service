import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.js";
import { log } from "./log.js";
import { MeteringClient, MeteringError } from "./metering.js";
import { createAccount, setUpDemoAccount } from "./provision.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface DocuCorp {
  api: MeteringClient;
  accountId: string;
  demoTeamPlanId: string;
}

interface StoredKey {
  accountId: string;
  apiKey: string;
}

/** Polls /health/ready with exponential backoff (0.5 s doubling, capped at 5 s). */
export async function waitForApi(baseUrl: string, deadlineMs = 120_000): Promise<void> {
  const health = MeteringClient.anonymous(baseUrl);
  const giveUpAt = Date.now() + deadlineMs;
  for (let delay = 500; ; delay = Math.min(delay * 2, 5_000)) {
    try {
      await health.call("GET", "/health/ready");
      return;
    } catch (err) {
      if (Date.now() + delay > giveUpAt) throw new Error(`metering API not ready after ${deadlineMs / 1000}s`, { cause: err });
      log("info", "waiting for metering API", { error: (err as Error).message, retryInMs: delay });
      await sleep(delay);
    }
  }
}

async function readStoredKey(file: string): Promise<StoredKey | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as StoredKey;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** Write-then-rename, so a crash mid-write never leaves a half-written key file. */
async function storeKey(file: string, value: StoredKey): Promise<void> {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(tmp, file);
}

/**
 * Creates DocuCorp on first start and reuses it afterwards. Its API key is shown by the API
 * only once, so it is kept in DATA_DIR. If the stored key no longer works (the database was
 * reset but the demo volume kept), a new DocuCorp is created and the file replaced.
 */
async function loadOrCreateDocuCorp(config: Config): Promise<{ api: MeteringClient; accountId: string }> {
  await mkdir(config.DATA_DIR, { recursive: true });
  const file = join(config.DATA_DIR, "docucorp.json");

  const stored = await readStoredKey(file);
  if (stored) {
    const api = MeteringClient.account(config.METERING_API_URL, stored.apiKey);
    try {
      await api.call("GET", "/v1/account");
      log("info", "reusing DocuCorp", { accountId: stored.accountId });
      return { api, accountId: stored.accountId };
    } catch (err) {
      if (!(err instanceof MeteringError && err.code === "INVALID_API_KEY")) throw err;
      log("warn", "stored DocuCorp key is not valid any more; creating a new DocuCorp", { file });
    }
  }

  const admin = MeteringClient.admin(config.METERING_API_URL, config.ADMIN_API_KEY);
  const created = await createAccount(admin, "DocuCorp");
  await storeKey(file, created);
  log("info", "created DocuCorp", { accountId: created.accountId });
  return { api: MeteringClient.account(config.METERING_API_URL, created.apiKey), accountId: created.accountId };
}

const isTransient = (err: unknown) => !(err instanceof MeteringError) || err.status >= 500;

/**
 * Waits for the API, then sets up DocuCorp. Safe to run on every start. Transient failures
 * (API unreachable, 5xx) are retried; anything else (a wrong admin key, say) is a
 * configuration error and is thrown.
 */
export async function bootstrap(config: Config): Promise<DocuCorp> {
  for (let attempt = 1; ; attempt++) {
    try {
      await waitForApi(config.METERING_API_URL);
      const { api, accountId } = await loadOrCreateDocuCorp(config);
      const { demoTeamPlanId } = await setUpDemoAccount(api);
      return { api, accountId, demoTeamPlanId };
    } catch (err) {
      if (!isTransient(err) || attempt >= 5) throw err;
      log("warn", "bootstrap failed, retrying", { attempt, error: (err as Error).message });
      await sleep(2_000 * attempt);
    }
  }
}
