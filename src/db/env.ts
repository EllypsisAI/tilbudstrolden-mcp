/**
 * Minimal .env.local loader.
 *
 * Reads KEY=value lines from `.env.local` at repo root (or the directory the
 * process was launched from) and populates `process.env`. Existing values
 * are not overwritten — the real environment always wins. Lines starting
 * with `#` are comments.
 *
 * No dependency on `dotenv`; the format we use is too small to justify it.
 * Call `loadEnv()` once at the top of any entry point (scripts, tests,
 * server.ts) before consuming `process.env`.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

let loaded = false;

function parseLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) return null;
  const eq = trimmed.indexOf("=");
  if (eq === -1) return null;
  const key = trimmed.slice(0, eq).trim();
  let value = trimmed.slice(eq + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return [key, value];
}

export function loadEnv(file = ".env.local"): void {
  if (loaded) return;
  loaded = true;
  const path = resolve(process.cwd(), file);
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of contents.split(/\r?\n/)) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
