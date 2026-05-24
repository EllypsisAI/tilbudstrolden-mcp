# Spec: Roadmap-station 3 — Auth + multi-user identity

Status: ready (2026-05-24) — frozen, awaiting execution
Roadmap reference: [`workspace/roadmap.md` §3](../roadmap.md)

## Scope

Wire WorkOS AuthKit as the OAuth 2.1 authorization server for our remote MCP server, switch transport from stdio to HTTP (Streamable HTTP) so MCP clients can complete the OAuth dance, and turn validated WorkOS identities into the `household_id` that the RLS chokepoint built in station 2 already consumes. Multi-user from day one: two users hitting `get_household` at the same moment each see only their own data, enforced both by the JWT-middleware that *sets* `app.household_id` and by the Postgres policies that *check* it.

Six locked design choices drive the work:

- **MCP spec target:** **2025-11-25** (current). CIMD is SHOULD; DCR is MAY (demoted from earlier revisions). Cross-checked against `mcp-server-dev` skill `references/auth.md` (verified 2026-03 per `references/versions.md`).
- **Auth provider:** WorkOS AuthKit as the **authorization server**. We are a **resource server**: we validate WorkOS-signed JWTs, advertise WorkOS as our AS via metadata, and never implement `/authorize` or `/token` ourselves. Locked in [`decisions/auth-provider.md`](../decisions/auth-provider.md).
- **Claude-supported auth type:** `oauth_cimd` (preferred) + `oauth_dcr` (fallback for hosts not yet on CIMD). Both enabled in WorkOS dashboard. `static_bearer` (user-pasted tokens) and pure `client_credentials` are **not supported by Claude's MCP client** per the canonical auth playbook, so we don't advertise them.
- **Transport: dual + stateless.** `npm start` keeps the stdio runner for local dev against env-var `TILBUDSTROLDEN_HOUSEHOLD_ID` (fast inner loop, no WorkOS round-trip). `npm run dev:http` boots a **stateless** Streamable-HTTP runner: a fresh `StreamableHTTPServerTransport` (with `sessionIdGenerator: undefined`) per request — the spec-recommended default per the skill's scaffold. Each request carries its own JWT; no cross-call session state is needed at the MCP layer. Both transports register the same tools and call the same `withTenant(householdId, …)` chokepoint — only the source of `householdId` differs.
- **Identity → tenant mapping:** WorkOS `sub` (Google/Microsoft subject ID, stable per provider) → our `users` table → `household_id`. First time we see a `sub`: create user + create household + seed (same flow as `npm run db:bootstrap`). Returning `sub`: lookup. The `users` table is NOT under RLS (it's the lookup table that maps identity to tenant); only data tables stay tenant-scoped.
- **Verification target:** MCP Inspector. Spec is "done" when Inspector (`npx @modelcontextprotocol/inspector`, UI at `localhost:6274`, Streamable-HTTP transport pointed at our `/mcp`) can complete OAuth (DCR or CIMD) → tool call → see this household's data and only this household's data.

## Deliverables

1. **Users table migration.** `src/db/migrations/0001_users.sql`:
   - `users` table: `id uuid pk default gen_random_uuid()`, `workos_sub text unique not null`, `household_id uuid not null references households(id) on delete restrict`, `email text`, `provider text` (e.g. `'google-oauth'`, `'microsoft-oauth'`), `created_at`, `updated_at` (touched by same `touch_updated_at` trigger from `0000`).
   - Index on `workos_sub` (covered by unique constraint) for lookup-by-token-claim.
   - **No RLS** on this table — explicitly. It's the identity → tenant map; access is gated by application-layer auth (only requests with a validated JWT can hit it), and rows contain no per-household payload data.
   - Drizzle schema in `src/db/schema.ts` extended with the `users` table declaration.

2. **WorkOS client + JWT validation.** `src/auth/workos.ts`:
   - Initialize WorkOS SDK from `WORKOS_API_KEY` + `WORKOS_CLIENT_ID` env.
   - JWKS fetch + in-memory cache (10 min TTL, refresh on `kid`-miss). Use `jose` (`createRemoteJWKSet`) for verification.
   - **RFC 8707 audience validation is a MUST per the auth playbook.** The verifier asserts the token was minted *for our server* (audience claim matches `PUBLIC_BASE_URL/mcp` or whatever WorkOS issues as `aud`). A token issued for a different resource server is rejected even if the signature checks out.
   - **No token passthrough.** If we ever need to call an upstream service, we use our own credentials or exchange the user's token — we never forward the user's WorkOS access token to another API. Explicitly forbidden by the playbook.
   - Export a verifier that **implements the SDK's `OAuthTokenVerifier` interface** (from `@modelcontextprotocol/sdk/server/auth/provider`): `verifyAccessToken(token: string): Promise<AuthInfo>`.
   - The returned `AuthInfo` carries WorkOS claims through `.extra`: `{ token, clientId: WORKOS_CLIENT_ID, scopes: [...], expiresAt, resource, extra: { workos_sub, email, provider } }`. Downstream household-resolver middleware reads `req.auth.extra.workos_sub`.
   - Throws on expired / invalid-signature / invalid-audience / malformed; the SDK's `requireBearerAuth()` middleware (deliverable #5) maps the throw to the right 401 + `WWW-Authenticate` shape.

3. **Identity → tenant resolver.** `src/auth/resolve-household.ts`:
   - `resolveHouseholdForClaims(claims: WorkOSClaims): Promise<{ userId: string; householdId: string; created: boolean }>`.
   - Uses `withoutTenant()` escape hatch (already exists from station 2) for the users-table lookup.
   - On miss: open a transaction, create user + create household (using the same bootstrap logic as `src/db/bootstrap.ts` — extracted into a shared `seedHousehold()` helper so we don't duplicate the default-recipes-by-country path), insert the user row, commit. Returns `created: true`.
   - On hit: just returns the existing pair. `created: false`.
   - Idempotent under race conditions: relies on the `users.workos_sub` unique constraint; if two requests for the same brand-new `sub` race, one wins the insert, the other catches the unique-violation and re-fetches.

4. **OAuth metadata endpoints — use the SDK's router, do not hand-craft.** Per MCP 2025-03-26 spec we expose RFC 8414 + RFC 9728 metadata, but the SDK ships `mcpAuthMetadataRouter()` (in `@modelcontextprotocol/sdk/server/auth/router`) that mounts both for us:
   - `GET /.well-known/oauth-authorization-server` — RFC 8414. Generated from a `OAuthMetadata` object we fetch once at startup from WorkOS's own `/.well-known/oauth-authorization-server`.
   - `GET /.well-known/oauth-protected-resource/mcp` — RFC 9728, **path-scoped to our resource** at `/mcp`. The router computes the right path from our `resourceServerUrl` (helper: `getOAuthProtectedResourceMetadataUrl(serverUrl)`).
   - One call at startup: `app.use(mcpAuthMetadataRouter({ oauthMetadata, resourceServerUrl: new URL(`${PUBLIC_BASE_URL}/mcp`), scopesSupported: ['openid', 'profile', 'email'], resourceName: 'TilbudsTrolden MCP' }))`.
   - DCR + CIMD advertisement: come for free in the `oauthMetadata` we fetch from WorkOS (assuming they're enabled in the WorkOS dashboard per deliverable #8). No flag synthesis from us.

5. **HTTP transport + auth middleware.** `src/server-http.ts` — follows the canonical scaffold from `mcp-server-dev` skill (`references/remote-http-scaffold.md`), adapted for OAuth:
   - Use `createMcpExpressApp()` from `@modelcontextprotocol/sdk/server/express` instead of bare `express()` — gives **Origin header validation** (DNS-rebinding prevention, spec MUST) out of the box.
   - `app.use(express.json())` for body parsing (required by the SDK transport's `handleRequest(req, res, req.body)` shape).
   - **Stateless transport pattern:** create a fresh `new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` inside each `POST /mcp` handler, `await server.connect(transport)`, `await transport.handleRequest(req, res, req.body)`, close on `res.on('close', …)`. No cross-request session state. Same for `GET /mcp` (SSE notifications, also stateless per-request). This matches the skill's recommended default.
   - Middleware chain on `/mcp`:
     1. **`requireBearerAuth({ verifier: workosVerifier, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL('/mcp', PUBLIC_BASE_URL)) })`** from the SDK — extracts `Authorization: Bearer …`, calls our verifier, sets `req.auth: AuthInfo` on success, returns 401 + correct `WWW-Authenticate` (with our resource metadata URL) on failure. We do not hand-roll any of this.
     2. **Our household resolver middleware** — reads `req.auth.extra.workos_sub`, calls `resolveHouseholdForClaims`, opens an `AsyncLocalStorage` scope carrying the resolved `householdId` for the duration of `transport.handleRequest()` (so tool callbacks running synchronously inside `handleRequest` inherit it). The store layer reads back via `ambientHouseholdId()` (extended in deliverable #6).
   - **`MCP-Protocol-Version` header handling** is done by the SDK transport — unsupported versions return 400. We verify, not implement.
   - **CORS** — the MCP Inspector runs in a browser at `http://localhost:6274`, so for local dev we allow that origin (`cors({ origin: ['http://localhost:6274'], ... })`). Production CORS policy is station 4.
   - All MCP tool invocations inside an HTTP request inherit that `householdId` instead of the env-var ambient one.

6. **Request-scoped tenant context.** `src/db/with-tenant.ts` extended:
   - Add `withRequestHousehold(householdId, fn)` that uses Node's `AsyncLocalStorage` to carry the per-request `householdId` through the call stack. **The SDK does not provide an ALS / per-request context primitive** — `StreamableHTTPServerTransport` only threads `req.auth: AuthInfo` through, so the ALS layer is ours to build. The store layer's existing `ambientHouseholdId()` is updated to check (in order): AsyncLocalStorage first, env var second. Stdio runner sets nothing → falls back to env var. HTTP middleware wraps each request in `withRequestHousehold(id, …)`.
   - This means `src/store.ts` and `src/server.ts` need zero changes. The whole auth surgery happens *around* the existing tool registrations.

7. **HTTP runner entry point.** `src/server-http.ts` `main()` — boots middleware + transport, listens on `PORT` (default 3000), logs the OAuth metadata URLs + the `/mcp` URL at startup for copy-paste into MCP Inspector. Graceful SIGTERM closes the pool.

7a. **Health check endpoint.** `GET /health` — returns `{ ok: true, version }` on a separate route from `/mcp`. Per the skill's deployment checklist, hosts poll a non-auth-gated health endpoint; don't mount it under the bearer-auth middleware.

8. **WorkOS dashboard setup checklist.** `docs/workos-setup.md`:
   - Create WorkOS account, create environment (one for dev, one for prod — we use dev for now).
   - Enable Google + Microsoft as social login providers.
   - Enable DCR + CIMD.
   - Configure redirect URIs:
     - `https://claude.ai/api/mcp/auth_callback` — **fixed Claude callback URL** for all Claude surfaces (Desktop, Code, claude.ai). Documented in `mcp-server-dev/references/auth.md`.
     - Whatever the MCP Inspector announces as its callback during DCR (Inspector self-registers; WorkOS accepts).
     - Localhost / tunnel URL for our own testing.
   - Copy `WORKOS_CLIENT_ID` + `WORKOS_API_KEY` + `WORKOS_ISSUER_URL` into `.env.local`.
   - Step-by-step with screenshots-as-prose so a future Claude session can re-do it without inventing.

9. **`.env.example` updated.** Add `WORKOS_API_KEY=`, `WORKOS_CLIENT_ID=`, `WORKOS_ISSUER_URL=`, `PUBLIC_BASE_URL=http://localhost:3000`, `PORT=3000`. Mark which are required for HTTP runner vs which only matter for stdio (none — stdio doesn't read these).

10. **Bootstrap helper extracted.** `src/db/seed-household.ts` (refactor from `src/db/bootstrap.ts`):
    - `seedHousehold(db, { id, country }): Promise<void>` — runs the household-row INSERT + seeds defaults. Used by both `npm run db:bootstrap` (one household from env) and `resolveHouseholdForClaims` (per first-login).
    - Existing `bootstrap.ts` becomes a thin wrapper.

11. **Tests.**
    - `src/auth/workos.test.ts` — pure-function tests for `verifyAccessToken` with mocked JWKS: valid token passes, expired throws `expired`, bad signature throws `invalid_signature`, wrong audience throws `invalid_audience`, malformed throws `malformed`. Mock the JWKS endpoint with `msw` or hand-rolled `nock`.
    - `src/auth/resolve-household.live.test.ts` — live DB. First call with new `sub` creates household + user; second call with same `sub` reuses. Race-condition test: two parallel `resolveHouseholdForClaims` calls with same fresh `sub` end up with exactly one household, both callers get the same `householdId`. Default-recipes seeded for DK.
    - `src/server-http.test.ts` — supertest against the HTTP app. Missing token → 401. Invalid token → 401. Valid token from user A → `get_household` returns A's household. Valid token from user B → returns B's household, not A's. The classic cross-tenant isolation test, repeated at the HTTP boundary.
    - `src/db/isolation.live.test.ts` (existing) — keep as-is; this stays the DB-level RLS guarantor.

12. **NPM scripts.**
    - `start`: stdio runner (unchanged from station 2).
    - `dev:http`: `tsx src/server-http.ts` with auto-reload (`tsx watch`).
    - `start:http`: production HTTP runner without watch.
    - `db:migrate` (unchanged) — picks up `0001_users.sql`.

13. **Docs.**
    - `README.md` Quick start: add "For multi-user / OAuth testing, see `docs/workos-setup.md` and run `npm run dev:http`".
    - `docs/workos-setup.md` — the checklist from deliverable #8.
    - `docs/auth-flow.md` (new) — sequence diagram (ascii-art is fine) showing: MCP client → our `/.well-known/...` → discovers WorkOS → DCR → user logs in via Google/MS → WorkOS issues code → client exchanges for JWT → client hits our `/mcp` with `Bearer` → we validate + resolve → tool runs with correct `household_id`. Future maintainers (and Claude sessions) shouldn't have to reverse-engineer this from the code.

14. **Alignment + roadmap sync** if execution surfaces shifts in core assumptions (e.g., if `StreamableHTTPServerTransport` turns out to require Fastify, or if WorkOS's JWT claims don't include what we expected). Otherwise leave alignment alone.

## Out of scope (explicit, pushed to later stations)

- **Production deploy of the HTTP server.** Station 4. For station 3, the HTTP server runs on `localhost:3000` exposed via `ngrok`/`cloudflared` tunnel for the Inspector and any external client that needs a stable URL. Production hosting (Railway, Fly, Render, etc.) is its own decision.
- **Claude Desktop end-to-end verification.** Per question above, MCP Inspector is the station-3 acceptance gate. Claude Desktop is the canonical client we'll target at deploy time (station 4) or onboarding-tool time (station 6) when first-touch UX matters.
- **Per-tool authorization scopes.** All authenticated requests get full access to their own household. No fine-grained scopes like "this token can only read pantry but not modify recipes". If we ever expose a read-only mode for a UI surface, that's a future addition; not now.
- **Service-role / cross-household admin operations.** A future cron job that aggregates across households for billing (station 10) will need `BYPASSRLS`. The `withoutTenant()` escape hatch already exists; a dedicated service-role Postgres user is a station 4/10 concern.
- **Multi-user-within-a-household.** Currently `users` is N:1 with `households` (each user belongs to one household). The data model supports N:N later (just add a join table) but the user-facing flow is "one Google account = one household" for station 3. Family-account-sharing is a post-launch feature.
- **Account deletion / data export (GDPR DSAR).** Required for public launch (station 11/12) but not for DM-launch. Note in `docs/gdpr-todo.md` so we don't forget.
- **Privacy policy + Terms of Service.** Required before public launch to disclose WorkOS as US-processor under DPF/SCCs (per `decisions/auth-provider.md` tradeoffs). Drafting belongs to pre-launch polish.
- **WorkOS Organizations / SSO / enterprise features.** Free tier includes them but we don't need them. Stay in single-org consumer-OAuth mode.
- **Token refresh handling on the client side.** That's the MCP client's job. WorkOS issues refresh tokens; the client (Inspector, Claude Desktop) stores + rotates. We just validate access tokens server-side.
- **Rate limiting per-user.** Defer to deploy-time middleware (station 4) or a future abuse-mitigation pass.

## Acceptance

- `npm run db:migrate` against a fresh local Postgres creates the new `users` table with the unique constraint on `workos_sub`. ✅
- `npm start` (stdio) continues to work exactly as it did at end of station 2 — env-var household, no WorkOS dependency, all 18 tools function. ✅
- `npm run dev:http` boots the HTTP server, logs OAuth metadata URLs, listens on `PORT`. ✅
- `curl http://localhost:3000/.well-known/oauth-authorization-server` returns valid RFC 8414 metadata with WorkOS authorize/token URLs and DCR + CIMD advertised (whichever WorkOS has enabled on the dashboard). ✅
- `curl http://localhost:3000/.well-known/oauth-protected-resource/mcp` returns valid RFC 9728 metadata (path-scoped to `/mcp` per the spec; the SDK router computes the path). ✅
- `POST /mcp` without `Authorization` header returns 401 with `WWW-Authenticate` pointing at our resource metadata. ✅
- `POST /mcp` with an expired/invalid token returns 401 with the right OAuth error code. ✅
- **Inspector flow (the canonical acceptance test):** `npx @modelcontextprotocol/inspector` opens UI on `localhost:6274` → select Streamable HTTP → paste `http://localhost:3000/mcp` (or tunnel URL) → Inspector discovers OAuth metadata at `/.well-known/oauth-protected-resource/mcp` → registers dynamically via DCR (or uses CIMD) → browser opens WorkOS hosted UI → "Sign in with Google" → returns to Inspector → Inspector lists all 18 tools → calling `get_household` returns *this Google account's* household, freshly seeded with default Danish recipes. ✅
- **Scripted Inspector smoke test:** `npx @modelcontextprotocol/inspector --cli http://localhost:3000/mcp --transport http --method tools/list` (with appropriate auth handling) returns the full tool list. ✅
- `GET /health` returns 200 with `{ ok: true, version }` and is **not** behind the bearer-auth middleware. ✅
- **First-login flow:** the very first time a never-seen `sub` hits the HTTP server, a new household row + user row are created in a single transaction, default recipes seeded if `country = DK`, and the call returns successfully. Re-running with same Google account returns the same household. ✅
- **Cross-tenant isolation at HTTP boundary:** two different WorkOS tokens (two different `sub` values) hit `get_household` concurrently — each gets only their own data. Verified by the new `src/server-http.test.ts` suite. ✅
- **All existing station-2 tests still pass.** No regression in the 242-test suite. ✅
- **New auth tests pass.** WorkOS JWT verification unit tests + identity-resolver live tests + HTTP isolation tests, all green. ✅
- `npm run typecheck` and `npm run lint` clean. ✅
- `docs/workos-setup.md` exists and a fresh contributor (or fresh Claude session) can follow it end-to-end without reading source code. ✅
- `docs/auth-flow.md` exists with the full sequence diagram. ✅
- Spec frozen during execution; any deltas land in journal + decision records, not in spec edits.

## Method

- **Schema first.** Write the `0001_users.sql` migration + extend Drizzle schema. Confirm RLS is off for `users` (and only `users`). Land this before any auth code so the resolver has a table to talk to.
- **Build the pure pieces before the wired ones.** `verifyAccessToken` is testable in isolation against a mocked JWKS — get it passing first. `resolveHouseholdForClaims` is testable against a live DB with mocked claims — get it passing next. Only then wire them into the HTTP middleware where iteration is slower.
- **Reuse the existing tenant chokepoint, don't fork it.** The store layer must not learn anything about HTTP, JWTs, or WorkOS. The new request-context layer (AsyncLocalStorage in `with-tenant.ts`) is the seam. Stdio runner doesn't set the AsyncLocalStorage → existing env-var fallback fires → no behavior change.
- **Use the SDK's first-party scaffolding; do not hand-roll OAuth plumbing.** Cross-checked against the installed SDK source (Explore-subagent report, 2026-05-24):
  - Transport: `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/streamableHttp`. `.handleRequest(req, res, parsedBody?)` is the entry point. Express integration is first-party.
  - HTTP app factory: `createMcpExpressApp()` from `@modelcontextprotocol/sdk/server/express` — gives DNS-rebinding protection.
  - Metadata endpoints: `mcpAuthMetadataRouter()` from `@modelcontextprotocol/sdk/server/auth/router` — mounts both `.well-known` endpoints with correct path-scoping.
  - Auth middleware: `requireBearerAuth()` from `@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth` — handles 401 + `WWW-Authenticate` for us.
  - Our verifier implements the `OAuthTokenVerifier` interface in `@modelcontextprotocol/sdk/server/auth/provider` and returns `AuthInfo` (from `auth/types`) with WorkOS claims tucked into `.extra`.
  - The only thing the SDK does *not* give us is per-request context propagation to the store layer — that's our `AsyncLocalStorage` in `with-tenant.ts` (deliverable #6).
- **DCR + CIMD: just config.** Both are toggles in the WorkOS dashboard + flags in our metadata JSON. Test that the Inspector sees both options. No code-level DCR implementation from us.
- **Tunneling.** Use `cloudflared tunnel --url http://localhost:3000` for the public URL when the Inspector needs HTTPS (some OAuth providers reject `http://` redirects in production-ish flows even on localhost). Document the exact command.
- **Subagent delegation.**
  - SDK surface confirmation: already done as part of spec co-write (Explore subagent, 2026-05-24 — findings folded into deliverables #2, #4, #5, #6).
  - One Explore subagent: read `mcp-use/mcp-oauth-workos-template` (public reference per `decisions/auth-provider.md`); report what they do, what's worth copying, and what's specific to their stack vs general.
  - One implementation subagent (or two parallel) once the spec is locked: schema + auth-pure-pieces in one, HTTP transport + middleware in the other. Both verified against their own tests before merging.
  - Code-review subagent on the final diff.

## Open questions delivered to station 4 (deploy)

- **Where the production HTTP server lives.** Compute provider (Railway / Fly / Render / Vercel / Cloudflare Workers, etc.). Affects the production redirect URI configured in WorkOS dashboard and the `PUBLIC_BASE_URL` env. Workers is the skill's fastest-path recommendation.
- **Production WORKOS_ environment.** We'll have a separate WorkOS environment for production with its own client ID. The dev/prod split is a deploy concern.
- **TLS termination + custom domain.** Provider-dependent. Whichever compute provider we pick will handle it.
- **Claude Desktop wrapping via `mcp-remote`.** Per `build-mcp-app` skill testing notes, current Desktop builds don't natively speak Streamable HTTP — they need `npx mcp-remote <url> --transport http-only` as a shim until Desktop ships native HTTP transport. Not blocking for station 3 (Inspector is our target) but the canonical Desktop test path for station 4.
- **Abuse protection.** `build-mcp-app/references/abuse-protection.md` is mainly about *authless* servers, so most of it doesn't apply to us (we have OAuth). The relevant carry-over: tiered per-replica token-bucket as a backstop, Anthropic egress CIDR allowlisting for IP-verifying real Claude clients vs random callers, `trust proxy` set correctly (one hop, never `true` in production). Station 4 / 11 hardening.

## Open questions delivered to station 6 (onboarding tool) and station 4+ (UI / MCP App)

- **First-login UX inside the agent conversation.** Station 3 just makes the OAuth round-trip work; what the agent says to the user during onboarding ("welcome, let's set up your household") happens in the onboarding-tool flow.
- **Profile-completeness post-auth.** WorkOS gives us `sub` + `email` + maybe `name`. The user's actual `people`, `country`, `stores` still need to be collected. That's `start_onboarding` territory.
- **Widget ↔ auth context.** Per `build-mcp-app` skill: widgets render in CSP-restricted iframes and **never hold the bearer token**. When a widget needs to call back to our server, it goes through `app.callServerTool({name, arguments})` — the **host** (Claude) is responsible for re-injecting the auth context on the server-bound call. Our `requireBearerAuth` middleware sees the host-forwarded token, not anything the widget chose. This is the security model we get for free; the spec just needs to honor it (no widget-specific auth bypass, no token leakage into UI resources). Surfaces in station 4 (first View) and station 9 (shopping-list View).

## Open questions delivered to station 11 (pre-launch polish)

- **Privacy policy + Terms of Service.** Must disclose WorkOS as US-processor under DPF/SCCs per `decisions/auth-provider.md`. Drafting is content work, not engineering.
- **Account deletion (GDPR DSAR).** Need a `delete_account` flow that removes the household row + cascades to meal_log / spend_log via FK + deletes the WorkOS user via their API + removes the row from our `users` table. Out of scope for station 3 but flagged in `docs/gdpr-todo.md`.
- **Rate limiting.** Per-user throttling on tool calls, especially the Tjek-API-hitting ones.

## Open questions surfaced during execution (resolve in-flight, document in decisions/ if material)

- **Exact WorkOS JWT claims shape.** Their docs describe `sub`, `email`, `org_id`. Whether `provider` is on the access token or only the ID token affects whether we need a second WorkOS API call per first-login. Cross-check with their `User Management` SDK during implementation.
- **JWKS caching strategy under JWKS rotation.** WorkOS rotates signing keys periodically. Standard pattern: cache by `kid`, refetch on miss. Confirm `jose`'s `createRemoteJWKSet` does the right thing or roll our own.
- **AsyncLocalStorage performance under load.** Not a concern at 5-10 users; flag if benchmarks at higher loads show it. Doubt it.
- **`StreamableHTTPServerTransport` session resumption semantics.** MCP supports SSE reconnect with `Last-Event-ID`; the transport already handles session-id continuity via the `mcp-session-id` header. Verify our middleware doesn't break that — `requireBearerAuth` runs per-request, so reconnects within the access token's TTL just re-validate the same token. The `onsessioninitialized` callback fires on first connect only.

## Sources consulted (not training memory)

- **`mcp-server-dev` plugin** (`/root/.claude/plugins/marketplaces/claude-plugins-official/plugins/mcp-server-dev/`):
  - `skills/build-mcp-server/SKILL.md` — phase-1 discovery, deployment-model matrix, framework + auth choice.
  - `skills/build-mcp-server/references/auth.md` — Claude-supported auth types, CIMD vs DCR (spec 2025-11-25 status), token storage, RFC 8707 audience validation, no-passthrough rule, SDK auth helpers.
  - `skills/build-mcp-server/references/remote-http-scaffold.md` — canonical Express+TS-SDK scaffold; stateless transport pattern; Inspector CLI commands; deployment checklist.
  - `skills/build-mcp-server/references/versions.md` — version pins verified 2026-03.
  - `skills/build-mcp-app/SKILL.md` — confirmed: widgets call back via `app.callServerTool`, never hold the bearer token; host mediates auth context for widget-initiated calls. Directory submission requires OAuth or authless. `mcp-remote` is the Claude Desktop test shim until Desktop ships native HTTP.
  - `skills/build-mcp-app/references/abuse-protection.md` — mostly authless-server concerns; the tiered token-bucket + Anthropic CIDR allowlist patterns carry forward to station 4 deploy hardening.
- **Installed `@modelcontextprotocol/sdk` source** (verified by Explore-subagent against `node_modules/`):
  - `server/streamableHttp` — transport API, stateless mode, session-header semantics.
  - `server/express` — `createMcpExpressApp()` with DNS-rebinding protection.
  - `server/auth/router` — `mcpAuthMetadataRouter()`, `getOAuthProtectedResourceMetadataUrl()`.
  - `server/auth/middleware/bearerAuth` — `requireBearerAuth()` middleware.
  - `server/auth/provider` — `OAuthTokenVerifier` interface contract.
  - `server/auth/types` — `AuthInfo` shape (with `.extra` for custom claims).
- **Decision records:** [`decisions/auth-provider.md`](../decisions/auth-provider.md), [`decisions/mcp-app-vs-classic-server.md`](../decisions/mcp-app-vs-classic-server.md), [`decisions/three-layer-tool-architecture.md`](../decisions/three-layer-tool-architecture.md).
- **Not yet consulted (in-flight during execution):** `mcp-use/mcp-oauth-workos-template` GitHub repo (per the auth-provider decision); WorkOS official docs page-by-page; `mcp-server-dev` plugin's `build-mcp-app` skill — relevant when station 4/5 work surfaces UI-resource concerns.

## Journal pointers

- Decision lock: [`workspace/decisions/auth-provider.md`](../decisions/auth-provider.md) (2026-05-24).
- Spec co-write: [`workspace/journal/2026-05-24.md`](../journal/2026-05-24.md) — `[auth-provider]` and (this session) `[station-3-spec]` H2s.
- Execution: subsequent dated journal entries as work proceeds.
- Prior context: [`workspace/specs/02-backend-domain-and-migration.md`](./02-backend-domain-and-migration.md) (the RLS chokepoint we're plugging auth into).
