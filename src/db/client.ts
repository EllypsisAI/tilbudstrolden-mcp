/**
 * Postgres connection pool and Drizzle client.
 *
 * One pool per process. Connections are obtained via `getPool()`, and queries
 * inside a tenant scope go through `withTenant()` (which checks out a
 * connection, sets `app.household_id`, and runs your callback in a
 * transaction). Direct pool use outside `withTenant()` is reserved for
 * migrations and administrative scripts.
 */

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { loadEnv } from "./env.js";
import * as schema from "./schema.js";

const { Pool } = pg;

// Pull DATABASE_URL (and friends) from .env.local before anything else
// reads them. Safe to call repeatedly — guarded internally.
loadEnv();

let pool: pg.Pool | null = null;

function readDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url || url.length === 0) {
    throw new Error(
      "DATABASE_URL is not set. Run `npm run db:up` to bootstrap a local Postgres, " +
        "or copy .env.example to .env.local and fill in your connection string.",
    );
  }
  return url;
}

export function getPool(): pg.Pool {
  if (pool) return pool;
  const connectionString = readDatabaseUrl();
  pool = new Pool({
    connectionString,
    // Sensible defaults — the actual sizing decision belongs in station 4
    // (deploy + compute provider), where we know the concurrency model.
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  return pool;
}

/**
 * Build a Drizzle client bound to a specific pool client. Used by
 * `withTenant()` so every statement in a tenant transaction runs on the
 * same connection that set `app.household_id`.
 */
export function drizzleOn(client: pg.PoolClient): NodePgDatabase<typeof schema> {
  return drizzle(client, { schema });
}

/** Close the pool. Useful at process shutdown or end of a test run. */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export { schema };
export type Db = NodePgDatabase<typeof schema>;
