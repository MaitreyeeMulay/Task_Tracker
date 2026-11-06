import { createHash, createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { finishOidcLogin, startOidcLogin, type OidcSettings } from "../../src/auth/oidc.ts";

// M5: OIDC for production, tested end to end against a fake identity provider
// running in this process: discovery, JWKS, token endpoint, RS256 ID tokens,
// PKCE and nonce checks. Only existing users can sign in (no self-signup).

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
const CLIENT_ID = "tracker";
const CLIENT_SECRET = "fake-client-secret-for-tests-only";

let pool: pg.Pool;
let server: Server;
let issuer: string;
// What the fake provider will put in the next ID token.
let nextClaims: Record<string, unknown> = {};
// code -> PKCE challenge, as an authorization server would remember it.
const codes = new Map<string, { challenge: string; nonce: string }>();

const b64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");
function signJwt(claims: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" }));
  const body = b64url(JSON.stringify(claims));
  return `${header}.${body}.${createSign("RSA-SHA256").update(`${header}.${body}`).sign(privateKey).toString("base64url")}`;
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: inject("testDatabaseUrl"), max: 4 });
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", issuer);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/openid-configuration") {
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.pathname === "/jwks") return json(200, { keys: [JWK] });
    if (url.pathname === "/token" && req.method === "POST") {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString()));
      req.on("end", () => {
        const form = new URLSearchParams(raw);
        const grant = codes.get(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        if (!grant || b64url(createHash("sha256").update(verifier).digest()) !== grant.challenge) {
          return json(400, { error: "invalid_grant" });
        }
        const now = Math.floor(Date.now() / 1000);
        return json(200, {
          access_token: "at",
          token_type: "Bearer",
          expires_in: 300,
          id_token: signJwt({ iss: issuer, aud: CLIENT_ID, iat: now, exp: now + 300, nonce: grant.nonce, ...nextClaims }),
        });
      });
      return;
    }
    json(404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

const settings = (): OidcSettings => ({
  issuer,
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  redirectUri: "http://localhost:3000/auth/oidc/callback",
  allowInsecureForTests: true,
});

/** Plays the browser + provider: start, "log in" at the provider, come back with a code. */
async function loginAs(claims: Record<string, unknown>, tamper?: (callback: URL) => void) {
  const started = await startOidcLogin(settings());
  const auth = new URL(started.authorizationUrl);
  expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
  const code = randomUUID();
  codes.set(code, { challenge: auth.searchParams.get("code_challenge") ?? "", nonce: auth.searchParams.get("nonce") ?? "" });
  nextClaims = claims;
  const callback = new URL(settings().redirectUri);
  callback.searchParams.set("code", code);
  callback.searchParams.set("state", auth.searchParams.get("state") ?? "");
  tamper?.(callback);
  return finishOidcLogin(pool, settings(), { callbackUrl: callback, flow: started.flow });
}

async function seedUser(email: string): Promise<string> {
  return (await pool.query("INSERT INTO users (email, display_name) VALUES ($1, 'O') RETURNING id", [email])).rows[0].id;
}

describe("OIDC login", () => {
  it("signs in an existing user by verified email, and links their subject for next time", async () => {
    const email = `o-${randomUUID().slice(0, 8)}@oidc.test`;
    const id = await seedUser(email);
    const sub = `sub-${randomUUID()}`;
    expect(await loginAs({ sub, email, email_verified: true })).toEqual({ ok: true, userId: id });
    // Next time the subject alone is enough, even if the email changed at the provider.
    expect(await loginAs({ sub, email: "changed@elsewhere.test", email_verified: true })).toEqual({ ok: true, userId: id });
  });

  it("refuses an unknown user (no self-signup)", async () => {
    expect(await loginAs({ sub: `sub-${randomUUID()}`, email: "stranger@oidc.test", email_verified: true })).toEqual({ ok: false, error: "not_invited" });
  });

  it("refuses to link by an unverified email", async () => {
    const email = `u-${randomUUID().slice(0, 8)}@oidc.test`;
    await seedUser(email);
    expect(await loginAs({ sub: `sub-${randomUUID()}`, email, email_verified: false })).toEqual({ ok: false, error: "not_invited" });
  });

  it("refuses a callback whose state does not match (login CSRF)", async () => {
    const email = `s-${randomUUID().slice(0, 8)}@oidc.test`;
    await seedUser(email);
    const result = await loginAs({ sub: "x", email, email_verified: true }, (cb) => cb.searchParams.set("state", "attacker-state"));
    expect(result).toEqual({ ok: false, error: "invalid_response" });
  });

  it("refuses a code that the provider rejects (wrong PKCE verifier or replayed code)", async () => {
    const email = `p-${randomUUID().slice(0, 8)}@oidc.test`;
    await seedUser(email);
    const result = await loginAs({ sub: "x", email, email_verified: true }, (cb) => cb.searchParams.set("code", "not-a-real-code"));
    expect(result).toEqual({ ok: false, error: "invalid_response" });
  });
});
