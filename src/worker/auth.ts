import { createRemoteJWKSet, jwtVerify } from "jose";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./index";
import { googleConfigured, readSession } from "./google";

// Two interchangeable sign-in modes are on trial (see docs/decisions.md, D7):
// - "access": Cloudflare Access guards the hostname; we re-check its JWT so the API
//   fails closed if Access is misconfigured.
// - "google": the Worker runs Google sign-in itself and issues its own session cookie.
const jwksByTeam = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.env.AUTH_DISABLED === "1") {
    c.set("userEmail", "dev@localhost");
    return next();
  }
  const email =
    c.env.AUTH_MODE === "google"
      ? await googleUser(c.env, c.req.header("Cookie"))
      : await accessUser(c.env, c.req.header("Cf-Access-Jwt-Assertion"));
  if (email === "not_configured") return c.json({ error: "auth_not_configured" }, 503);
  if (!email) return c.json({ error: "unauthenticated", login: c.env.AUTH_MODE === "google" ? "/auth/login" : null }, 401);
  c.set("userEmail", email);
  return next();
};

async function accessUser(env: AppEnv["Bindings"], token: string | undefined): Promise<string | null> {
  const { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud } = env;
  if (!team || !aud) return "not_configured";
  if (!token) return null;
  let jwks = jwksByTeam.get(team);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`));
    jwksByTeam.set(team, jwks);
  }
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: `https://${team}`, audience: aud });
    return typeof payload.email === "string" ? payload.email : "service-token";
  } catch {
    return null;
  }
}

async function googleUser(env: AppEnv["Bindings"], cookieHeader: string | undefined): Promise<string | null> {
  if (!googleConfigured(env)) return "not_configured";
  return readSession(env, cookieHeader);
}
