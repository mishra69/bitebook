import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { createRemoteJWKSet, jwtVerify, SignJWT } from "jose";
import type { AppEnv } from "./index";

// Google sign-in (OpenID Connect, authorization code + PKCE), handled by the Worker.
// After sign-in the Worker issues its own long-lived session cookie; Google tokens are
// not kept. Only emails in ALLOWED_EMAILS may sign in.
const SESSION_COOKIE = "bb_session";
const FLOW_COOKIE = "bb_oauth";
const SESSION_DAYS = 90;
const googleJwks = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

type Bindings = AppEnv["Bindings"];

const key = (env: Bindings) => new TextEncoder().encode(env.SESSION_SECRET!);
const allowed = (env: Bindings, email: string) =>
  (env.ALLOWED_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).includes(email.toLowerCase());

export async function readSession(env: Bindings, cookieHeader: string | undefined): Promise<string | null> {
  const token = cookieHeader?.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`))?.[1];
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(env), { issuer: "bitebook", audience: "session" });
    // Re-check the allowlist so removing an email revokes existing sessions.
    return typeof payload.sub === "string" && allowed(env, payload.sub) ? payload.sub : null;
  } catch {
    return null;
  }
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const random = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

export const googleConfigured = (env: Bindings) =>
  Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.SESSION_SECRET && env.ALLOWED_EMAILS);

export const googleAuth = new Hono<AppEnv>();

googleAuth.use("*", async (c, next) => {
  if (c.env.AUTH_MODE !== "google") return c.notFound();
  if (!googleConfigured(c.env)) return c.json({ error: "auth_not_configured" }, 503);
  return next();
});

googleAuth.get("/login", async (c) => {
  const state = random();
  const nonce = random();
  const verifier = random();
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const flow = await new SignJWT({ state, nonce, verifier })
    .setProtectedHeader({ alg: "HS256" })
    .setAudience("oauth-flow")
    .setExpirationTime("10m")
    .sign(key(c.env));
  setCookie(c, FLOW_COOKIE, flow, { path: "/auth", httpOnly: true, secure: true, sameSite: "Lax", maxAge: 600 });

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: new URL("/auth/callback", c.req.url).toString(),
    response_type: "code",
    scope: "openid email",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return c.redirect(url.toString());
});

googleAuth.get("/callback", async (c) => {
  const fail = (reason: string) => c.redirect(`/?auth_error=${encodeURIComponent(reason)}`);

  const flowToken = getCookie(c, FLOW_COOKIE);
  deleteCookie(c, FLOW_COOKIE, { path: "/auth" });
  if (!flowToken) return fail("expired");
  let flow: { state: string; nonce: string; verifier: string };
  try {
    flow = (await jwtVerify(flowToken, key(c.env), { audience: "oauth-flow" })).payload as typeof flow;
  } catch {
    return fail("expired");
  }
  if (c.req.query("error")) return fail(c.req.query("error")!);
  if (c.req.query("state") !== flow.state) return fail("state");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: c.req.query("code") ?? "",
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: new URL("/auth/callback", c.req.url).toString(),
      grant_type: "authorization_code",
      code_verifier: flow.verifier,
    }),
  });
  if (!res.ok) return fail("token_exchange");
  const { id_token } = (await res.json()) as { id_token?: string };
  if (!id_token) return fail("token_exchange");

  let email: string;
  try {
    const { payload } = await jwtVerify(id_token, googleJwks, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: c.env.GOOGLE_CLIENT_ID,
    });
    if (payload.nonce !== flow.nonce || payload.email_verified !== true || typeof payload.email !== "string") return fail("id_token");
    email = payload.email;
  } catch {
    return fail("id_token");
  }
  if (!allowed(c.env, email)) return fail("not_allowed");

  const session = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(email)
    .setIssuer("bitebook")
    .setAudience("session")
    .setExpirationTime(`${SESSION_DAYS}d`)
    .sign(key(c.env));
  setCookie(c, SESSION_COOKIE, session, { path: "/", httpOnly: true, secure: true, sameSite: "Lax", maxAge: SESSION_DAYS * 86400 });
  return c.redirect("/");
});

googleAuth.post("/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});
