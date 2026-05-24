/**
 * Identity → tenant resolver.
 *
 * Takes the claims a validated WorkOS access token carries and returns
 * the `household_id` the rest of the request should run as.
 *
 * Two paths:
 *   - Returning user: `users.workos_sub` already mapped to a household;
 *     just look it up.
 *   - First-time login: create a fresh `households` row (seeded with
 *     defaults per `seedHousehold`) and a `users` row linking the WorkOS
 *     subject to it. Both inserts run in one transaction so a unique-
 *     violation race aborts cleanly: at most one household is born per
 *     subject, and the loser of the race retries via lookup.
 *
 * Why the transaction matters:
 *   Two concurrent first-login requests for the same brand-new `sub`
 *   would otherwise both create households. The `users.workos_sub` unique
 *   constraint is the single source of truth — one INSERT wins; the
 *   other's transaction rolls back, taking the orphan household with it.
 *
 * The resolver does NOT enter `withTenant()` itself; the caller (HTTP
 * middleware) calls `runWithHousehold(householdId, () => tools...)`
 * after this returns.
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { PoolClient } from "pg";
import { drizzleOn, getPool } from "../db/client.js";
import { users } from "../db/schema.js";
import { seedHousehold } from "../db/seed-household.js";
import type { WorkOSClaims } from "./workos.js";

export interface ResolvedTenant {
  userId: string;
  householdId: string;
  /**
   * True if this resolver call created the household (first login).
   * Useful for journaling and for an eventual onboarding-tool branch.
   */
  created: boolean;
}

export interface ResolveOptions {
  /**
   * Country to use when seeding a brand-new household. Driven by the
   * MCP client's `accept-language` or a query param at the HTTP layer;
   * defaults to DK to keep parity with the bootstrap script.
   */
  defaultCountry?: string;
}

/**
 * Look up (or create) the household associated with a WorkOS subject.
 *
 * Idempotent across calls; race-safe across concurrent first-logins.
 */
export async function resolveHouseholdForClaims(
  claims: WorkOSClaims,
  opts: ResolveOptions = {},
): Promise<ResolvedTenant> {
  const pool = getPool();
  const existing = await pool.connect();
  let firstLookup: ExistingUser | null;
  try {
    firstLookup = await findUserBySub(existing, claims.workosSub);
  } finally {
    existing.release();
  }
  if (firstLookup) {
    return { userId: firstLookup.id, householdId: firstLookup.householdId, created: false };
  }

  // First-login path: pre-mint a household id, run the household + user
  // inserts in one transaction. If the user-insert races and loses, the
  // transaction rolls back (household goes with it) and we fall through
  // to a fresh lookup.
  const newHouseholdId = randomUUID();
  const country = opts.defaultCountry ?? "DK";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // RLS on `households` needs app.household_id set for the INSERT's
    // WITH CHECK clause to allow the row. Scope it transaction-locally;
    // it reverts at COMMIT/ROLLBACK.
    await client.query("SELECT set_config('app.household_id', $1, true)", [newHouseholdId]);
    await seedHousehold(drizzleOn(client), { id: newHouseholdId, country });

    const inserted = await client.query<{
      id: string;
      household_id: string;
    }>(
      `INSERT INTO users (workos_sub, household_id, email, provider)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (workos_sub) DO NOTHING
       RETURNING id, household_id`,
      [claims.workosSub, newHouseholdId, claims.email ?? null, claims.provider ?? null],
    );

    if (inserted.rows.length > 0) {
      await client.query("COMMIT");
      return {
        userId: inserted.rows[0].id,
        householdId: inserted.rows[0].household_id,
        created: true,
      };
    }

    // ON CONFLICT fired — another request won the race. Roll back our
    // half-built household and re-fetch the winner.
    await client.query("ROLLBACK");
    const winner = await findUserBySub(client, claims.workosSub);
    if (!winner) {
      // The unique-violation winner must exist by now; if it doesn't,
      // something is deeply wrong (DB rollback failed?). Surface loudly.
      throw new Error(
        `users.workos_sub conflict on ${claims.workosSub} but no row visible after rollback`,
      );
    }
    return { userId: winner.id, householdId: winner.householdId, created: false };
  } catch (err) {
    // Best-effort rollback. If the transaction is already aborted by the
    // driver, ROLLBACK is a no-op.
    try {
      await client.query("ROLLBACK");
    } catch {
      // swallow — connection state already handled by driver
    }
    throw err;
  } finally {
    client.release();
  }
}

interface ExistingUser {
  id: string;
  householdId: string;
}

/**
 * Look up a user by WorkOS subject. Uses raw SQL on a passed-in client so
 * the caller can run it inside or outside a transaction without re-acquiring.
 * The `users` table is not RLS-protected, so no session var is needed.
 */
async function findUserBySub(client: PoolClient, workosSub: string): Promise<ExistingUser | null> {
  // Two equivalent ways to express this: raw SQL or drizzle. Drizzle gives
  // type safety on the column names and matches the rest of the codebase.
  const db = drizzleOn(client);
  const rows = await db
    .select({ id: users.id, householdId: users.householdId })
    .from(users)
    .where(eq(users.workosSub, workosSub))
    .limit(1);
  return rows[0] ?? null;
}
