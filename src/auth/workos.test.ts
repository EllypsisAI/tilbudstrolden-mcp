/**
 * Pure-function tests for `WorkOSVerifier`.
 *
 * No live WorkOS. We generate an ephemeral key pair with `jose`, build a
 * `JWTVerifyGetKey` that returns the public key directly (skipping the
 * remote JWKS fetch), then sign tokens with the corresponding private key.
 * Every assertion exercises a discrete branch of the verifier logic.
 */

import { exportJWK, generateKeyPair, errors as joseErrors, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { TokenVerificationError, WorkOSVerifier } from "./workos.js";

const ISSUER = "https://example-workos.test/oauth";
const CLIENT_ID = "client_test_abc";
const RESOURCE = "http://localhost:3000/mcp";

let privateKey: CryptoKey;
let publicKey: CryptoKey;

/**
 * Build a verifier wired to our test public key. The `JWTVerifyGetKey`
 * always returns the same public key — production uses
 * `createRemoteJWKSet` which fetches from WorkOS by `kid`.
 */
function makeVerifier(): WorkOSVerifier {
  return WorkOSVerifier.withGetKey(
    { issuerUrl: ISSUER, clientId: CLIENT_ID, resourceUrl: RESOURCE },
    async () => publicKey,
  );
}

async function signToken(
  claims: Record<string, unknown>,
  opts: { exp?: number } = {},
): Promise<string> {
  const builder = new SignJWT({
    sub: "workos|user_abc123",
    email: "alice@example.com",
    provider: "google-oauth",
    scope: "openid profile email",
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
    .setIssuer(ISSUER)
    .setAudience(RESOURCE)
    .setIssuedAt();
  if (opts.exp !== undefined) {
    builder.setExpirationTime(opts.exp);
  } else {
    builder.setExpirationTime("5m");
  }
  return builder.sign(privateKey);
}

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  publicKey = pair.publicKey;
});

describe("WorkOSVerifier", () => {
  it("accepts a valid token and threads WorkOS claims onto AuthInfo.extra", async () => {
    const token = await signToken({});
    const auth = await makeVerifier().verifyAccessToken(token);

    expect(auth.token).toBe(token);
    expect(auth.clientId).toBe(CLIENT_ID);
    expect(auth.scopes).toEqual(["openid", "profile", "email"]);
    expect(auth.resource?.href).toBe(RESOURCE);
    expect(auth.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));

    expect(auth.extra?.workos_sub).toBe("workos|user_abc123");
    expect(auth.extra?.email).toBe("alice@example.com");
    expect(auth.extra?.provider).toBe("google-oauth");
    // `raw` is the full JWTPayload — confirm the sub round-trips so callers
    // can audit other claims without a re-decode.
    expect((auth.extra?.raw as { sub?: string })?.sub).toBe("workos|user_abc123");
  });

  it("rejects an expired token with the right error code", async () => {
    // Sign with exp set to two seconds in the past. `setExpirationTime`
    // accepts a Unix timestamp number directly.
    const token = await signToken({}, { exp: Math.floor(Date.now() / 1000) - 2 });
    try {
      await makeVerifier().verifyAccessToken(token);
      throw new Error("expected verifier to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TokenVerificationError);
      expect((err as TokenVerificationError).code).toBe("expired_token");
    }
  });

  it("rejects a token signed with a different key as invalid_token", async () => {
    const wrongPair = await generateKeyPair("RS256", { extractable: true });
    const verifier = WorkOSVerifier.withGetKey(
      { issuerUrl: ISSUER, clientId: CLIENT_ID, resourceUrl: RESOURCE },
      // Hand back a public key that doesn't match the private key we sign with.
      async () => wrongPair.publicKey,
    );
    const token = await signToken({});
    try {
      await verifier.verifyAccessToken(token);
      throw new Error("expected verifier to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TokenVerificationError);
      expect((err as TokenVerificationError).code).toBe("invalid_token");
    }
  });

  it("rejects a token whose audience does not match the resource (RFC 8707)", async () => {
    // Build a token whose `aud` points at a different MCP server. The
    // verifier MUST refuse it — otherwise a token issued for another
    // resource server in the same WorkOS tenant could call us.
    const builder = new SignJWT({
      sub: "workos|user_abc123",
      email: "alice@example.com",
      provider: "google-oauth",
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
      .setIssuer(ISSUER)
      .setAudience("http://other-mcp.test/mcp")
      .setIssuedAt()
      .setExpirationTime("5m");
    const token = await builder.sign(privateKey);

    try {
      await makeVerifier().verifyAccessToken(token);
      throw new Error("expected verifier to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TokenVerificationError);
      expect((err as TokenVerificationError).code).toBe("invalid_audience");
    }
  });

  it("rejects a token whose issuer does not match", async () => {
    const builder = new SignJWT({
      sub: "workos|user_abc123",
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
      .setIssuer("https://wrong-issuer.test")
      .setAudience(RESOURCE)
      .setIssuedAt()
      .setExpirationTime("5m");
    const token = await builder.sign(privateKey);

    try {
      await makeVerifier().verifyAccessToken(token);
      throw new Error("expected verifier to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TokenVerificationError);
      // `iss` mismatch surfaces as JWTClaimValidationFailed → invalid_token
      expect((err as TokenVerificationError).code).toBe("invalid_token");
    }
  });

  it("rejects a malformed token string", async () => {
    try {
      await makeVerifier().verifyAccessToken("not.a.jwt");
      throw new Error("expected verifier to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TokenVerificationError);
      // jose throws JWSInvalid / JWTInvalid → invalid_token or malformed_token
      expect(["invalid_token", "malformed_token"]).toContain((err as TokenVerificationError).code);
    }
  });

  it("rejects a token missing the `sub` claim", async () => {
    // Sign WITHOUT setting `sub`. The jose library accepts it (sub is
    // optional in the spec), but our verifier requires it.
    const builder = new SignJWT({ email: "alice@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
      .setIssuer(ISSUER)
      .setAudience(RESOURCE)
      .setIssuedAt()
      .setExpirationTime("5m");
    const token = await builder.sign(privateKey);
    try {
      await makeVerifier().verifyAccessToken(token);
      throw new Error("expected verifier to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TokenVerificationError);
      expect((err as TokenVerificationError).code).toBe("malformed_token");
    }
  });

  it("handles tokens that emit scopes as `scp` array (Azure-style)", async () => {
    // Some IdPs (Microsoft) emit scopes as an array under `scp` rather
    // than a space-delimited `scope` string. The verifier covers both.
    const builder = new SignJWT({
      sub: "workos|user_abc123",
      scp: ["openid", "profile"],
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
      .setIssuer(ISSUER)
      .setAudience(RESOURCE)
      .setIssuedAt()
      .setExpirationTime("5m");
    const token = await builder.sign(privateKey);
    const auth = await makeVerifier().verifyAccessToken(token);
    expect(auth.scopes).toEqual(["openid", "profile"]);
  });

  it("returns empty scopes when neither `scope` nor `scp` are present", async () => {
    // Many access tokens omit `scope` entirely; the verifier should not
    // throw — scope enforcement is a separate concern.
    const builder = new SignJWT({ sub: "workos|user_abc123" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
      .setIssuer(ISSUER)
      .setAudience(RESOURCE)
      .setIssuedAt()
      .setExpirationTime("5m");
    const token = await builder.sign(privateKey);
    const auth = await makeVerifier().verifyAccessToken(token);
    expect(auth.scopes).toEqual([]);
  });
});

describe("WorkOSVerifier — exported types and shape", () => {
  it("publicKey can be exported as JWK (sanity check on key generation)", async () => {
    // Just confirms the test setup is sane — exportJWK on the public key
    // succeeds and produces a kty=RSA entry. If this ever breaks we know
    // the test infrastructure shifted, not the verifier.
    const jwk = await exportJWK(publicKey);
    expect(jwk.kty).toBe("RSA");
  });

  it("re-exports the jose error taxonomy used internally", () => {
    // Smoke test the dependency surface so a jose major-version bump
    // that renames JWTExpired surfaces as a failing test, not a runtime
    // 500 the day we ship.
    expect(joseErrors.JWTExpired).toBeDefined();
    expect(joseErrors.JWTClaimValidationFailed).toBeDefined();
    expect(joseErrors.JWSSignatureVerificationFailed).toBeDefined();
  });
});
