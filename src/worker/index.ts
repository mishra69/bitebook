import { Hono } from "hono";
import { auth, requireUser, type User } from "./auth";
import { batches } from "./batches";
import { diag } from "./diag";
import { meals } from "./meals";
import { memory } from "./memory";
import { purgeDeleted } from "./purge";
export { UserClock } from "./clock";
import { push } from "./push";
import { wakeAll } from "./clock";
import { analysis, images } from "./analyze";
import { overview } from "./overview";
import { appleHealth, shortcut } from "./applehealth";

export type AppEnv = {
  Bindings: Env & { AUTH_DISABLED?: string; SESSION_SECRET?: string };
  Variables: { user: User };
};

const api = new Hono<AppEnv>();

// Every /api route runs as a signed-in user; queries must filter on c.get("user").id.
api.use("*", requireUser);

api.get("/health", async (c) => {
  const [db, photos] = await Promise.allSettled([
    c.env.DB.prepare("SELECT 1 AS ok, (SELECT picture_url FROM users WHERE id = ?1) AS picture").bind(c.get("user").id).first<{ ok: number; picture: string | null }>(),
    c.env.PHOTOS.list({ prefix: `users/${c.get("user").id}/`, limit: 1 }),
  ]);
  return c.json({
    user: c.get("user").email,
    userId: c.get("user").id,
    picture: db.status === "fulfilled" ? (db.value?.picture ?? null) : null,
    d1: db.status === "fulfilled" && db.value?.ok === 1 ? "ok" : "error",
    r2: photos.status === "fulfilled" ? "ok" : "error",
  });
});

api.route("/", meals);
api.route("/", batches);
api.route("/", memory);
api.route("/", diag);
api.route("/", push);
api.route("/", analysis);
api.route("/", overview);
api.route("/", appleHealth);

const app = new Hono<AppEnv>();
app.route("/api", api);
app.route("/auth", auth);
app.route("/img", images); // signed photo links for the model provider (no session)
app.route("/shortcut", shortcut); // the Apple Health Shortcut (its own key, no session; D34)
app.notFound((c) => c.json({ error: "not_found" }, 404));
// Unexpected errors: log the details (Workers Logs keeps them), answer without them.
app.onError((err, c) => {
  console.error(`${c.req.method} ${new URL(c.req.url).pathname}:`, err);
  return c.json({ error: "internal" }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(_event, env, ctx) {
    // The only cron (D31): the daily purge, and a re-plan of every user's clock.
    ctx.waitUntil(purgeDeleted(env));
    ctx.waitUntil(wakeAll(env));
  },
} satisfies ExportedHandler<Env>;
