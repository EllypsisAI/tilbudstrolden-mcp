/**
 * Test scaffolding for live-database tests.
 *
 * `createTestHousehold()` provisions a fresh household row (with its own
 * uuid) and returns helpers bound to it: a `tenant(fn)` runner that scopes
 * the callback to that household, and a `cleanup()` that drops the row.
 *
 * Tests that need a known tenant context can swap `TILBUDSTROLDEN_HOUSEHOLD_ID`
 * via `withEnvHousehold()` before exercising the public `store.ts` API,
 * which reads the env var ambiently.
 *
 * Migrations are applied once per process via `ensureMigrated()` — vitest's
 * setupFiles hook calls it before any test runs.
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Household } from "../store-types.js";
import { DEFAULT_HOUSEHOLD } from "../store-types.js";
import type { Db } from "./client.js";
import { closePool } from "./client.js";
import { loadEnv } from "./env.js";
import { migrate } from "./migrate.js";
import { households } from "./schema.js";
import { withoutTenant, withTenant } from "./with-tenant.js";

let migrated = false;

export async function ensureMigrated(): Promise<void> {
  if (migrated) return;
  loadEnv();
  await migrate();
  migrated = true;
}

export interface TestHousehold {
  id: string;
  /** Run a callback inside this household's tenant scope. */
  tenant: <T>(fn: (db: Db) => Promise<T>) => Promise<T>;
  /** Delete the household row + its log entries (cascade). */
  cleanup: () => Promise<void>;
}

export async function createTestHousehold(init: Partial<Household> = {}): Promise<TestHousehold> {
  await ensureMigrated();
  const id = randomUUID();
  const profile: Household = { ...DEFAULT_HOUSEHOLD, ...init };
  await withTenant(id, async (db) => {
    await db.insert(households).values({
      id,
      household: profile,
      pantry: [],
      recipes: [],
    });
  });
  return {
    id,
    tenant: (fn) => withTenant(id, fn),
    cleanup: async () => {
      // Deleting needs to happen as the tenant (RLS gates DELETE).
      await withTenant(id, async (db) => {
        await db.delete(households).where(eq(households.id, id));
      });
    },
  };
}

/**
 * Set `TILBUDSTROLDEN_HOUSEHOLD_ID` to the given uuid for the duration of
 * the callback. Restores the previous value afterwards.
 */
export async function withEnvHousehold<T>(householdId: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.TILBUDSTROLDEN_HOUSEHOLD_ID;
  process.env.TILBUDSTROLDEN_HOUSEHOLD_ID = householdId;
  try {
    return await fn();
  } finally {
    if (prev === undefined) {
      delete process.env.TILBUDSTROLDEN_HOUSEHOLD_ID;
    } else {
      process.env.TILBUDSTROLDEN_HOUSEHOLD_ID = prev;
    }
  }
}

/** Best-effort connectivity check — used to provide nicer failure messages. */
export async function canConnect(): Promise<boolean> {
  loadEnv();
  if (!process.env.DATABASE_URL) return false;
  try {
    await withoutTenant(async (client) => {
      await client.query("SELECT 1");
    });
    return true;
  } catch {
    return false;
  }
}

export { closePool };
