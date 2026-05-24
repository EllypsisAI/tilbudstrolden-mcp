-- Initial schema: households + per-household log tables, plus RLS policies.
-- Hand-authored (rather than drizzle-kit generated) so the RLS policies sit
-- alongside the table definitions they protect and survive future schema
-- diffs. Subsequent migrations should be additive and follow this same
-- numbering convention (0001_*, 0002_*, ...).

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------

-- pgcrypto provides gen_random_uuid(); built into PG13+ but enabling
-- explicitly makes the dependency obvious and survives moves to managed
-- providers that may not enable it by default.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS households (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Bounded household profile (people, stores, defaultServings, country).
  household   jsonb NOT NULL,
  -- Pantry staples (lowercased on write at the app layer).
  pantry      jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Recipe library.
  recipes     jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS meal_log_entries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id  uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  date          date NOT NULL,
  recipe        text NOT NULL,
  people        jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS meal_log_household_date_idx
  ON meal_log_entries (household_id, date DESC);

CREATE UNIQUE INDEX IF NOT EXISTS meal_log_dedup_idx
  ON meal_log_entries (household_id, date, recipe);

CREATE TABLE IF NOT EXISTS spend_log_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id    uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  date            date NOT NULL,
  store           text NOT NULL,
  estimated_total numeric(10, 2) NOT NULL,
  items           integer NOT NULL,
  notes           text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS spend_log_household_date_idx
  ON spend_log_entries (household_id, date DESC);

-- ---------------------------------------------------------------------------
-- updated_at trigger for households
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS households_touch_updated_at ON households;
CREATE TRIGGER households_touch_updated_at
  BEFORE UPDATE ON households
  FOR EACH ROW
  EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row-Level Security
--
-- Every tenant-scoped query must run in a transaction that has set
-- `app.household_id` to the household's UUID. RLS policies filter rows
-- against that session variable; without it, queries return no rows.
--
-- We use FORCE ROW LEVEL SECURITY so the policies apply even to the table
-- owner (which would otherwise be exempt). This is what makes the isolation
-- belt-and-suspenders: a future bug that connects as the owner cannot bypass
-- the policy.
--
-- `current_setting('app.household_id', true)` returns NULL instead of
-- raising when the variable isn't set. NULL-against-UUID-equality is false,
-- so unauthenticated queries see nothing.
-- ---------------------------------------------------------------------------

ALTER TABLE households          ENABLE ROW LEVEL SECURITY;
ALTER TABLE households          FORCE  ROW LEVEL SECURITY;
ALTER TABLE meal_log_entries    ENABLE ROW LEVEL SECURITY;
ALTER TABLE meal_log_entries    FORCE  ROW LEVEL SECURITY;
ALTER TABLE spend_log_entries   ENABLE ROW LEVEL SECURITY;
ALTER TABLE spend_log_entries   FORCE  ROW LEVEL SECURITY;

-- Households: each row gates on its own id matching the session variable.
DROP POLICY IF EXISTS households_tenant_select ON households;
CREATE POLICY households_tenant_select ON households
  FOR SELECT
  USING (id = NULLIF(current_setting('app.household_id', true), '')::uuid);

DROP POLICY IF EXISTS households_tenant_insert ON households;
CREATE POLICY households_tenant_insert ON households
  FOR INSERT
  WITH CHECK (id = NULLIF(current_setting('app.household_id', true), '')::uuid);

DROP POLICY IF EXISTS households_tenant_update ON households;
CREATE POLICY households_tenant_update ON households
  FOR UPDATE
  USING (id = NULLIF(current_setting('app.household_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.household_id', true), '')::uuid);

DROP POLICY IF EXISTS households_tenant_delete ON households;
CREATE POLICY households_tenant_delete ON households
  FOR DELETE
  USING (id = NULLIF(current_setting('app.household_id', true), '')::uuid);

-- Per-household log tables: gate on household_id column.
DROP POLICY IF EXISTS meal_log_tenant_select ON meal_log_entries;
CREATE POLICY meal_log_tenant_select ON meal_log_entries
  FOR SELECT
  USING (household_id = NULLIF(current_setting('app.household_id', true), '')::uuid);

DROP POLICY IF EXISTS meal_log_tenant_insert ON meal_log_entries;
CREATE POLICY meal_log_tenant_insert ON meal_log_entries
  FOR INSERT
  WITH CHECK (household_id = NULLIF(current_setting('app.household_id', true), '')::uuid);

DROP POLICY IF EXISTS meal_log_tenant_update ON meal_log_entries;
CREATE POLICY meal_log_tenant_update ON meal_log_entries
  FOR UPDATE
  USING (household_id = NULLIF(current_setting('app.household_id', true), '')::uuid)
  WITH CHECK (household_id = NULLIF(current_setting('app.household_id', true), '')::uuid);

DROP POLICY IF EXISTS meal_log_tenant_delete ON meal_log_entries;
CREATE POLICY meal_log_tenant_delete ON meal_log_entries
  FOR DELETE
  USING (household_id = NULLIF(current_setting('app.household_id', true), '')::uuid);

DROP POLICY IF EXISTS spend_log_tenant_select ON spend_log_entries;
CREATE POLICY spend_log_tenant_select ON spend_log_entries
  FOR SELECT
  USING (household_id = NULLIF(current_setting('app.household_id', true), '')::uuid);

DROP POLICY IF EXISTS spend_log_tenant_insert ON spend_log_entries;
CREATE POLICY spend_log_tenant_insert ON spend_log_entries
  FOR INSERT
  WITH CHECK (household_id = NULLIF(current_setting('app.household_id', true), '')::uuid);

DROP POLICY IF EXISTS spend_log_tenant_update ON spend_log_entries;
CREATE POLICY spend_log_tenant_update ON spend_log_entries
  FOR UPDATE
  USING (household_id = NULLIF(current_setting('app.household_id', true), '')::uuid)
  WITH CHECK (household_id = NULLIF(current_setting('app.household_id', true), '')::uuid);

DROP POLICY IF EXISTS spend_log_tenant_delete ON spend_log_entries;
CREATE POLICY spend_log_tenant_delete ON spend_log_entries
  FOR DELETE
  USING (household_id = NULLIF(current_setting('app.household_id', true), '')::uuid);
