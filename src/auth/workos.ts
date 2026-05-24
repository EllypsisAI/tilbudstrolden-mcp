/**
 * WorkOS access-token verifier.
 *
 * Implements the SDK's `OAuthTokenVerifier` interface so the bearer-auth
 * middleware (`requireBearerAuth`) can plug straight in. We are a *resource
 * server*: WorkOS mints tokens, we validate them. We never run the
 * authorize / token / introspect endpoints — those live on WorkOS.
 *
 * What this verifier asserts (in order):
 *   1. JWT is well-formed and signature verifies against the issuer's JWKS.
 *      Key rotation is handled by `jose`'s `createRemoteJWKSet` — it
 *      refetches on `kid` miss with a built-in cooldown.
 *   2. Issuer matches the configured WorkOS issuer URL.
 *   3. Audience (RFC 8707) matches our resource URL — i.e. the token was
 *      minted for *this* MCP server, not a different resource. The MCP auth
 *      playbook lists this as a MUST. Without it, a token issued for another
 *      service that happens to share the same WorkOS tenant could call us.
 *   4. Token has not expired (jose enforces `exp` automatically).
 *
 * What this verifier does NOT do:
 *   - Forward the token to upstream services. The "no token passthrough"
 *     rule from the auth playbook is enforced by simply not exposing the
 *     token after verification: only `AuthInfo.extra` (claims) leaves this
 *     module. If we ever need to call an upstream as the user, we use
 *     a token exchange — we never pass the access token through.
 *   - Validate scopes. We treat every authenticated request as "this user
 *     can act on their household, full stop" (see `decisions/auth-provider.md`).
 *     Per-tool scope gating is out of scope for station 3.
 */

import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  createRemoteJWKSet,
  type JWTPayload,
  type JWTVerifyGetKey,
  errors as joseErrors,
  jwtVerify,
} from "jose";

export interface WorkOSConfig {
  /** WorkOS issuer URL — e.g. `https://api.workos.com/user_management/<client_id>`. */
  issuerUrl: string;
  /** Our `WORKOS_CLIENT_ID`. Surfaced in `AuthInfo.clientId`. */
  clientId: string;
  /**
   * RFC 8707 resource identifier — the canonical URL clients send as the
   * `resource` parameter when requesting tokens for us, and which WorkOS
   * stamps into the `aud` claim. Must match the URL the MCP host uses to
   * reach `/mcp`.
   */
  resourceUrl: string;
}

export interface WorkOSClaims {
  /** Stable subject id (provider-prefixed by WorkOS). */
  workosSub: string;
  email?: string;
  /** Social provider hint, e.g. `google-oauth`, `microsoft-oauth`. */
  provider?: string;
  /** Full set of decoded JWT claims, for debugging/audit. */
  raw: JWTPayload;
}

/**
 * Errors thrown by the verifier. Extends the SDK's `InvalidTokenError` so the
 * SDK's `requireBearerAuth` middleware renders 401 + the right
 * `WWW-Authenticate` header. The `code` field is a sub-classification used
 * by our own tests and logs; the wire-level OAuth error code is always
 * `invalid_token` per RFC 6750 §3.1.
 */
export class TokenVerificationError extends InvalidTokenError {
  constructor(
    message: string,
    /**
     * Fine-grained reason. Useful for logs and for the test suite to assert
     * specific failure modes. RFC 6750 collapses these into one wire-level
     * `invalid_token` code on the response.
     */
    readonly code: "invalid_token" | "invalid_audience" | "expired_token" | "malformed_token",
  ) {
    super(message);
    this.name = "TokenVerificationError";
  }
}

/**
 * Build a `JWTVerifyGetKey` for production: fetches WorkOS's published
 * JWKS, caches keys by `kid`, refetches on miss with a cooldown.
 */
function defaultJwksFetcher(issuerUrl: string): JWTVerifyGetKey {
  // `createRemoteJWKSet` reads `<issuer>/.well-known/jwks.json` by default
  // when given the issuer base. WorkOS exposes its JWKS at
  // `https://api.workos.com/sso/jwks/<client_id>` historically and at the
  // OIDC-discovery-advertised location for AuthKit. We resolve it via the
  // explicit URL the caller passes through `WORKOS_JWKS_URL`, defaulting
  // to `<issuer>/.well-known/jwks.json`.
  const jwksUrl = process.env.WORKOS_JWKS_URL ?? new URL("/.well-known/jwks.json", issuerUrl).href;
  return createRemoteJWKSet(new URL(jwksUrl), {
    cacheMaxAge: 10 * 60 * 1000, // 10 min, matches spec.
    cooldownDuration: 30_000, // don't hammer JWKS on a flood of unknown kids
  });
}

export class WorkOSVerifier implements OAuthTokenVerifier {
  private constructor(
    private readonly cfg: WorkOSConfig,
    private readonly getKey: JWTVerifyGetKey,
  ) {}

  /** Production constructor — derives JWKS fetch from the issuer URL. */
  static fromConfig(cfg: WorkOSConfig): WorkOSVerifier {
    return new WorkOSVerifier(cfg, defaultJwksFetcher(cfg.issuerUrl));
  }

  /** Test constructor — accepts a pre-built `JWTVerifyGetKey`. */
  static withGetKey(cfg: WorkOSConfig, getKey: JWTVerifyGetKey): WorkOSVerifier {
    return new WorkOSVerifier(cfg, getKey);
  }

  /** Build a verifier from env vars. Throws if required ones are missing. */
  static fromEnv(): WorkOSVerifier {
    const issuerUrl = required("WORKOS_ISSUER_URL");
    const clientId = required("WORKOS_CLIENT_ID");
    const resourceUrl = required("PUBLIC_BASE_URL");
    return WorkOSVerifier.fromConfig({
      issuerUrl,
      clientId,
      // The token's `aud` is the full MCP resource path, not the bare host.
      resourceUrl: new URL("/mcp", resourceUrl).href,
    });
  }

  /**
   * Verify a bearer token. Returns the `AuthInfo` the SDK threads through
   * to downstream middleware. Throws `TokenVerificationError` on any
   * failure mode; the bearer-auth middleware converts that into a 401
   * with the right `WWW-Authenticate` header.
   */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    let payload: JWTPayload;
    try {
      const result = await jwtVerify(token, this.getKey, {
        issuer: this.cfg.issuerUrl,
        audience: this.cfg.resourceUrl,
      });
      payload = result.payload;
    } catch (err) {
      throw mapJoseError(err);
    }

    if (!payload.sub || typeof payload.sub !== "string") {
      throw new TokenVerificationError("Token is missing required `sub` claim", "malformed_token");
    }

    const scopes = extractScopes(payload);

    return {
      token,
      clientId: this.cfg.clientId,
      scopes,
      expiresAt: typeof payload.exp === "number" ? payload.exp : undefined,
      resource: new URL(this.cfg.resourceUrl),
      extra: {
        workos_sub: payload.sub,
        email: typeof payload.email === "string" ? payload.email : undefined,
        provider: typeof payload.provider === "string" ? payload.provider : undefined,
        raw: payload,
      } satisfies Record<string, unknown>,
    };
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.length === 0) {
    throw new Error(`Required env var ${name} is not set. See docs/workos-setup.md.`);
  }
  return value;
}

/**
 * OAuth 2.0 scope is a single space-delimited string per RFC 6749 §3.3.
 * Some IdPs emit it as an array under `scp` (Azure) or `scopes`. Cover all
 * three rather than fail closed on an IdP quirk.
 */
function extractScopes(payload: JWTPayload): string[] {
  if (typeof payload.scope === "string") {
    return payload.scope.split(/\s+/).filter((s) => s.length > 0);
  }
  if (Array.isArray(payload.scope)) {
    return payload.scope.filter((s): s is string => typeof s === "string");
  }
  const scp = (payload as Record<string, unknown>).scp;
  if (Array.isArray(scp)) {
    return scp.filter((s): s is string => typeof s === "string");
  }
  if (typeof scp === "string") {
    return scp.split(/\s+/).filter((s) => s.length > 0);
  }
  return [];
}

/**
 * Map `jose` errors to our `TokenVerificationError` taxonomy so callers
 * (mainly the bearer-auth middleware) can pick the right OAuth 2.0 error
 * code on 401 responses.
 */
export function mapJoseError(err: unknown): TokenVerificationError {
  if (err instanceof joseErrors.JWTExpired) {
    return new TokenVerificationError("Token has expired", "expired_token");
  }
  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    if (err.claim === "aud") {
      return new TokenVerificationError(
        `Token audience invalid for this server (${err.message})`,
        "invalid_audience",
      );
    }
    return new TokenVerificationError(
      `Token claim failed validation: ${err.message}`,
      "invalid_token",
    );
  }
  if (
    err instanceof joseErrors.JWSSignatureVerificationFailed ||
    err instanceof joseErrors.JWSInvalid ||
    err instanceof joseErrors.JWKSNoMatchingKey ||
    err instanceof joseErrors.JWKSMultipleMatchingKeys
  ) {
    return new TokenVerificationError(
      `Signature verification failed: ${err.message}`,
      "invalid_token",
    );
  }
  if (err instanceof joseErrors.JWTInvalid || err instanceof joseErrors.JOSEError) {
    return new TokenVerificationError(`Malformed token: ${err.message}`, "malformed_token");
  }
  if (err instanceof Error) {
    return new TokenVerificationError(`Token verification failed: ${err.message}`, "invalid_token");
  }
  return new TokenVerificationError("Token verification failed", "invalid_token");
}
