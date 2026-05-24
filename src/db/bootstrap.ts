/**
 * Idempotent dev/launch bootstrap: ensure a household row exists for the
 * configured `TILBUDSTROLDEN_HOUSEHOLD_ID`. If the id isn't set, generate
 * one and append it to `.env.local`. If it is set but the row doesn't
 * exist, create a row with default values (and seed Danish default recipes
 * when country is DK, matching legacy v0.4 behaviour).
 *
 * Run after `db:migrate`. Safe to run repeatedly.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closePool } from "./client.js";
import { loadEnv } from "./env.js";
import { seedHousehold } from "./seed-household.js";
import { withoutTenant, withTenant } from "./with-tenant.js";

const ENV_FILE = ".env.local";
const ENV_KEY = "TILBUDSTROLDEN_HOUSEHOLD_ID";

function readExistingEnv(): string | undefined {
  const path = resolve(process.cwd(), ENV_FILE);
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (!m) continue;
    if (m[1] === ENV_KEY) {
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      return v;
    }
  }
  return undefined;
}

function appendToEnv(key: string, value: string): void {
  const path = resolve(process.cwd(), ENV_FILE);
  const prefix = existsSync(path) ? "" : "";
  appendFileSync(path, `${prefix}${key}=${value}\n`, "utf8");
}

async function householdExists(householdId: string): Promise<boolean> {
  return withoutTenant(async (client) => {
    // RLS blocks SELECT without the session var; we can either set the var
    // or query via service-level access. Easiest: set the var locally to
    // the candidate id and run a SELECT — if RLS lets it through, it
    // exists. This needs to be wrapped in a transaction since we use
    // SET LOCAL.
    await client.query("BEGIN");
    try {
      await client.query("SELECT set_config('app.household_id', $1, true)", [householdId]);
      const result = await client.query<{ id: string }>("SELECT id FROM households WHERE id = $1", [
        householdId,
      ]);
      return result.rowCount !== null && result.rowCount > 0;
    } finally {
      await client.query("ROLLBACK");
    }
  });
}

async function createHousehold(householdId: string, country: string): Promise<void> {
  await withTenant(householdId, async (db) => {
    await seedHousehold(db, { id: householdId, country });
  });
}

export async function bootstrap(country = "DK"): Promise<{
  householdId: string;
  created: boolean;
  generated: boolean;
}> {
  loadEnv();
  let householdId = process.env[ENV_KEY] ?? readExistingEnv();
  let generated = false;
  if (!householdId) {
    householdId = randomUUID();
    appendToEnv(ENV_KEY, householdId);
    process.env[ENV_KEY] = householdId;
    generated = true;
  }

  const exists = await householdExists(householdId);
  if (exists) {
    return { householdId, created: false, generated };
  }
  await createHousehold(householdId, country);
  return { householdId, created: true, generated };
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  const country = process.env.TILBUDSTROLDEN_COUNTRY ?? "DK";
  bootstrap(country)
    .then(({ householdId, created, generated }) => {
      const parts: string[] = [];
      if (generated) parts.push(`generated ${ENV_KEY} → .env.local`);
      if (created) parts.push("created household row");
      else parts.push("household row already exists");
      console.log(`Bootstrap: ${parts.join("; ")}`);
      console.log(`Household: ${householdId}`);
    })
    .catch((err) => {
      console.error("Bootstrap failed:", err);
      process.exit(1);
    })
    .finally(closePool);
}
