import { Hono, type MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { jwtVerify, SignJWT } from "jose";
import type { AppEnv } from "./index";
import { ulid } from "./ids";
import { GOOGLE, verifyIdToken } from "./lib/oidc.js";

// Google sign-in with the ID-token flow (Google Identity Services): the page gets a
// signed ID token from Google and POSTs it here; we verify it with oidc.js and issue
// our own long-lived session cookie. No client secret is involved. Users are keyed
// on Google's `sub`; only emails in ALLOWED_EMAILS may sign in.
const SESSION_COOKIE = "bb_session";
const SESSION_DAYS = 90;

type Bindings = AppEnv["Bindings"];
export type User = { id: string; email: string };

const key = (env: Bindings) => new TextEncoder().encode(env.SESSION_SECRET!);
const allowed = (env: Bindings, email: string) =>
  env.ALLOWED_EMAILS.split(",").map((e) => e.trim().toLowerCase()).includes(email.toLowerCase());
const configured = (env: Bindings) => Boolean(env.GOOGLE_CLIENT_ID && env.SESSION_SECRET && env.ALLOWED_EMAILS);

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.env.AUTH_DISABLED === "1") {
    c.set("user", { id: "dev-user", email: "dev@localhost" });
    return next();
  }
  if (!configured(c.env)) return c.json({ error: "auth_not_configured" }, 503);
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    try {
      const { payload } = await jwtVerify(token, key(c.env), { issuer: "bitebook", audience: "session" });
      // Re-check the allowlist so removing an email revokes existing sessions.
      if (typeof payload.sub === "string" && typeof payload.email === "string" && allowed(c.env, payload.email)) {
        c.set("user", { id: payload.sub, email: payload.email });
        return next();
      }
    } catch {
      // fall through to 401
    }
  }
  return c.json({ error: "unauthenticated" }, 401);
};

export const auth = new Hono<AppEnv>();

auth.use("*", async (c, next) => {
  if (!configured(c.env)) return c.json({ error: "auth_not_configured" }, 503);
  return next();
});

// The client ID is public (it ships to every browser); serving it from here keeps
// wrangler.jsonc the single place it is configured.
auth.get("/config", (c) => c.json({ googleClientId: c.env.GOOGLE_CLIENT_ID }));

auth.post("/google", async (c) => {
  const body = await c.req.json<{ credential?: string }>().catch(() => ({}) as { credential?: string });
  let claims;
  try {
    claims = await verifyIdToken(body.credential ?? "", { ...GOOGLE, audience: c.env.GOOGLE_CLIENT_ID });
  } catch {
    return c.json({ error: "sign_in_failed" }, 401);
  }
  if (claims.email_verified !== true || typeof claims.email !== "string") return c.json({ error: "sign_in_failed" }, 401);
  const email = claims.email.toLowerCase();
  if (!allowed(c.env, email)) return c.json({ error: "not_allowed" }, 403);

  const now = new Date().toISOString();
  const user = await c.env.DB.prepare(
    `INSERT INTO users (id, google_sub, email, created_at, last_login_at) VALUES (?1, ?2, ?3, ?4, ?4)
     ON CONFLICT(google_sub) DO UPDATE SET email = ?3, last_login_at = ?4
     RETURNING id`,
  )
    .bind(ulid(), claims.sub, email, now)
    .first<{ id: string }>();
  if (!user) return c.json({ error: "sign_in_failed" }, 500);

  const session = await new SignJWT({ email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuer("bitebook")
    .setAudience("session")
    .setExpirationTime(`${SESSION_DAYS}d`)
    .sign(key(c.env));
  setCookie(c, SESSION_COOKIE, session, { path: "/", httpOnly: true, secure: true, sameSite: "Lax", maxAge: SESSION_DAYS * 86400 });
  return c.json({ ok: true });
});

auth.post("/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});
