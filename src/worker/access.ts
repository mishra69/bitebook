import { createRemoteJWKSet, jwtVerify } from "jose";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./index";

// Cloudflare Access sits in front of the whole hostname; this re-checks its JWT so the API
// fails closed if Access is misconfigured or the workers.dev URL is reached directly.
const jwksByTeam = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export const requireAccess: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.env.AUTH_DISABLED === "1") {
    c.set("userEmail", "dev@localhost");
    return next();
  }
  const { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud } = c.env;
  if (!team || !aud) return c.json({ error: "access_not_configured" }, 503);

  const token = c.req.header("Cf-Access-Jwt-Assertion");
  if (!token) return c.json({ error: "unauthenticated" }, 401);

  let jwks = jwksByTeam.get(team);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`));
    jwksByTeam.set(team, jwks);
  }
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: `https://${team}`, audience: aud });
    c.set("userEmail", typeof payload.email === "string" ? payload.email : "service-token");
  } catch {
    return c.json({ error: "unauthenticated" }, 401);
  }
  return next();
};
