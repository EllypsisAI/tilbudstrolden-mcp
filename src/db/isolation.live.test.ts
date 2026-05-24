/**
 * Belt-and-suspenders tenant isolation check.
 *
 * Two households operate side by side. Each writes data through the normal
 * store API. Then each reads — and must see only its own rows, even though
 * the underlying queries do not carry an explicit `WHERE household_id = ...`
 * clause. The RLS policies in `migrations/0000_initial.sql` are what enforces
 * this; the test fails loudly if those policies are removed, weakened, or
 * forgotten on a future table.
 *
 * The test also probes the raw connection — a `SELECT * FROM households`
 * without the session variable set must return zero rows. That confirms the
 * "no tenant context = no data" property the RLS predicate is supposed to
 * deliver.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as store from "../store.js";
import { closePool } from "./client.js";
import {
  canConnect,
  createTestHousehold,
  ensureMigrated,
  withEnvHousehold,
} from "./test-helpers.js";
import { withoutTenant } from "./with-tenant.js";

let dbAvailable = false;

beforeAll(async () => {
  dbAvailable = await canConnect();
  if (dbAvailable) await ensureMigrated();
});

afterAll(async () => {
  await closePool();
});

describe("RLS tenant isolation", () => {
  it("DB is reachable for the isolation test suite", () => {
    if (!dbAvailable) {
      throw new Error(
        "Live DB not available. Run `npm run db:up && npm run db:migrate` before `npm test`.",
      );
    }
  });

  it("two households cannot see each other's data via the public store API", async () => {
    const a = await createTestHousehold({ country: "DK" });
    const b = await createTestHousehold({ country: "NO" });
    try {
      // A writes
      await withEnvHousehold(a.id, async () => {
        await store.updateHousehold({
          people: [{ name: "Alice (A)", dietaryRestrictions: [], defaultSchedule: {} }],
        });
        await store.updatePantry(["salt", "A-only-item"], []);
        await store.addRecipe({
          name: "A-Recipe",
          servings: 2,
          complexity: "quick",
          cuisineType: "danish",
          proteinType: "vegetarian",
          ingredients: [],
        });
        await store.logMeal({ date: "2026-01-01", recipe: "A-Meal", people: ["Alice (A)"] });
        await store.logSpend({
          date: "2026-01-01",
          store: "Netto",
          estimatedTotal: 100,
          items: 5,
          notes: "",
        });
      });

      // B writes
      await withEnvHousehold(b.id, async () => {
        await store.updateHousehold({
          people: [{ name: "Bjørn (B)", dietaryRestrictions: [], defaultSchedule: {} }],
        });
        await store.updatePantry(["pepper", "B-only-item"], []);
        await store.addRecipe({
          name: "B-Recipe",
          servings: 4,
          complexity: "slow",
          cuisineType: "norwegian",
          proteinType: "fish",
          ingredients: [],
        });
        await store.logMeal({ date: "2026-01-01", recipe: "B-Meal", people: ["Bjørn (B)"] });
        await store.logSpend({
          date: "2026-01-01",
          store: "KIWI",
          estimatedTotal: 250,
          items: 9,
          notes: "weekly",
        });
      });

      // A reads — sees only A
      await withEnvHousehold(a.id, async () => {
        const profile = await store.getHousehold();
        expect(profile.country).toBe("DK");
        expect(profile.people[0]?.name).toBe("Alice (A)");
        const pantry = await store.getPantry();
        expect(pantry).toContain("A-only-item");
        expect(pantry).not.toContain("B-only-item");
        const recipes = await store.getRecipes();
        expect(recipes.map((r) => r.name)).toEqual(["A-Recipe"]);
        const meals = await store.getMealHistory(520);
        expect(meals.map((m) => m.recipe)).toEqual(["A-Meal"]);
        const spend = await store.getSpendLog(520);
        expect(spend.map((s) => s.store)).toEqual(["Netto"]);
      });

      // B reads — sees only B
      await withEnvHousehold(b.id, async () => {
        const profile = await store.getHousehold();
        expect(profile.country).toBe("NO");
        expect(profile.people[0]?.name).toBe("Bjørn (B)");
        const pantry = await store.getPantry();
        expect(pantry).toContain("B-only-item");
        expect(pantry).not.toContain("A-only-item");
        const recipes = await store.getRecipes();
        expect(recipes.map((r) => r.name)).toEqual(["B-Recipe"]);
        const meals = await store.getMealHistory(520);
        expect(meals.map((m) => m.recipe)).toEqual(["B-Meal"]);
        const spend = await store.getSpendLog(520);
        expect(spend.map((s) => s.store)).toEqual(["KIWI"]);
      });
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });

  it("raw connection without app.household_id set sees no rows in protected tables", async () => {
    const a = await createTestHousehold({ country: "DK" });
    try {
      const counts = await withoutTenant(async (client) => {
        const h = await client.query<{ count: string }>("SELECT count(*)::text FROM households");
        const m = await client.query<{ count: string }>(
          "SELECT count(*)::text FROM meal_log_entries",
        );
        const s = await client.query<{ count: string }>(
          "SELECT count(*)::text FROM spend_log_entries",
        );
        return {
          households: Number(h.rows[0].count),
          meals: Number(m.rows[0].count),
          spend: Number(s.rows[0].count),
        };
      });
      expect(counts.households).toBe(0);
      expect(counts.meals).toBe(0);
      expect(counts.spend).toBe(0);
    } finally {
      await a.cleanup();
    }
  });

  it("targeting another household's id without setting the session var still sees nothing", async () => {
    const a = await createTestHousehold();
    const b = await createTestHousehold();
    try {
      // Set A's id but try to query B's row by id. Should return 0 rows because
      // the RLS USING clause compares against app.household_id, which is A.
      await withEnvHousehold(a.id, async () => {
        const profile = await store.getHousehold(); // A
        expect(profile).toBeDefined();
      });
      // Switching env to A but querying with raw WHERE for B's id:
      const found = await withoutTenant(async (client) => {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.household_id', $1, true)", [a.id]);
        const r = await client.query<{ id: string }>("SELECT id FROM households WHERE id = $1", [
          b.id,
        ]);
        await client.query("ROLLBACK");
        return r.rowCount ?? 0;
      });
      expect(found).toBe(0);
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });
});
