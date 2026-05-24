# WorkOS setup for the HTTP runner

The stdio runner (`npm start`) does not use WorkOS — it reads `TILBUDSTROLDEN_HOUSEHOLD_ID` from `.env.local` and runs single-tenant. This document is only for setting up the multi-user **HTTP runner** (`npm run dev:http`).

The decision to use WorkOS AuthKit is recorded in [`workspace/decisions/auth-provider.md`](../workspace/decisions/auth-provider.md). This file is the operational checklist; the decision file is the why.

## 1. Create a WorkOS account

1. Go to https://workos.com and sign up. The free tier covers up to 1M MAU which is well above anything we'll hit before DM-launch.
2. Inside the dashboard, you start in the **Sandbox environment**. That's fine for dev — keep it. We'll create a separate `Production` environment at deploy time (station 4).
3. In the left nav, open the **AuthKit** product. It is enabled by default; if not, click "Set up AuthKit".

## 2. Configure social providers

Under **Authentication → Social Providers**:

1. Enable **Google OAuth**. WorkOS provides shared dev credentials out of the box — fine for sandbox. For production you'll register your own Google OAuth client.
2. Enable **Microsoft OAuth** the same way.
3. Save.

You do NOT need to enable email/password, magic links, SSO, or any other method — Google + Microsoft cover all our DM-launch users.

## 3. Configure redirect URIs

Under **Configuration → Redirects**:

Add the following URIs:

- `https://claude.ai/api/mcp/auth_callback` — the canonical Claude callback for **all** Claude surfaces (Desktop, Code, claude.ai). Documented in the `mcp-server-dev` Claude Code skill's `references/auth.md`.
- The MCP Inspector's callback. When you click "Connect" in the Inspector against an OAuth-protected server it self-registers via DCR and announces its own callback URL — typically `http://localhost:6274/oauth/callback/debug` (the exact path may shift between Inspector versions). Watch your dev console; the first DCR attempt will print what it tried to register.
- `http://localhost:PORT/auth/callback` for any other local OAuth tool you use.
- Your `cloudflared`/`ngrok` tunnel URL while testing — e.g. `https://<random>.trycloudflare.com/auth/callback`. This needs to be updated each time the tunnel restarts unless you use a named tunnel.

## 4. Enable Dynamic Client Registration + CIMD

Under **Configuration → Authentication**:

1. **Dynamic Client Registration (RFC 7591)** — enable it. This lets MCP clients (Inspector, Claude Desktop) register themselves without you provisioning a client ID manually.
2. **Client ID Metadata Documents (CIMD)** — enable it if available. CIMD is the spec successor to DCR (per MCP 2025-11-25), and WorkOS supports it via the AuthKit dashboard.

If you don't see CIMD as an option, that's fine — DCR alone is enough for current MCP clients. CIMD becomes important once Claude rolls out the newer flow.

## 5. Copy credentials into `.env.local`

In the WorkOS dashboard under **API Keys**:

1. Copy the **Client ID** → set `WORKOS_CLIENT_ID` in `.env.local`.
2. Copy the **Issuer URL** (in AuthKit settings, sometimes labeled "Endpoint" or "API Hostname") → set `WORKOS_ISSUER_URL`. It typically looks like `https://api.workos.com/user_management/<unique-id>` or your custom AuthKit domain.

Set the rest:

```env
PUBLIC_BASE_URL=http://localhost:3000
PORT=3000
HOST=127.0.0.1
```

Replace `PUBLIC_BASE_URL` with your tunnel URL when testing from a remote client (Inspector, Claude Desktop). MCP clients reject `http://` redirects to non-localhost hosts; for any non-localhost test you need HTTPS via a tunnel.

You do NOT need `WORKOS_API_KEY` — that's for server-to-WorkOS API calls (we make none in station 3). Tokens are validated against the JWKS, not the introspection endpoint.

## 6. Boot the HTTP runner

```bash
npm run db:up       # local Postgres
npm run db:migrate  # apply 0000_initial + 0001_users
npm run dev:http    # boots on PUBLIC_BASE_URL
```

You should see:

```
TilbudsTrolden MCP HTTP server v<version>
  Listening:    http://127.0.0.1:3000
  Public base:  http://localhost:3000
  MCP endpoint: http://localhost:3000/mcp
  AS metadata:  http://localhost:3000/.well-known/oauth-authorization-server
  PR metadata:  http://localhost:3000/.well-known/oauth-protected-resource/mcp
  Health:       http://localhost:3000/health
```

If you see "Failed to fetch WorkOS authorization-server metadata" at boot, the issuer URL is wrong or unreachable. Double-check `WORKOS_ISSUER_URL` — it must be the bare host root, not the `/authorize` path.

## 7. Verify with MCP Inspector

```bash
npx @modelcontextprotocol/inspector
```

In the Inspector UI (default at http://localhost:6274):

1. Choose **Streamable HTTP** as the transport.
2. Paste your `/mcp` URL — `http://localhost:3000/mcp` for local-only, or your tunnel URL for remote-like testing.
3. Click **Connect**. The Inspector discovers `/.well-known/oauth-protected-resource/mcp`, then `/.well-known/oauth-authorization-server`, then registers itself via DCR with WorkOS.
4. A browser tab opens with the WorkOS AuthKit login page. Sign in with Google or Microsoft.
5. After redirect, the Inspector reports "Connected" and lists 18 tools.
6. Call `get_household` — you should see a freshly seeded household with default Danish recipes.

If anything fails, check the Inspector's `Network` panel for the OAuth round-trip, and check the HTTP runner's stdout for verification errors.

## 8. Production cutover (station 4)

Not part of station 3, but on the agenda:

- Create a separate **Production** environment in WorkOS dashboard.
- Register your own Google + Microsoft OAuth clients (don't ship with WorkOS's shared dev credentials).
- Add production redirect URIs (`https://claude.ai/api/mcp/auth_callback` is already canonical).
- Set the production `WORKOS_ISSUER_URL` + `WORKOS_CLIENT_ID` in your compute provider's env.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| 500 at boot with "Failed to fetch WorkOS authorization-server metadata" | `WORKOS_ISSUER_URL` is wrong or unreachable | Verify the URL works in a browser. It should return JSON. |
| 401 on every `/mcp` request even with a fresh token | Audience mismatch — token was minted for a different resource | Confirm Inspector / Claude passes `resource=<your-public-url>/mcp` in the token request. WorkOS uses that as `aud`. |
| 401 with "Token has expired" immediately | Token expired between mint and request | Refresh the client; the verifier honours `exp` strictly. |
| DCR fails with "redirect_uri not allowed" | Missing redirect URI in WorkOS dashboard | Add the URI under Configuration → Redirects. |
| MCP Inspector connects but tools/list is empty | Bearer auth chain succeeded but household resolver threw | Check stdout — likely a Postgres connectivity or migration issue. |
