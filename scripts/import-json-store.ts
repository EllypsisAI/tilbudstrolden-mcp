/**
 * One-off importer: migrate a legacy `~/.tilbudstrolden.json` data file into
 * the Postgres-backed store as a single household row + log entries.
 *
 * Usage:
 *   npm run db:import-json                         # imports ~/.tilbudstrolden.json
 *   npm run db:import-json -- --file ./backup.json # imports an arbitrary file
 *   npm run db:import-json -- --household <uuid>   # target a specific household id
 *
 * Behavior:
 *   - If no --household is passed, uses TILBUDSTROLDEN_HOUSEHOLD_ID from env,
 *     or generates a new uuid and prints it.
 *   - Refuses to overwrite an existing non-empty household unless --force.
 *   - Mealhistory and spendlog rows are inserted in bulk; the row counts are
 *     reported on completion.
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { closePool } from "../src/db/client.js";
import { loadEnv } from "../src/db/env.js";
import {
  households as householdsTable,
  mealLogEntries as mealLogTable,
  spendLogEntries as spendLogTable,
} from "../src/db/schema.js";
import { withTenant } from "../src/db/with-tenant.js";
import { LegacyDataStoreSchema } from "../src/store-types.js";

interface CliArgs {
  file: string;
  householdId: string | undefined;
  force: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    file: process.env.TILBUDSTROLDEN_DATA ?? path.join(os.homedir(), ".tilbudstrolden.json"),
    householdId: process.env.TILBUDSTROLDEN_HOUSEHOLD_ID,
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file" && i + 1 < argv.length) {
      args.file = argv[++i];
    } else if (a === "--household" && i + 1 < argv.length) {
      args.householdId = argv[++i];
    } else if (a === "--force") {
      args.force = true;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: npm run db:import-json -- [--file PATH] [--household UUID] [--force]",
      );
      process.exit(0);
    }
  }
  return args;
}

async function main() {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const householdId = args.householdId ?? randomUUID();

  console.log(`Reading ${args.file}...`);
  const raw = await readFile(args.file, "utf8");
  const parsed = LegacyDataStoreSchema.parse(JSON.parse(raw));

  console.log(`Target household: ${householdId}`);

  await withTenant(householdId, async (db) => {
    const existing = await db
      .select()
      .from(householdsTable)
      .where(eq(householdsTable.id, householdId))
      .limit(1);

    const hasData =
      existing[0] &&
      (existing[0].pantry.length > 0 ||
        existing[0].recipes.length > 0 ||
        existing[0].household.people.length > 0);
    if (hasData && !args.force) {
      throw new Error(
        `Household ${householdId} already has data. Re-run with --force to overwrite, ` +
          "or pick a different --household id.",
      );
    }

    if (existing[0]) {
      await db
        .update(householdsTable)
        .set({
          household: parsed.household,
          pantry: parsed.pantry,
          recipes: parsed.recipes,
        })
        .where(eq(householdsTable.id, householdId));
    } else {
      await db.insert(householdsTable).values({
        id: householdId,
        household: parsed.household,
        pantry: parsed.pantry,
        recipes: parsed.recipes,
      });
    }

    if (args.force) {
      await db.delete(mealLogTable).where(eq(mealLogTable.householdId, householdId));
      await db.delete(spendLogTable).where(eq(spendLogTable.householdId, householdId));
    }

    if (parsed.mealHistory.length > 0) {
      await db
        .insert(mealLogTable)
        .values(
          parsed.mealHistory.map((m) => ({
            householdId,
            date: m.date,
            recipe: m.recipe,
            people: m.people,
          })),
        )
        .onConflictDoNothing();
    }

    if (parsed.spendLog.length > 0) {
      await db.insert(spendLogTable).values(
        parsed.spendLog.map((s) => ({
          householdId,
          date: s.date,
          store: s.store,
          estimatedTotal: sql`${s.estimatedTotal}::numeric`,
          items: s.items,
          notes: s.notes,
        })),
      );
    }

    console.log("Imported:");
    console.log(`  household country: ${parsed.household.country}`);
    console.log(`  people: ${parsed.household.people.length}`);
    console.log(`  stores: ${parsed.household.stores.length}`);
    console.log(`  pantry items: ${parsed.pantry.length}`);
    console.log(`  recipes: ${parsed.recipes.length}`);
    console.log(`  meal history: ${parsed.mealHistory.length}`);
    console.log(`  spend log: ${parsed.spendLog.length}`);
    console.log("");
    console.log(`Set TILBUDSTROLDEN_HOUSEHOLD_ID=${householdId} in .env.local`);
    console.log("(or pass --household <uuid> on subsequent imports).");
  });
}

main()
  .catch((err) => {
    console.error("Import failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(closePool);
