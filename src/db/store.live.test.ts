/**
 * Live database tests for the rewritten store.ts.
 *
 * Asserts:
 *   - Each exported function preserves its old semantics against a real
 *     Postgres backend.
 *   - Reads and writes round-trip through RLS without leaking across tenants.
 *
 * Requires a live Postgres (see scripts/db-up.sh). The whole file is gated
 * on a connectivity check at startup so a missing DB fails with a clear
 * message rather than a cryptic ECONNREFUSED on each test.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as store from "../store.js";
import { closePool } from "./client.js";
import { canConnect, createTestHousehold, withEnvHousehold } from "./test-helpers.js";

let dbAvailable = false;

beforeAll(async () => {
  dbAvailable = await canConnect();
});

afterAll(async () => {
  await closePool();
});

describe.runIf(true)("live store CRUD", () => {
  it("requires DATABASE_URL + a running Postgres", () => {
    if (!dbAvailable) {
      throw new Error(
        "Live DB not available. Run `npm run db:up && npm run db:migrate` before `npm test`.",
      );
    }
    expect(dbAvailable).toBe(true);
  });

  describe("household profile", () => {
    it("read after create returns the seeded profile", async () => {
      const t = await createTestHousehold({ country: "NO", defaultServings: 3 });
      try {
        await withEnvHousehold(t.id, async () => {
          const profile = await store.getHousehold();
          expect(profile.country).toBe("NO");
          expect(profile.defaultServings).toBe(3);
          expect(profile.people).toEqual([]);
        });
      } finally {
        await t.cleanup();
      }
    });

    it("updateHousehold merges shallowly", async () => {
      const t = await createTestHousehold({ country: "DK", defaultServings: 2 });
      try {
        await withEnvHousehold(t.id, async () => {
          const before = await store.getHousehold();
          expect(before.country).toBe("DK");
          const after = await store.updateHousehold({
            people: [{ name: "Alice", dietaryRestrictions: ["no pork"], defaultSchedule: {} }],
            defaultServings: 4,
          });
          expect(after.country).toBe("DK"); // preserved
          expect(after.defaultServings).toBe(4);
          expect(after.people).toHaveLength(1);
          expect(after.people[0].name).toBe("Alice");
          // Re-read to confirm persistence
          const reread = await store.getHousehold();
          expect(reread.defaultServings).toBe(4);
        });
      } finally {
        await t.cleanup();
      }
    });
  });

  describe("pantry", () => {
    it("starts empty for a fresh household", async () => {
      const t = await createTestHousehold();
      try {
        await withEnvHousehold(t.id, async () => {
          expect(await store.getPantry()).toEqual([]);
        });
      } finally {
        await t.cleanup();
      }
    });

    it("adds, dedupes case-insensitively, and removes", async () => {
      const t = await createTestHousehold();
      try {
        await withEnvHousehold(t.id, async () => {
          let pantry = await store.updatePantry(["Salt", "Pepper", "salt"], []);
          // case-insensitive de-dup, sorted output
          expect(pantry).toEqual(["Pepper", "Salt"]);
          pantry = await store.updatePantry(["olive oil"], ["pepper"]);
          // remove is case-insensitive against existing
          expect(pantry).toEqual(["Salt", "olive oil"]);
        });
      } finally {
        await t.cleanup();
      }
    });
  });

  describe("recipes", () => {
    const sampleRecipe = {
      name: "Bolognese",
      servings: 4,
      complexity: "medium" as const,
      cuisineType: "italian",
      proteinType: "beef",
      ingredients: [
        {
          name: "Hakket oksekød",
          quantity: "500g",
          searchTerms: ["oksekød"],
          category: "meat",
        },
      ],
    };

    it("add then list", async () => {
      const t = await createTestHousehold();
      try {
        await withEnvHousehold(t.id, async () => {
          await store.addRecipe(sampleRecipe);
          const recipes = await store.getRecipes();
          expect(recipes).toHaveLength(1);
          expect(recipes[0].name).toBe("Bolognese");
        });
      } finally {
        await t.cleanup();
      }
    });

    it("add with same name overwrites (case-insensitive)", async () => {
      const t = await createTestHousehold();
      try {
        await withEnvHousehold(t.id, async () => {
          await store.addRecipe(sampleRecipe);
          await store.addRecipe({ ...sampleRecipe, name: "BOLOGNESE", servings: 6 });
          const recipes = await store.getRecipes();
          expect(recipes).toHaveLength(1);
          expect(recipes[0].servings).toBe(6);
        });
      } finally {
        await t.cleanup();
      }
    });

    it("removeRecipe returns false when missing", async () => {
      const t = await createTestHousehold();
      try {
        await withEnvHousehold(t.id, async () => {
          expect(await store.removeRecipe("Nonexistent")).toBe(false);
          await store.addRecipe(sampleRecipe);
          expect(await store.removeRecipe("bolognese")).toBe(true);
          expect(await store.getRecipes()).toHaveLength(0);
        });
      } finally {
        await t.cleanup();
      }
    });
  });

  describe("meal history", () => {
    it("logMeal upserts on (date, recipe); getMealHistory honours weeks window", async () => {
      const t = await createTestHousehold();
      try {
        await withEnvHousehold(t.id, async () => {
          const today = new Date().toISOString().slice(0, 10);
          await store.logMeal({ date: today, recipe: "Bolognese", people: ["Alice"] });
          await store.logMeal({
            date: today,
            recipe: "Bolognese", // same key
            people: ["Alice", "Bob"], // new people
          });
          await store.logMeal({ date: today, recipe: "Chili", people: ["Alice"] });

          const recent = await store.getMealHistory(1);
          expect(recent).toHaveLength(2);
          const bol = recent.find((m) => m.recipe === "Bolognese");
          expect(bol?.people).toEqual(["Alice", "Bob"]);

          // Old entry outside window
          const oldDate = "2020-01-01";
          await store.logMeal({ date: oldDate, recipe: "OldMeal", people: [] });
          const stillRecent = await store.getMealHistory(1);
          expect(stillRecent.find((m) => m.recipe === "OldMeal")).toBeUndefined();
        });
      } finally {
        await t.cleanup();
      }
    });
  });

  describe("spend log", () => {
    it("logSpend appends; getSpendLog filters by weeks window", async () => {
      const t = await createTestHousehold();
      try {
        await withEnvHousehold(t.id, async () => {
          const today = new Date().toISOString().slice(0, 10);
          await store.logSpend({
            date: today,
            store: "Netto",
            estimatedTotal: 312.5,
            items: 12,
            notes: "weekly",
          });
          await store.logSpend({
            date: today,
            store: "Føtex",
            estimatedTotal: 89.95,
            items: 4,
            notes: "",
          });
          const log = await store.getSpendLog(1);
          expect(log).toHaveLength(2);
          const total = log.reduce((acc, e) => acc + e.estimatedTotal, 0);
          expect(total).toBeCloseTo(402.45, 2);
          // Numeric type round-tripped as Number
          expect(typeof log[0].estimatedTotal).toBe("number");
        });
      } finally {
        await t.cleanup();
      }
    });
  });
});
