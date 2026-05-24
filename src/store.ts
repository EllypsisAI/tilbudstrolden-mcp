/**
 * Per-household state, backed by Postgres.
 *
 * Public surface unchanged from the JSON-file era: the 18 MCP tools in
 * `server.ts` call the same exported functions with the same signatures.
 * Internally each call is a `withTenant(householdId, ...)` round-trip that
 * runs inside an RLS-protected transaction.
 *
 * The household id comes from the ambient environment (`ambientHouseholdId`)
 * until station 3 wires real auth. The atomicity guarantee that used to
 * come from a process-local file mutex now comes from a per-transaction
 * read-modify-write inside a single pooled connection.
 *
 * The `~/.tilbudstrolden.json` file is no longer touched at runtime —
 * `scripts/import-json-store.ts` migrates legacy files into the DB once.
 */

import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { loadEnv } from "./db/env.js";
import { households, mealLogEntries, spendLogEntries } from "./db/schema.js";
import { ambientHouseholdId, withTenant } from "./db/with-tenant.js";
import type {
  DataStore,
  Household,
  Ingredient,
  MealLogEntry,
  Person,
  Recipe,
  SpendLogEntry,
  StorePreference,
} from "./store-types.js";
import { DEFAULT_HOUSEHOLD } from "./store-types.js";

// Load env vars from .env.local before anything reads them.
loadEnv();

export type {
  DataStore,
  Household,
  Ingredient,
  MealLogEntry,
  Person,
  Recipe,
  SpendLogEntry,
  StorePreference,
};

// ---------------------------------------------------------------------------
// Internal helpers — load and update the single household row.
// ---------------------------------------------------------------------------

async function fetchHouseholdRow(db: Db, householdId: string) {
  const rows = await db.select().from(households).where(eq(households.id, householdId)).limit(1);
  return rows[0];
}

/** Read the full per-household snapshot — equivalent to the old `load()`. */
async function loadInternal(db: Db, householdId: string): Promise<DataStore> {
  const row = await fetchHouseholdRow(db, householdId);
  if (!row) {
    return {
      household: { ...DEFAULT_HOUSEHOLD },
      pantry: [],
      recipes: [],
      mealHistory: [],
      spendLog: [],
    };
  }
  const meals = await db
    .select()
    .from(mealLogEntries)
    .where(eq(mealLogEntries.householdId, householdId))
    .orderBy(desc(mealLogEntries.date));
  const spend = await db
    .select()
    .from(spendLogEntries)
    .where(eq(spendLogEntries.householdId, householdId))
    .orderBy(desc(spendLogEntries.date));
  return {
    household: row.household,
    pantry: row.pantry,
    recipes: row.recipes,
    mealHistory: meals.map((m) => ({
      date: m.date,
      recipe: m.recipe,
      people: m.people,
    })),
    spendLog: spend.map((s) => ({
      date: s.date,
      store: s.store,
      estimatedTotal: Number(s.estimatedTotal),
      items: s.items,
      notes: s.notes,
    })),
  };
}

// ---------------------------------------------------------------------------
// Household
// ---------------------------------------------------------------------------

export async function getHousehold(): Promise<Household> {
  const householdId = ambientHouseholdId();
  return withTenant(householdId, async (db) => {
    const row = await fetchHouseholdRow(db, householdId);
    return row?.household ?? { ...DEFAULT_HOUSEHOLD };
  });
}

export async function updateHousehold(updates: Partial<Household>): Promise<Household> {
  const householdId = ambientHouseholdId();
  return withTenant(householdId, async (db) => {
    const row = await fetchHouseholdRow(db, householdId);
    const current = row?.household ?? { ...DEFAULT_HOUSEHOLD };
    const merged: Household = { ...current, ...updates };
    if (row) {
      await db.update(households).set({ household: merged }).where(eq(households.id, householdId));
    } else {
      await db.insert(households).values({
        id: householdId,
        household: merged,
        pantry: [],
        recipes: [],
      });
    }
    return merged;
  });
}

// ---------------------------------------------------------------------------
// Pantry
// ---------------------------------------------------------------------------

export async function getPantry(): Promise<string[]> {
  const householdId = ambientHouseholdId();
  return withTenant(householdId, async (db) => {
    const row = await fetchHouseholdRow(db, householdId);
    return row?.pantry ?? [];
  });
}

export async function updatePantry(add: string[], remove: string[]): Promise<string[]> {
  const householdId = ambientHouseholdId();
  return withTenant(householdId, async (db) => {
    const row = await fetchHouseholdRow(db, householdId);
    const current = row?.pantry ?? [];
    const removeSet = new Set(remove.map((r) => r.toLowerCase()));
    const filtered = current.filter((item) => !removeSet.has(item.toLowerCase()));
    for (const item of add) {
      if (!filtered.some((p) => p.toLowerCase() === item.toLowerCase())) {
        filtered.push(item);
      }
    }
    filtered.sort();
    if (row) {
      await db.update(households).set({ pantry: filtered }).where(eq(households.id, householdId));
    } else {
      await db.insert(households).values({
        id: householdId,
        household: { ...DEFAULT_HOUSEHOLD },
        pantry: filtered,
        recipes: [],
      });
    }
    return filtered;
  });
}

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------

export async function getRecipes(): Promise<Recipe[]> {
  const householdId = ambientHouseholdId();
  return withTenant(householdId, async (db) => {
    const row = await fetchHouseholdRow(db, householdId);
    return row?.recipes ?? [];
  });
}

export async function addRecipe(recipe: Recipe): Promise<void> {
  const householdId = ambientHouseholdId();
  await withTenant(householdId, async (db) => {
    const row = await fetchHouseholdRow(db, householdId);
    const current = row?.recipes ?? [];
    const idx = current.findIndex((r) => r.name.toLowerCase() === recipe.name.toLowerCase());
    const next = [...current];
    if (idx >= 0) next[idx] = recipe;
    else next.push(recipe);
    if (row) {
      await db.update(households).set({ recipes: next }).where(eq(households.id, householdId));
    } else {
      await db.insert(households).values({
        id: householdId,
        household: { ...DEFAULT_HOUSEHOLD },
        pantry: [],
        recipes: next,
      });
    }
  });
}

export async function removeRecipe(name: string): Promise<boolean> {
  const householdId = ambientHouseholdId();
  return withTenant(householdId, async (db) => {
    const row = await fetchHouseholdRow(db, householdId);
    if (!row) return false;
    const idx = row.recipes.findIndex((r) => r.name.toLowerCase() === name.toLowerCase());
    if (idx < 0) return false;
    const next = [...row.recipes];
    next.splice(idx, 1);
    await db.update(households).set({ recipes: next }).where(eq(households.id, householdId));
    return true;
  });
}

// ---------------------------------------------------------------------------
// Meal history
// ---------------------------------------------------------------------------

function cutoffDate(weeks: number): string {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - weeks * 7);
  return cutoff.toISOString().slice(0, 10);
}

export async function getMealHistory(weeks = 4): Promise<MealLogEntry[]> {
  const householdId = ambientHouseholdId();
  const cutoff = cutoffDate(weeks);
  return withTenant(householdId, async (db) => {
    const rows = await db
      .select()
      .from(mealLogEntries)
      .where(and(eq(mealLogEntries.householdId, householdId), gte(mealLogEntries.date, cutoff)))
      .orderBy(desc(mealLogEntries.date));
    return rows.map((m) => ({
      date: m.date,
      recipe: m.recipe,
      people: m.people,
    }));
  });
}

export async function logMeal(entry: MealLogEntry): Promise<void> {
  const householdId = ambientHouseholdId();
  await withTenant(householdId, async (db) => {
    // Upsert on (household_id, date, recipe) — matches the legacy file
    // behaviour where logging the same meal on the same day overwrote the
    // people list. Unique index `meal_log_dedup_idx` makes this safe.
    await db
      .insert(mealLogEntries)
      .values({
        householdId,
        date: entry.date,
        recipe: entry.recipe,
        people: entry.people,
      })
      .onConflictDoUpdate({
        target: [mealLogEntries.householdId, mealLogEntries.date, mealLogEntries.recipe],
        set: { people: entry.people },
      });
  });
}

// ---------------------------------------------------------------------------
// Spend log
// ---------------------------------------------------------------------------

export async function getSpendLog(weeks = 8): Promise<SpendLogEntry[]> {
  const householdId = ambientHouseholdId();
  const cutoff = cutoffDate(weeks);
  return withTenant(householdId, async (db) => {
    const rows = await db
      .select()
      .from(spendLogEntries)
      .where(and(eq(spendLogEntries.householdId, householdId), gte(spendLogEntries.date, cutoff)))
      .orderBy(desc(spendLogEntries.date));
    return rows.map((s) => ({
      date: s.date,
      store: s.store,
      estimatedTotal: Number(s.estimatedTotal),
      items: s.items,
      notes: s.notes,
    }));
  });
}

export async function logSpend(entry: SpendLogEntry): Promise<void> {
  const householdId = ambientHouseholdId();
  await withTenant(householdId, async (db) => {
    await db.insert(spendLogEntries).values({
      householdId,
      date: entry.date,
      store: entry.store,
      estimatedTotal: sql`${entry.estimatedTotal}::numeric`,
      items: entry.items,
      notes: entry.notes,
    });
  });
}

// ---------------------------------------------------------------------------
// Internal snapshot helper, kept for the import script and tests.
// Not exported — server.ts never used `load`/`save`/`modify` directly.
// ---------------------------------------------------------------------------

export async function _loadSnapshot(): Promise<DataStore> {
  const householdId = ambientHouseholdId();
  return withTenant(householdId, (db) => loadInternal(db, householdId));
}
