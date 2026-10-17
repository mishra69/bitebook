import { Hono } from "hono";
import { requireAccess } from "./access";

export type AppEnv = {
  Bindings: Env & { AUTH_DISABLED?: string };
  Variables: { userEmail: string };
};

const app = new Hono<AppEnv>().basePath("/api");

app.use("*", requireAccess);

app.get("/health", async (c) => {
  const [db, photos] = await Promise.allSettled([
    c.env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>(),
    c.env.PHOTOS.list({ limit: 1 }),
  ]);
  return c.json({
    user: c.get("userEmail"),
    d1: db.status === "fulfilled" && db.value?.ok === 1 ? "ok" : "error",
    r2: photos.status === "fulfilled" ? "ok" : "error",
  });
});

app.notFound((c) => c.json({ error: "not_found" }, 404));

export default app satisfies ExportedHandler<Env>;
