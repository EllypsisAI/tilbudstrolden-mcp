# Auth flow: how a request becomes a `household_id`

This document traces a single MCP request from the client's `tools/call` to the database row, naming the file at each step. Useful when chasing a bug or onboarding a fresh Claude session.

## The model

```
   MCP client (Claude, Inspector)
        │
        │ 1. discovery
        ▼
   /.well-known/oauth-protected-resource/mcp ─────────► WorkOS issuer URL
        │                                              │
        │ 2. DCR/CIMD register                         │ 3. user logs in (Google/MS)
        │                                              │
        ▼                                              ▼
   MCP client receives access_token (JWT)  ◄────────── WorkOS issues access_token (aud=<our>/mcp)
        │
        │ 4. POST /mcp with Authorization: Bearer <jwt>
        ▼
   ┌─────────────────────────────────────────────────────────────────┐
   │  server-http.ts                                                  │
   │                                                                  │
   │  Express                                                         │
   │   ├─ requireBearerAuth                                          │
   │   │    └─ WorkOSVerifier.verifyAccessToken                      │
   │   │         └─ jose.jwtVerify                                   │
   │   │              · signature (JWKS)                              │
   │   │              · issuer                                        │
   │   │              · audience (RFC 8707)                           │
   │   │              · exp                                           │
   │   │         → AuthInfo { extra: { workos_sub, email, ... } }     │
   │   │                                                              │
   │   ├─ householdMiddleware                                        │
   │   │    └─ resolveHouseholdForClaims                             │
   │   │         · lookup users.workos_sub → household_id            │
   │   │         · on miss: txn { seedHousehold + INSERT users }     │
   │   │    → runWithHousehold(householdId, () => next())           │
   │   │                                                              │
   │   └─ mcpRequestHandler                                          │
   │        · createMcpServer() — fresh instance                     │
   │        · StreamableHTTPServerTransport (stateless)              │
   │        · server.connect(transport)                              │
   │        · transport.handleRequest(req, res, req.body)            │
   │             │                                                    │
   │             ▼ tool callback runs                                │
   │                                                                  │
   │  store.getHousehold()                                           │
   │   └─ withAmbientTenant                                          │
   │        └─ ambientHouseholdId() reads from AsyncLocalStorage      │
   │             └─ withTenant(householdId, db => ...)                │
   │                  · BEGIN                                         │
   │                  · SET LOCAL app.household_id = <uuid>           │
   │                  · SELECT * FROM households                      │
   │                       (RLS filters: id = app.household_id)       │
   │                  · COMMIT                                        │
   └─────────────────────────────────────────────────────────────────┘
```

## Step-by-step

### 1. Discovery — client finds the authorization server

The MCP client fetches `GET /.well-known/oauth-protected-resource/mcp` from our server. This is the RFC 9728 metadata served by the SDK's `mcpAuthMetadataRouter` (see `src/server-http.ts:buildHttpApp`). The response tells the client:

```json
{
  "resource": "http://localhost:3000/mcp",
  "authorization_servers": ["https://api.workos.com/user_management/<id>"],
  "scopes_supported": ["openid", "profile", "email"],
  "resource_name": "TilbudsTrolden MCP"
}
```

The client follows `authorization_servers[0]` to discover the WorkOS metadata (which our server also re-publishes at `/.well-known/oauth-authorization-server`).

### 2. Dynamic Client Registration (DCR) or CIMD

The client registers itself with WorkOS (not with us). WorkOS issues a `client_id` and `client_secret`. We never see this round-trip — it happens directly between the client and WorkOS.

For CIMD-capable clients (newer Claude builds), the client publishes a metadata document URL instead of a stored client_id; WorkOS verifies it on each token request. Same outcome, different mechanism.

### 3. User login

The client opens a browser at WorkOS's `/authorize` URL with `resource=http://localhost:3000/mcp` (the RFC 8707 resource indicator — critical, because that's what becomes the `aud` claim).

WorkOS shows AuthKit's UI. User clicks "Sign in with Google" → consent screen → redirect back to the client's callback with an authorization code → client exchanges code for an access token (JWT).

The JWT WorkOS issues has these claims that matter to us:

- `iss` — WorkOS issuer URL
- `aud` — our resource URL (we configure WorkOS so it uses the requested `resource` param)
- `exp` — typically 15 minutes
- `sub` — stable provider-prefixed user ID (e.g. `workos|user_<id>`)
- `email`, `provider` — passed through from Google/Microsoft

### 4. MCP request

The client now sends every `POST /mcp` with `Authorization: Bearer <jwt>`.

### 5. Bearer middleware (`requireBearerAuth`)

`src/server-http.ts` mounts the SDK's `requireBearerAuth({ verifier, resourceMetadataUrl })` on `/mcp`. The middleware:

1. Pulls the bearer token out of the `Authorization` header.
2. Calls `WorkOSVerifier.verifyAccessToken(token)`.
3. On success, stamps `req.auth: AuthInfo` and calls `next()`.
4. On failure, returns 401 with `WWW-Authenticate: Bearer error="...", resource_metadata="<our PR url>"` per RFC 9728 §5.1.

### 6. Verifier (`WorkOSVerifier`)

`src/auth/workos.ts` calls `jose.jwtVerify(token, getKey, { issuer, audience })`. Failures throw `TokenVerificationError extends InvalidTokenError` so the bearer middleware can render the correct 401 shape.

What the verifier validates, in order:

1. JWT structure is parseable.
2. Signature verifies against the JWKS key matching the token's `kid`. `jose`'s `createRemoteJWKSet` caches keys and refetches on `kid`-miss.
3. `iss` matches our configured WorkOS issuer.
4. `aud` matches our resource URL (RFC 8707) — this is the MUST that the MCP auth playbook calls out.
5. `exp` is in the future.
6. `sub` is a non-empty string.

The returned `AuthInfo.extra` carries `{ workos_sub, email, provider, raw }`.

### 7. Household resolver middleware (`householdMiddleware`)

`src/server-http.ts:householdMiddleware` runs next. It:

1. Reads `req.auth.extra.workos_sub`.
2. Calls `resolveHouseholdForClaims(claims)`.
3. Wraps `next()` in `runWithHousehold(householdId, …)` so the downstream chain runs inside our `AsyncLocalStorage` scope.

### 8. Identity resolver (`resolveHouseholdForClaims`)

`src/auth/resolve-household.ts`. Two paths:

**Returning user.** `SELECT id, household_id FROM users WHERE workos_sub = $1` → return.

**First-time login.** Open a connection, BEGIN a transaction:

```sql
SET LOCAL app.household_id = <fresh-uuid>;
INSERT INTO households (id, ...) VALUES (<fresh-uuid>, ...);
INSERT INTO users (workos_sub, household_id, email, provider)
  VALUES (<sub>, <fresh-uuid>, ...)
  ON CONFLICT (workos_sub) DO NOTHING
  RETURNING id, household_id;
```

If RETURNING gives a row → COMMIT, done.

If RETURNING is empty → another concurrent first-login won the race. ROLLBACK (which also rolls back the fresh household — no orphan). Then re-fetch the winning user's household.

### 9. AsyncLocalStorage scope

`src/db/with-tenant.ts:runWithHousehold` wraps the downstream handler in an ALS store. Anything reading `ambientHouseholdId()` inside this scope — including every existing tool callback that calls `store.getHousehold()` etc — gets the resolved `householdId`. The stdio runner never enters this scope, so its `ambientHouseholdId()` falls back to the env var.

### 10. MCP request handler

`src/server-http.ts:mcpRequestHandler` creates a fresh `McpServer` (via `createMcpServer()` from `src/mcp-server.ts`), attaches a stateless `StreamableHTTPServerTransport`, and calls `transport.handleRequest(req, res, req.body)`. Inside the transport, the JSON-RPC dispatcher routes to the right tool callback.

### 11. Tool callback

Existing tool callbacks (e.g. the one for `get_household`) call `store.getHousehold()`. They have no idea HTTP or OAuth happened.

### 12. Store layer

`src/store.ts:getHousehold` calls `withAmbientTenant(db => ...)`. `withAmbientTenant` reads `ambientHouseholdId()` → gets the per-request `householdId` from ALS → calls `withTenant(householdId, fn)`.

### 13. `withTenant` chokepoint

`src/db/with-tenant.ts:withTenant`:

```ts
BEGIN
SELECT set_config('app.household_id', $1, true)  -- $1 = householdId
<your query>
COMMIT
```

Every RLS policy on `households`, `meal_log_entries`, `spend_log_entries` gates on `app.household_id`. The database itself filters the rows; the app can't leak data by forgetting a WHERE clause.

## How the stdio runner differs

The stdio runner (`src/server.ts`):

- Connects to the stdio transport, not Express.
- Never goes through `requireBearerAuth` or `householdMiddleware`.
- The AsyncLocalStorage scope is never entered.
- `ambientHouseholdId()` falls through to reading `TILBUDSTROLDEN_HOUSEHOLD_ID` from `process.env`.

So the stdio runner is single-tenant by construction — exactly what local dev needs.

## Failure modes

| Error | Cause | Where it surfaces |
|---|---|---|
| 401 + `WWW-Authenticate` with `error="invalid_token"` | Token invalid / wrong audience / wrong signature | `requireBearerAuth` after `verifyAccessToken` throws |
| 401 + `WWW-Authenticate` with `Token has expired` | Token expired between mint and request | Same as above, jose's `JWTExpired` |
| 401 + `error="invalid_token"` with `error_description="Missing Authorization header"` | No bearer token at all | `requireBearerAuth` first guard |
| 500 with `internal_error` | Resolver threw (DB down, etc.) | Express error handler downstream of `householdMiddleware` |
| Tool returns "No household context. …" | Code path bypassed `runWithHousehold` (shouldn't happen — but defensive guard fires) | `ambientHouseholdId()` throw |
| 0 rows returned where rows expected | Wrong household_id in `app.household_id` — bug | RLS policies silently filter; check the request's `req.auth.extra.workos_sub` |

## Cross-references

- Decision: [`workspace/decisions/auth-provider.md`](../workspace/decisions/auth-provider.md)
- Spec: [`workspace/specs/03-auth-and-multi-user-identity.md`](../workspace/specs/03-auth-and-multi-user-identity.md)
- SDK auth primitives: `@modelcontextprotocol/sdk/server/auth/{provider,router,middleware/bearerAuth}.d.ts`
- The acceptance test that proves this works end-to-end: `src/server-http.live.test.ts`
