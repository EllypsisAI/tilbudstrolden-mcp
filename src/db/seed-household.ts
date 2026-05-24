/**
 * Shared first-time household seeding.
 *
 * Called by:
 *   - `bootstrap.ts` — single-tenant dev path: ensure a household exists
 *     for the env-var-configured id at server startup.
 *   - `auth/resolve-household.ts` — multi-tenant auth path: a never-seen
 *     WorkOS subject hits the server → create the user's household.
 *
 * Both paths need the same default-recipes-by-country behaviour, so the
 * insert lives here and the callers wrap it in their own transaction +
 * tenant scope.
 */

import { defaultRecipes } from "../default-recipes.js";
import { DEFAULT_HOUSEHOLD, type Recipe } from "../store-types.js";
import type { Db } from "./client.js";
import { households } from "./schema.js";

export interface SeedHouseholdOptions {
  /** UUID of the household to create. Must match the tenant scope of `db`. */
  id: string;
  /** ISO-3166 country code (DK | NO | SE | FI). Drives default-recipe seeding. */
  country?: string;
}

/**
 * Insert a fresh household row using the values from {@link DEFAULT_HOUSEHOLD},
 * plus the Danish default-recipe library when `country === "DK"`.
 *
 * Caller must:
 *   - Be inside a transaction that has set `app.household_id` to `opts.id`
 *     (so the RLS WITH CHECK clause on `households` accepts the INSERT).
 *   - Handle conflicts (this helper does not catch unique-violations on `id`).
 */
export async function seedHousehold(db: Db, opts: SeedHouseholdOptions): Promise<void> {
  const country = opts.country ?? "DK";
  const seedRecipes: Recipe[] = country === "DK" ? [...defaultRecipes] : [];
  const profile = { ...DEFAULT_HOUSEHOLD, country };
  await db.insert(households).values({
    id: opts.id,
    household: profile,
    pantry: [],
    recipes: seedRecipes,
  });
}
