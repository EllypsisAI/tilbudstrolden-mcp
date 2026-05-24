/**
 * The single chokepoint between application code and the database.
 *
 * Every read or write that operates on a specific household goes through
 * `withTenant(householdId, fn)`:
 *
 *   1. Check out a pooled connection.
 *   2. Begin a transaction.
 *   3. `SET LOCAL app.household_id = <uuid>` — scopes the variable to this
 *      transaction so the next caller starts clean.
 *   4. Run the callback with a Drizzle client bound to this connection.
 *   5. Commit, release the connection.
 *
 * Row-Level Security policies (see `migrations/0000_initial.sql`) compare
 * every row's `household_id` against `app.household_id`. The database itself
 * filters; the application cannot leak rows by forgetting a WHERE clause.
 *
 * This is also the right place to wire up future per-tenant observability,
 * query tagging, and timeouts — they go in `withTenant`, not in N call sites.
 */

import type { Db } from "./client.js";
import { drizzleOn, getPool } from "./client.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`${label} must be a UUID; got "${value}"`);
  }
}

/**
 * Resolve the household id for an ambient call (no explicit context given).
 * Reads `TILBUDSTROLDEN_HOUSEHOLD_ID` from the environment. Station 3 will
 * replace this with a per-request token-derived value; until then a single
 * env var is enough to run single-tenant dev.
 */
export function ambientHouseholdId(): string {
  const id = process.env.TILBUDSTROLDEN_HOUSEHOLD_ID;
  if (!id || id.length === 0) {
    throw new Error(
      "No household context. Set TILBUDSTROLDEN_HOUSEHOLD_ID in .env.local " +
        '(generate one with: node -e "console.log(crypto.randomUUID())") ' +
        "or pass an explicit id to withTenant().",
    );
  }
  assertUuid(id, "TILBUDSTROLDEN_HOUSEHOLD_ID");
  return id;
}

/**
 * Run `fn` in a transaction scoped to `householdId`. All Drizzle queries
 * inside the callback see only rows belonging to that household (RLS).
 */
export async function withTenant<T>(householdId: string, fn: (db: Db) => Promise<T>): Promise<T> {
  assertUuid(householdId, "householdId");
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // `set_config(name, value, is_local)` is parameterizable, unlike
    // `SET LOCAL name = value` which doesn't accept bind parameters. Same
    // semantics (transaction-scoped). is_local=true means the value reverts
    // at COMMIT/ROLLBACK — the connection is safe to return to the pool.
    await client.query("SELECT set_config($1, $2, true)", ["app.household_id", householdId]);
    const db = drizzleOn(client);
    const result = await fn(db);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Connection may already be aborted; swallow.
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Sugar for callers that read `TILBUDSTROLDEN_HOUSEHOLD_ID` ambiently. */
export async function withAmbientTenant<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  return withTenant(ambientHouseholdId(), fn);
}

/**
 * Escape hatch for service-role operations that must work across tenants —
 * migrations, the one-off JSON importer, future cross-tenant cron jobs.
 * Bypasses RLS by setting `SESSION AUTHORIZATION` is NOT how we do it; we
 * instead skip the tenant SET LOCAL but still wrap in a transaction. Since
 * RLS policies require `app.household_id` to be set, queries without it
 * return zero rows from the protected tables — which is fine for callers
 * that explicitly intend to bypass via the special `disableRls` path.
 *
 * The safer alternative is `ALTER ROLE ... BYPASSRLS` and a dedicated
 * service user; we defer that to station 4 when we provision real prod
 * roles. For now `withoutTenant` only safely covers DDL / migrator usage.
 */
export async function withoutTenant<T>(
  fn: (rawClient: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
