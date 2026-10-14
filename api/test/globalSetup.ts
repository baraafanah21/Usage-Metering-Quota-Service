import { pino } from "pino";
import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { seed } from "../src/db/seed.js";
import { TEST_DATABASE_URL } from "./testDatabase.js";

export default async function setup(): Promise<void> {
  const logger = pino({ level: "silent" });
  const pool = createPool({ connectionString: TEST_DATABASE_URL, max: 1 }, logger);
  try {
    await migrate(pool, logger, { attempts: 3, initialDelayMs: 200, maxDelayMs: 1_000 });
    await seed(pool, logger);
  } finally {
    await pool.end();
  }
}
