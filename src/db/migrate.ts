/**
 * Migration runner.
 *
 * Reads `.sql` files from `src/db/migrations/` in lexicographic order and
 * applies any that haven't been recorded in the `_migrations` ledger.
 * Each file is run inside a transaction so partial application doesn't leave
 * the schema in a half-state.
 *
 * Hand-rolled (rather than drizzle-kit's migrator) because our initial
 * migration contains RLS policies that drizzle-kit doesn't model — and
 * because a 60-line runner is easier to audit than the framework path.
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, getPool } from "./client.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, "migrations");

async function ensureLedger(client: import("pg").PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name        text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function appliedSet(client: import("pg").PoolClient): Promise<Set<string>> {
  const { rows } = await client.query<{ name: string }>("SELECT name FROM _migrations");
  return new Set(rows.map((r) => r.name));
}

async function listMigrationFiles(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries.filter((e) => e.endsWith(".sql")).sort();
}

async function applyOne(client: import("pg").PoolClient, name: string, sql: string): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("INSERT INTO _migrations (name) VALUES ($1)", [name]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw new Error(`Migration ${name} failed: ${err instanceof Error ? err.message : err}`);
  }
}

export async function migrate(): Promise<{ applied: string[]; skipped: string[] }> {
  const pool = getPool();
  const client = await pool.connect();
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    await ensureLedger(client);
    const done = await appliedSet(client);
    const files = await listMigrationFiles();
    for (const name of files) {
      if (done.has(name)) {
        skipped.push(name);
        continue;
      }
      const sql = await readFile(join(MIGRATIONS_DIR, name), "utf8");
      await applyOne(client, name, sql);
      applied.push(name);
    }
  } finally {
    client.release();
  }
  return { applied, skipped };
}

// Allow `tsx src/db/migrate.ts` as a CLI.
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  migrate()
    .then(({ applied, skipped }) => {
      if (applied.length > 0) {
        console.log(`Applied ${applied.length} migration(s):`);
        for (const name of applied) console.log(`  + ${name}`);
      }
      if (skipped.length > 0) {
        console.log(`Already applied (${skipped.length}):`);
        for (const name of skipped) console.log(`  · ${name}`);
      }
      if (applied.length === 0 && skipped.length === 0) {
        console.log("No migrations found in src/db/migrations/.");
      }
    })
    .catch((err) => {
      console.error("Migration failed:", err);
      process.exit(1);
    })
    .finally(closePool);
}
