import { Hono } from "hono";
import { requireAuth } from "./auth";
import { googleAuth } from "./google";

export type AppEnv = {
  Bindings: Env & { AUTH_DISABLED?: string; GOOGLE_CLIENT_SECRET?: string; SESSION_SECRET?: string };
  Variables: { userEmail: string };
};

const api = new Hono<AppEnv>();

api.use("*", requireAuth);

api.get("/health", async (c) => {
  const [db, photos] = await Promise.allSettled([
    c.env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>(),
    c.env.PHOTOS.list({ limit: 1 }),
  ]);
  return c.json({
    user: c.get("userEmail"),
    authMode: c.env.AUTH_MODE,
    d1: db.status === "fulfilled" && db.value?.ok === 1 ? "ok" : "error",
    r2: photos.status === "fulfilled" ? "ok" : "error",
  });
});

const app = new Hono<AppEnv>();
app.route("/api", api);
app.route("/auth", googleAuth);
app.notFound((c) => c.json({ error: "not_found" }, 404));

export default app satisfies ExportedHandler<Env>;
