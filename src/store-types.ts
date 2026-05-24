/**
 * Domain types used by both the storage layer (Drizzle JSONB columns) and the
 * MCP tool layer (server.ts). Kept in a separate file from `store.ts` so the
 * schema can import them without pulling in pg / drizzle-orm at type-check
 * time.
 *
 * The shape here is the contract that survived the JSON → Postgres rewrite.
 * The 18 existing MCP tools were written against these types; preserving them
 * is the rewrite's defining constraint.
 */

import { z } from "zod";

export interface Person {
  name: string;
  dietaryRestrictions: string[];
  defaultSchedule: Record<string, boolean>;
}

export interface StorePreference {
  name: string;
  dealerId: string;
  priority: number;
}

export interface Household {
  people: Person[];
  stores: StorePreference[];
  defaultServings: number;
  /** ISO country code: DK / NO / SE / FI. */
  country: string;
}

export interface Ingredient {
  name: string;
  quantity: string;
  searchTerms: string[];
  category: string;
}

export interface Recipe {
  name: string;
  ingredients: Ingredient[];
  servings: number;
  complexity: "quick" | "medium" | "slow";
  cuisineType: string;
  proteinType: string;
}

export interface MealLogEntry {
  date: string;
  recipe: string;
  people: string[];
}

export interface SpendLogEntry {
  date: string;
  store: string;
  estimatedTotal: number;
  items: number;
  notes: string;
}

/**
 * The full in-memory snapshot a single household occupies. This used to be
 * the entire JSON file's shape; it is now the merged view of the
 * `households` row plus the per-household log tables.
 */
export interface DataStore {
  household: Household;
  pantry: string[];
  recipes: Recipe[];
  mealHistory: MealLogEntry[];
  spendLog: SpendLogEntry[];
}

/**
 * Zod schema for parsing legacy `~/.tilbudstrolden.json` files during the
 * one-off import. The legacy file is the only place this schema is needed —
 * the live storage path validates via Drizzle's types instead.
 */
export const LegacyDataStoreSchema = z.object({
  household: z
    .object({
      people: z
        .array(
          z.object({
            name: z.string(),
            dietaryRestrictions: z.array(z.string()).default([]),
            defaultSchedule: z.record(z.string(), z.boolean()).default({}),
          }),
        )
        .default([]),
      stores: z
        .array(
          z.object({
            name: z.string(),
            dealerId: z.string(),
            priority: z.number(),
          }),
        )
        .default([]),
      defaultServings: z.number().default(2),
      country: z.string().default("DK"),
    })
    .default({ people: [], stores: [], defaultServings: 2, country: "DK" }),
  pantry: z.array(z.string()).default([]),
  recipes: z
    .array(
      z.object({
        name: z.string(),
        ingredients: z.array(
          z.object({
            name: z.string(),
            quantity: z.string(),
            searchTerms: z.array(z.string()),
            category: z.string(),
          }),
        ),
        servings: z.number(),
        complexity: z.enum(["quick", "medium", "slow"]),
        cuisineType: z.string(),
        proteinType: z.string(),
      }),
    )
    .default([]),
  mealHistory: z
    .array(
      z.object({
        date: z.string(),
        recipe: z.string(),
        people: z.array(z.string()),
      }),
    )
    .default([]),
  spendLog: z
    .array(
      z.object({
        date: z.string(),
        store: z.string(),
        estimatedTotal: z.number(),
        items: z.number(),
        notes: z.string().default(""),
      }),
    )
    .default([]),
});

export type LegacyDataStore = z.infer<typeof LegacyDataStoreSchema>;

export const DEFAULT_HOUSEHOLD: Household = {
  people: [],
  stores: [],
  defaultServings: 2,
  country: "DK",
};

export const PG_SESSION_VAR = "app.household_id";
