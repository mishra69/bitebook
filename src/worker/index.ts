import { Hono } from "hono";
import { auth, requireUser, type User } from "./auth";

export type AppEnv = {
  Bindings: Env & { AUTH_DISABLED?: string; SESSION_SECRET?: string };
  Variables: { user: User };
};

const api = new Hono<AppEnv>();

// Every /api route runs as a signed-in user; queries must filter on c.get("user").id.
api.use("*", requireUser);

api.get("/health", async (c) => {
  const [db, photos] = await Promise.allSettled([
    c.env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>(),
    c.env.PHOTOS.list({ prefix: `users/${c.get("user").id}/`, limit: 1 }),
  ]);
  return c.json({
    user: c.get("user").email,
    d1: db.status === "fulfilled" && db.value?.ok === 1 ? "ok" : "error",
    r2: photos.status === "fulfilled" ? "ok" : "error",
  });
});

const app = new Hono<AppEnv>();
app.route("/api", api);
app.route("/auth", auth);
app.notFound((c) => c.json({ error: "not_found" }, 404));

export default app satisfies ExportedHandler<Env>;
