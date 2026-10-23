import { Hono } from "hono";
import type { AppEnv } from "./index";

// POST /api/diag {events} — the phone's diagnostics log (src/app/lib/diag.ts, D23).
// Stored as sent, for reading with SQL; nothing in the app reads it back.
export const diag = new Hono<AppEnv>();

const MAX_EVENTS = 200;
const MAX_EVENT_BYTES = 2000;

diag.post("/diag", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ events?: unknown }>().catch(() => ({}) as { events?: unknown });
  if (!Array.isArray(body.events) || body.events.length > MAX_EVENTS) return c.json({ error: "bad_request" }, 400);
  const now = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];
  for (const e of body.events) {
    if (typeof e !== "object" || e === null) continue;
    const { t, type } = e as { t?: unknown; type?: unknown };
    const data = JSON.stringify(e);
    // A malformed or oversized event is dropped, not refused: the phone deletes what it
    // sent once this succeeds, and one bad event mustn't keep the rest stuck there.
    if (typeof t !== "number" || typeof type !== "string" || type.length > 40 || data.length > MAX_EVENT_BYTES) continue;
    stmts.push(
      c.env.DB.prepare("INSERT INTO diag_events (user_id, t_ms, type, data, received_at) VALUES (?1, ?2, ?3, ?4, ?5)").bind(
        user.id, Math.round(t), type, data, now,
      ),
    );
  }
  if (stmts.length) await c.env.DB.batch(stmts);
  return c.json({ ok: true, stored: stmts.length });
});
