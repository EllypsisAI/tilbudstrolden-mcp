-- Identity → tenant mapping for OAuth-authenticated requests.
--
-- The auth layer (station 3) translates a WorkOS-issued JWT's `sub` claim
-- into a `household_id` via this table. First-login flow: see an unknown
-- `workos_sub` → create a household row → seed defaults → insert a users row
-- linking the two, all inside one transaction. Returning visit: lookup.
--
-- *No RLS on this table.* It is the identity → tenant lookup, not per-tenant
-- payload data. Access is gated by application-layer auth (only requests
-- with a validated bearer token reach the resolver), and rows contain only
-- the WorkOS subject + profile shards the IdP returned. Putting RLS here
-- would create a chicken-and-egg: the request can't know its household_id
-- until it reads this table, but RLS would require that id to read it.

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- WorkOS subject ID (Google/Microsoft provider sub, stable per provider).
  -- The unique constraint backs the race-condition guarantee in the
  -- resolver: two concurrent first-logins for the same sub end with exactly
  -- one users row.
  workos_sub    text NOT NULL UNIQUE,
  household_id  uuid NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
  email         text,
  -- e.g. 'google-oauth', 'microsoft-oauth' — informational, not used for
  -- access control. Provider switch for the same Google account would
  -- keep the same `sub` per OIDC spec.
  provider      text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- The UNIQUE constraint above creates a btree index covering lookup-by-sub;
-- no extra index needed.

-- Re-use the trigger function defined in 0000_initial.sql for households.
DROP TRIGGER IF EXISTS users_touch_updated_at ON users;
CREATE TRIGGER users_touch_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION touch_updated_at();
