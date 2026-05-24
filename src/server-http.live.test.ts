/**
 * End-to-end HTTP integration: bearer auth → identity resolution →
 * tenant-scoped tool call.
 *
 * Spec acceptance criterion: two different WorkOS tokens (two `sub` values)
 * hit `get_household` and each sees only their own data, with the
 * `AsyncLocalStorage`-backed tenant scope as the only thing standing
 * between them.
 *
 * We don't run a real WorkOS — we inject a verifier built from a local
 * key pair, the same trick `workos.test.ts` uses. Everything else is
 * production code paths (Express middleware, SDK transport, store layer,
 * RLS).
 */

import type { OAuthMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { generateKeyPair, SignJWT } from "jose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorkOSVerifier } from "./auth/workos.js";
import { closePool, getPool } from "./db/client.js";
import { canConnect, ensureMigrated } from "./db/test-helpers.js";
import { withoutTenant } from "./db/with-tenant.js";
import { buildHttpApp } from "./server-http.js";

const ISSUER = "https://example-workos.test/oauth";
const CLIENT_ID = "client_test_http";
const PUBLIC_BASE = "http://localhost:3000";
const RESOURCE = `${PUBLIC_BASE}/mcp`;

let privateKey: CryptoKey;
let publicKey: CryptoKey;
let dbAvailable = false;
let app: ReturnType<typeof buildHttpApp>;

const seenSubs: Set<string> = new Set();

function fakeWorkosMetadata(): OAuthMetadata {
  // Synthetic metadata matching what WorkOS would publish, sufficient for
  // the SDK router to render valid `.well-known` responses.
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    registration_endpoint: `${ISSUER}/register`,
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    scopes_supported: ["openid", "profile", "email"],
  };
}

async function mintToken(
  sub: string,
  overrides: { aud?: string; iss?: string; email?: string } = {},
): Promise<string> {
  return new SignJWT({
    sub,
    email: overrides.email ?? `${sub}@example.com`,
    provider: "google-oauth",
    scope: "openid profile email",
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
    .setIssuer(overrides.iss ?? ISSUER)
    .setAudience(overrides.aud ?? RESOURCE)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

async function cleanupBySubs(): Promise<void> {
  // Tear down every household created during this test run.
  if (seenSubs.size === 0) return;
  const pool = getPool();
  const client = await pool.connect();
  try {
    const result = await client.query<{ household_id: string }>(
      `SELECT household_id FROM users WHERE workos_sub = ANY($1::text[])`,
      [[...seenSubs]],
    );
    for (const row of result.rows) {
      await client.query("DELETE FROM users WHERE household_id = $1", [row.household_id]);
      await client.query("BEGIN");
      try {
        await client.query("SELECT set_config('app.household_id', $1, true)", [row.household_id]);
        await client.query("DELETE FROM households WHERE id = $1", [row.household_id]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  dbAvailable = await canConnect();
  if (!dbAvailable) return;
  await ensureMigrated();

  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  publicKey = pair.publicKey;

  const verifier = WorkOSVerifier.withGetKey(
    { issuerUrl: ISSUER, clientId: CLIENT_ID, resourceUrl: RESOURCE },
    async () => publicKey,
  );

  app = buildHttpApp({
    verifier,
    oauthMetadata: fakeWorkosMetadata(),
    publicBaseUrl: PUBLIC_BASE,
  });
});

afterAll(async () => {
  await cleanupBySubs();
  await closePool();
});

/**
 * Helper: JSON-RPC call shape for a tool invocation.
 */
function jsonrpcToolCall(name: string, args: Record<string, unknown> = {}, id = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  };
}

function jsonrpcInitialize(id = 0) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "supertest", version: "0.0.0" },
    },
  };
}

/**
 * Send an MCP request through the HTTP stack. The Streamable HTTP transport
 * expects both JSON and SSE in the Accept header even for synchronous
 * (non-stream) tool calls, so we always negotiate both.
 */
async function callMcp(token: string | null, body: unknown) {
  const req = request(app).post("/mcp").set("Accept", "application/json, text/event-stream");
  if (token) {
    req.set("Authorization", `Bearer ${token}`);
  }
  return req.send(body);
}

/**
 * The transport encodes responses as SSE event(s). Parse the response body
 * (which is one or more `data: ...\n\n` blocks) back into the JSON payload.
 */
function parseSseJson(text: string): { result?: unknown; error?: unknown } {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      const json = line.slice("data: ".length).trim();
      if (json.length === 0) continue;
      return JSON.parse(json);
    }
  }
  throw new Error(`No data: line in SSE body. Got: ${text.slice(0, 200)}`);
}

describe("HTTP integration — auth + tenant", () => {
  it("DB is reachable for the HTTP suite", () => {
    if (!dbAvailable) {
      throw new Error(
        "Live DB not available. Run `npm run db:up && npm run db:migrate` before `npm test`.",
      );
    }
  });

  it("GET /health is 200 and not behind auth", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.version).toBeTruthy();
  });

  it("GET /.well-known/oauth-protected-resource/mcp returns RFC 9728 metadata", async () => {
    const res = await request(app).get("/.well-known/oauth-protected-resource/mcp");
    expect(res.status).toBe(200);
    expect(res.body.resource).toBe(RESOURCE);
    expect(res.body.authorization_servers).toContain(ISSUER);
  });

  it("GET /.well-known/oauth-authorization-server returns RFC 8414 metadata", async () => {
    const res = await request(app).get("/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    expect(res.body.issuer).toBe(ISSUER);
    expect(res.body.authorization_endpoint).toContain("/authorize");
    expect(res.body.token_endpoint).toContain("/token");
  });

  it("POST /mcp without Authorization is 401 with WWW-Authenticate pointing at our resource metadata", async () => {
    const res = await callMcp(null, jsonrpcInitialize());
    expect(res.status).toBe(401);
    const wwwAuth = res.headers["www-authenticate"];
    expect(wwwAuth).toBeDefined();
    // Per RFC 9728 §5.1 the header points at our resource metadata URL.
    expect(wwwAuth).toContain("resource_metadata");
    expect(wwwAuth).toContain("/.well-known/oauth-protected-resource/mcp");
  });

  it("POST /mcp with an expired token is 401", async () => {
    const builder = new SignJWT({ sub: "workos|expired-user" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
      .setIssuer(ISSUER)
      .setAudience(RESOURCE)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) - 1);
    const token = await builder.sign(privateKey);
    const res = await callMcp(token, jsonrpcInitialize());
    expect(res.status).toBe(401);
  });

  it("POST /mcp with a token whose audience is wrong is 401", async () => {
    const token = await mintToken("workos|wrong-aud", { aud: "http://other-mcp/mcp" });
    const res = await callMcp(token, jsonrpcInitialize());
    expect(res.status).toBe(401);
  });

  it("POST /mcp with valid token executes initialize and tools/list", async () => {
    const sub = `workos|test-init-${Date.now()}`;
    seenSubs.add(sub);
    const token = await mintToken(sub);

    // Initialize first — MCP requires it before tools/call.
    const initRes = await callMcp(token, jsonrpcInitialize());
    expect(initRes.status).toBe(200);

    const listRes = await callMcp(token, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    expect(listRes.status).toBe(200);
    const parsed = parseSseJson(listRes.text) as {
      result?: { tools?: Array<{ name: string }> };
    };
    expect(parsed.result?.tools).toBeDefined();
    // The 18 tools registered by createMcpServer().
    expect(parsed.result?.tools?.length).toBeGreaterThanOrEqual(18);
    const names = parsed.result?.tools?.map((t) => t.name);
    expect(names).toContain("get_household");
    expect(names).toContain("update_household");
  });

  it("two different subs each get their own household — no cross-tenant leak via HTTP", async () => {
    const subA = `workos|test-iso-a-${Date.now()}`;
    const subB = `workos|test-iso-b-${Date.now()}`;
    seenSubs.add(subA);
    seenSubs.add(subB);
    const tokenA = await mintToken(subA, { email: "alice@example.com" });
    const tokenB = await mintToken(subB, { email: "bjorn@example.com" });

    // Initialize both clients.
    await callMcp(tokenA, jsonrpcInitialize(0));
    await callMcp(tokenB, jsonrpcInitialize(0));

    // A sets household profile.
    const setA = await callMcp(
      tokenA,
      jsonrpcToolCall(
        "update_household",
        {
          country: "DK",
          people: [{ name: "Alice", dietaryRestrictions: ["no pork"], defaultSchedule: {} }],
          defaultServings: 2,
        },
        10,
      ),
    );
    expect(setA.status).toBe(200);

    // B sets a different household profile.
    const setB = await callMcp(
      tokenB,
      jsonrpcToolCall(
        "update_household",
        {
          country: "NO",
          people: [{ name: "Bjørn", dietaryRestrictions: [], defaultSchedule: {} }],
          defaultServings: 4,
        },
        11,
      ),
    );
    expect(setB.status).toBe(200);

    // Now read back: A sees A's data only.
    const getA = await callMcp(tokenA, jsonrpcToolCall("get_household", {}, 20));
    expect(getA.status).toBe(200);
    const aBody = parseSseJson(getA.text) as {
      result?: { content?: Array<{ text?: string }> };
    };
    const aText = aBody.result?.content?.[0]?.text ?? "";
    expect(aText).toContain("DK market");
    expect(aText).toContain("Alice");
    expect(aText).not.toContain("Bjørn");
    expect(aText).not.toContain("NO market");

    // B sees B's data only.
    const getB = await callMcp(tokenB, jsonrpcToolCall("get_household", {}, 21));
    expect(getB.status).toBe(200);
    const bBody = parseSseJson(getB.text) as {
      result?: { content?: Array<{ text?: string }> };
    };
    const bText = bBody.result?.content?.[0]?.text ?? "";
    expect(bText).toContain("NO market");
    expect(bText).toContain("Bjørn");
    expect(bText).not.toContain("Alice");
    expect(bText).not.toContain("DK market");
  });

  it("interleaved concurrent requests for two subs do not leak tenant context", async () => {
    // The AsyncLocalStorage check: if the tenant context leaks across
    // concurrent async stacks, this test will see B's data inside an A
    // request or vice versa. Each side reads its own data 5 times,
    // interleaved. If any read returns the wrong country, ALS is broken.
    const subA = `workos|test-conc-a-${Date.now()}`;
    const subB = `workos|test-conc-b-${Date.now()}`;
    seenSubs.add(subA);
    seenSubs.add(subB);
    const tokenA = await mintToken(subA);
    const tokenB = await mintToken(subB);

    await callMcp(tokenA, jsonrpcInitialize(0));
    await callMcp(tokenB, jsonrpcInitialize(0));
    // get_household renders an onboarding message when both people and
    // stores are empty — so set a person on each side to force the
    // "country" branch.
    await callMcp(
      tokenA,
      jsonrpcToolCall(
        "update_household",
        {
          country: "DK",
          people: [{ name: "Anders", dietaryRestrictions: [], defaultSchedule: {} }],
        },
        30,
      ),
    );
    await callMcp(
      tokenB,
      jsonrpcToolCall(
        "update_household",
        {
          country: "SE",
          people: [{ name: "Sven", dietaryRestrictions: [], defaultSchedule: {} }],
        },
        31,
      ),
    );

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => {
        const useA = i % 2 === 0;
        return callMcp(useA ? tokenA : tokenB, jsonrpcToolCall("get_household", {}, 100 + i)).then(
          (res) => ({
            useA,
            text: (parseSseJson(res.text) as { result?: { content?: Array<{ text?: string }> } })
              .result?.content?.[0]?.text,
          }),
        );
      }),
    );
    for (const r of results) {
      const expected = r.useA ? "DK" : "SE";
      const forbidden = r.useA ? "SE" : "DK";
      expect(r.text).toContain(`${expected} market`);
      expect(r.text).not.toContain(`${forbidden} market`);
    }
  });

  it("raw connection without ALS or env var set has no tenant context — RLS chokepoint holds", async () => {
    // Confirm the fallback case: if a buggy code path ever skipped the
    // middleware, the store would throw with a clear error rather than
    // silently leak.
    await withoutTenant(async (client) => {
      const r = await client.query<{ c: string }>("SELECT count(*)::text AS c FROM households");
      // RLS returns 0 rows without a household_id set.
      expect(Number(r.rows[0].c)).toBe(0);
    });
  });
});
