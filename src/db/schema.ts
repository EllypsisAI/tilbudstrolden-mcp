/**
 * Drizzle schema for tilbudstrolden-mcp.
 *
 * One row per household, with bounded embeds (people, stores, pantry, recipes)
 * inlined as JSONB. Unbounded append-only logs (meals, spend) live in separate
 * tables with `(household_id, date desc)` indexes.
 *
 * Tenant isolation is enforced at the database level via RLS — see
 * `migrations/0000_initial.sql` for the policy definitions. The app sets
 * `app.household_id` per transaction in `with-tenant.ts`; every row visibility
 * decision flows from that single connection-scoped variable.
 */

import {
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { Household, MealLogEntry, Recipe, SpendLogEntry } from "../store-types.js";

export const households = pgTable("households", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Bounded household profile: people, stores, defaultServings, country. */
  household: jsonb("household").$type<Household>().notNull(),
  /** Pantry staples (lowercased on write). */
  pantry: jsonb("pantry").$type<string[]>().notNull().default([]),
  /** Saved recipe library. */
  recipes: jsonb("recipes").$type<Recipe[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const mealLogEntries = pgTable(
  "meal_log_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    /** ISO date (YYYY-MM-DD). */
    date: date("date").notNull(),
    recipe: text("recipe").notNull(),
    people: jsonb("people").$type<MealLogEntry["people"]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("meal_log_household_date_idx").on(table.householdId, table.date.desc()),
    /** Dedupe: one (household, date, recipe-lowercase) entry. */
    uniqueIndex("meal_log_dedup_idx").on(table.householdId, table.date, table.recipe),
  ],
);

export const spendLogEntries = pgTable(
  "spend_log_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    store: text("store").notNull(),
    /** Stored as numeric for exact arithmetic; consumers parse to Number. */
    estimatedTotal: numeric("estimated_total", { precision: 10, scale: 2 }).notNull(),
    items: integer("items").notNull(),
    notes: text("notes").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("spend_log_household_date_idx").on(table.householdId, table.date.desc())],
);

export type HouseholdRow = typeof households.$inferSelect;
export type MealLogRow = typeof mealLogEntries.$inferSelect;
export type SpendLogRow = typeof spendLogEntries.$inferSelect;

export type NewHouseholdRow = typeof households.$inferInsert;
export type NewMealLogRow = typeof mealLogEntries.$inferInsert;
export type NewSpendLogRow = typeof spendLogEntries.$inferInsert;
