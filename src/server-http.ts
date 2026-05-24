/**
 * Streamable-HTTP entry point with WorkOS OAuth.
 *
 * Runs on `PORT` (default 3000). Endpoints:
 *
 *   GET  /health
 *     Liveness probe. Returns `{ ok: true, version }`. Not behind auth so
 *     load balancers / uptime monitors can poll without credentials.
 *
 *   GET  /.well-known/oauth-authorization-server   (via SDK router)
 *     RFC 8414 — clients use this to discover WorkOS as the authorization
 *     server, including the DCR + CIMD registration endpoints WorkOS
 *     advertises on its dashboard.
 *
 *   GET  /.well-known/oauth-protected-resource/mcp (via SDK router)
 *     RFC 9728 — clients use this to discover *us* as the resource server
 *     and learn which AS to talk to. Path-scoped to `/mcp` per the spec.
 *
 *   POST /mcp
 *     MCP JSON-RPC. Stateless — a fresh `McpServer` + transport pair per
 *     request. Bearer-authenticated; the JWT's `sub` is mapped to a
 *     `household_id` and installed via `AsyncLocalStorage` for the
 *     duration of the handler. Existing tools see the right tenant
 *     without any per-tool change.
 *
 *   GET  /mcp
 *     Server-Sent Events stream for server-initiated notifications.
 *     Also stateless + authenticated.
 *
 *   DELETE /mcp
 *     Session termination, also passed through to the transport per SDK
 *     conventions (no-op in stateless mode but kept for client compat).
 *
 * Non-goals (station 4 / deploy):
 *   - Production reverse-proxy config (TLS, `trust proxy`, real CORS).
 *   - Per-user rate limiting.
 *   - Persistent session resumption — stateless mode doesn't need it
 *     because the client re-auths each request anyway.
 */

import { createRequire } from "node:module";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { OAuthMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { OAuthMetadataSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import type express from "express";
import type { Request, RequestHandler, Response } from "express";
import { resolveHouseholdForClaims } from "./auth/resolve-household.js";
import type { WorkOSClaims } from "./auth/workos.js";
import { WorkOSVerifier } from "./auth/workos.js";
import { closePool } from "./db/client.js";
import { loadEnv } from "./db/env.js";
import { runWithHousehold } from "./db/with-tenant.js";
import { createMcpServer } from "./mcp-server.js";

const requireCjs = createRequire(import.meta.url);
const { version: SERVER_VERSION } = requireCjs("../package.json") as { version: string };

interface HttpConfig {
  port: number;
  host: string;
  publicBaseUrl: string;
  workosIssuerUrl: string;
  workosClientId: string;
}

function readConfig(): HttpConfig {
  loadEnv();
  const port = Number(process.env.PORT ?? "3000");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT must be a positive integer; got "${process.env.PORT}"`);
  }
  const host = process.env.HOST ?? "127.0.0.1";
  const publicBaseUrl = required("PUBLIC_BASE_URL");
  const workosIssuerUrl = required("WORKOS_ISSUER_URL");
  const workosClientId = required("WORKOS_CLIENT_ID");
  return { port, host, publicBaseUrl, workosIssuerUrl, workosClientId };
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(`Required env var ${name} is not set. See docs/workos-setup.md.`);
  }
  return v;
}

/**
 * Fetch WorkOS's OAuth 2.0 Authorization Server Metadata so we can re-publish
 * it under our own `/.well-known/oauth-authorization-server`. Clients that
 * discover our resource metadata first will follow the link to WorkOS; this
 * mirror exists so clients that only know how to look at the protected
 * resource still get a working AS discovery path.
 *
 * Cached forever — the WorkOS issuer URL changes only when our config
 * changes, at which point the process restarts.
 */
export async function fetchAuthorizationServerMetadata(issuerUrl: string): Promise<OAuthMetadata> {
  const url = new URL("/.well-known/oauth-authorization-server", issuerUrl).href;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(
      `Failed to fetch WorkOS authorization-server metadata from ${url}: ${res.status} ${res.statusText}`,
    );
  }
  const json = await res.json();
  // Validate shape against the SDK's schema so we fail at boot, not at
  // first request from a real client.
  return OAuthMetadataSchema.parse(json);
}

/**
 * Express middleware: turn validated `req.auth` into a household scope.
 * Must run AFTER `requireBearerAuth`. Wraps the *response* in
 * `runWithHousehold` so the SDK transport handler — and every tool callback
 * it invokes — sees the right tenant.
 */
export function householdMiddleware(): RequestHandler {
  return (req, res, next) => {
    if (!req.auth) {
      // requireBearerAuth would have rejected; defensive guard.
      res.status(401).json({ error: "invalid_token", error_description: "Missing auth context" });
      return;
    }
    const claims = extractClaims(req.auth.extra);
    if (!claims) {
      res
        .status(401)
        .json({ error: "invalid_token", error_description: "Token missing required claims" });
      return;
    }
    // Resolve identity → tenant, then install the household scope for the
    // duration of the downstream handler chain.
    resolveHouseholdForClaims(claims).then(
      ({ householdId }) => {
        runWithHousehold(householdId, () => {
          next();
        });
      },
      (err) => {
        // Resolve failure (DB down, unique race that couldn't be resolved).
        // Surface as 500 — this isn't an auth failure, it's an infra failure.
        next(err);
      },
    );
  };
}

function extractClaims(extra: Record<string, unknown> | undefined): WorkOSClaims | null {
  if (!extra) return null;
  const workosSub = extra.workos_sub;
  if (typeof workosSub !== "string" || workosSub.length === 0) return null;
  return {
    workosSub,
    email: typeof extra.email === "string" ? extra.email : undefined,
    provider: typeof extra.provider === "string" ? extra.provider : undefined,
    raw: (extra.raw as WorkOSClaims["raw"]) ?? {},
  };
}

interface BuildAppOptions {
  /** Verifier used by `requireBearerAuth`. Tests inject a stub. */
  verifier: WorkOSVerifier;
  /** OAuth metadata to advertise at `/.well-known/oauth-authorization-server`. */
  oauthMetadata: OAuthMetadata;
  /** Public URL the resource is reachable at — e.g. `http://localhost:3000`. */
  publicBaseUrl: string;
  /** Bind host. Drives DNS-rebinding protection in `createMcpExpressApp`. */
  host?: string;
  /** Override the household-resolution middleware (for tests). */
  resolveMiddleware?: RequestHandler;
}

/**
 * Wire the Express app exactly as production runs it. Exported so tests
 * can drive the full middleware stack through `supertest`.
 */
export function buildHttpApp(opts: BuildAppOptions): express.Express {
  const app = createMcpExpressApp({ host: opts.host ?? "127.0.0.1" });

  // /health — never behind auth.
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true, version: SERVER_VERSION });
  });

  const resourceServerUrl = new URL("/mcp", opts.publicBaseUrl);
  app.use(
    mcpAuthMetadataRouter({
      oauthMetadata: opts.oauthMetadata,
      resourceServerUrl,
      scopesSupported: ["openid", "profile", "email"],
      resourceName: "TilbudsTrolden MCP",
    }),
  );

  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceServerUrl);
  const auth = requireBearerAuth({
    verifier: opts.verifier,
    resourceMetadataUrl,
  });
  const householdResolver = opts.resolveMiddleware ?? householdMiddleware();

  app.post("/mcp", auth, householdResolver, mcpRequestHandler);
  app.get("/mcp", auth, householdResolver, mcpRequestHandler);
  app.delete("/mcp", auth, householdResolver, mcpRequestHandler);

  return app;
}

/**
 * Per-request handler: spin up a fresh `McpServer` + stateless transport,
 * connect them, hand the request to the transport. Both close on response
 * end so we don't leak event listeners.
 */
async function mcpRequestHandler(req: Request, res: Response): Promise<void> {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    // Best-effort cleanup; transport.close() is idempotent.
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    // The transport may have already written headers — only respond if we
    // can. Either way, log so we don't lose the failure.
    console.error("MCP request handler failed:", err);
    if (!res.headersSent) {
      res.status(500).json({
        error: "internal_error",
        error_description: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function main(): Promise<void> {
  const cfg = readConfig();
  const verifier = WorkOSVerifier.fromConfig({
    issuerUrl: cfg.workosIssuerUrl,
    clientId: cfg.workosClientId,
    resourceUrl: new URL("/mcp", cfg.publicBaseUrl).href,
  });
  const oauthMetadata = await fetchAuthorizationServerMetadata(cfg.workosIssuerUrl);

  const app = buildHttpApp({
    verifier,
    oauthMetadata,
    publicBaseUrl: cfg.publicBaseUrl,
    host: cfg.host,
  });

  const server = app.listen(cfg.port, cfg.host, () => {
    const base = cfg.publicBaseUrl.replace(/\/$/, "");
    console.log(`TilbudsTrolden MCP HTTP server v${SERVER_VERSION}`);
    console.log(`  Listening:    http://${cfg.host}:${cfg.port}`);
    console.log(`  Public base:  ${base}`);
    console.log(`  MCP endpoint: ${base}/mcp`);
    console.log(`  AS metadata:  ${base}/.well-known/oauth-authorization-server`);
    console.log(`  PR metadata:  ${base}/.well-known/oauth-protected-resource/mcp`);
    console.log(`  Health:       ${base}/health`);
  });

  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}, shutting down`);
    server.close(() => {
      void closePool().then(() => process.exit(0));
    });
    // Hard exit after 10s if graceful shutdown stalls.
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// Allow `tsx src/server-http.ts` as a CLI.
import { fileURLToPath } from "node:url";

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().catch((err) => {
    console.error("Failed to start HTTP server:", err);
    process.exit(1);
  });
}
