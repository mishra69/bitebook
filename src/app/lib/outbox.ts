import type { MealType, NewMeal } from "../../shared/meals";

// Meals waiting to reach the server. A meal is written here the moment it's saved, so
// capture works offline and survives the app being closed; it is deleted only after
// the server has committed it. iOS can evict this storage, which is why it's a queue
// and not the source of truth (docs/SPEC.md §7).
export type OutboxPhoto = {
  id: string;
  position: number;
  original: Blob;
  mime: string;
  sha256: string;
  display: Blob;
  displaySha256: string;
  width: number;
  height: number;
  uploaded: { original: boolean; display: boolean };
};

export type OutboxMeal = {
  id: string;
  userId: string; // only the user who captured it uploads it
  takenAt: string;
  tz: string;
  mealType: MealType | null;
  note: string | null;
  photos: OutboxPhoto[];
  createdAt: string;
  error?: string; // set when the server rejected it; it then waits for the user
  // Still being composed. Kept here from the first photo so an iOS reload while the
  // camera is open loses nothing; never uploaded until it's saved.
  draft?: boolean;
};

const DB = "bitebook";
const STORE = "outbox";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req.result);
      t.onerror = t.onabort = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

export const putMeal = (m: OutboxMeal) => tx("readwrite", (s) => s.put(m)).then(() => changed());
export const deleteMeal = (id: string) => tx("readwrite", (s) => s.delete(id)).then(() => changed());
const all = async (userId: string) =>
  ((await tx("readonly", (s) => s.getAll())) as OutboxMeal[]).filter((m) => m.userId === userId);
export const listMeals = async (userId: string) =>
  (await all(userId)).filter((m) => !m.draft).sort((a, b) => b.takenAt.localeCompare(a.takenAt));
export const getDraft = async (userId: string) => (await all(userId)).find((m) => m.draft) ?? null;

// ── Sync ────────────────────────────────────────────────────────────────────

export type SyncState = { syncing: boolean; offline: boolean; signedOut: boolean; lastError: string | null };
let state: SyncState = { syncing: false, offline: false, signedOut: false, lastError: null };
const listeners = new Set<() => void>();
export const getSyncState = () => state;
export function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
function changed(patch: Partial<SyncState> = {}) {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn());
}

const RETRY_DELAYS = [5_000, 15_000, 60_000, 300_000];
let retryIndex = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let running: Promise<void> | null = null;
let currentUser: string | null = null;

class Offline extends Error {}
class SignedOut extends Error {}
class Rejected extends Error {}

export function startSync(userId: string) {
  currentUser = userId;
  if (!startSync.wired) {
    startSync.wired = true;
    window.addEventListener("online", () => sync());
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && sync());
  }
  return sync();
}
startSync.wired = false;

export function sync(): Promise<void> {
  if (!currentUser) return Promise.resolve();
  // One pass at a time; a request during a pass queues exactly one more.
  if (running) return running.then(() => sync());
  clearTimeout(retryTimer);
  running = (async () => {
    changed({ syncing: true });
    try {
      for (const meal of await listMeals(currentUser!)) {
        if (meal.error) continue;
        try {
          await uploadMeal(meal);
          await deleteMeal(meal.id);
        } catch (e) {
          if (!(e instanceof Rejected)) throw e;
          await putMeal({ ...meal, error: e.message });
        }
      }
      retryIndex = 0;
      changed({ offline: false, signedOut: false, lastError: null });
    } catch (e) {
      if (e instanceof SignedOut) {
        changed({ signedOut: true });
      } else {
        changed({ offline: e instanceof Offline, lastError: e instanceof Offline ? null : String((e as Error).message ?? e) });
        retryTimer = setTimeout(() => sync(), RETRY_DELAYS[Math.min(retryIndex++, RETRY_DELAYS.length - 1)]);
      }
    } finally {
      running = null;
      changed({ syncing: false });
    }
  })();
  return running;
}

// Clears a server rejection so the meal is tried again.
export async function retryMeal(meal: OutboxMeal) {
  await putMeal({ ...meal, error: undefined });
  return sync();
}

async function uploadMeal(meal: OutboxMeal) {
  for (const p of meal.photos) {
    for (const kind of ["original", "display"] as const) {
      if (p.uploaded[kind]) continue;
      const blob = kind === "original" ? p.original : p.display;
      await request(`/api/photos/${p.id}/${kind}`, {
        method: "PUT",
        headers: {
          "Content-Type": kind === "original" ? p.mime : "image/jpeg",
          "X-Sha256": kind === "original" ? p.sha256 : p.displaySha256,
          "X-Taken-At": meal.takenAt,
        },
        body: blob,
      });
      p.uploaded[kind] = true;
      await putMeal(meal); // remember progress, so a retry skips finished files
    }
  }
  const body: NewMeal = {
    id: meal.id,
    taken_at: meal.takenAt,
    tz: meal.tz,
    meal_type: meal.mealType,
    note: meal.note,
    photos: meal.photos.map((p) => ({
      id: p.id,
      position: p.position,
      mime: p.mime,
      bytes: p.original.size,
      sha256: p.sha256,
      display_bytes: p.display.size,
      display_sha256: p.displaySha256,
      width: p.width,
      height: p.height,
    })),
  };
  try {
    await request("/api/meals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) {
    // The server doesn't have every file as described: upload them all again next pass.
    if (!(e instanceof Rejected) || e.message !== "files_missing") throw e;
    for (const p of meal.photos) p.uploaded = { original: false, display: false };
    await putMeal(meal);
    throw new Error("files_missing");
  }
}

async function request(url: string, init: RequestInit) {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new Offline("offline");
  }
  if (res.ok) return res;
  if (res.status === 401) throw new SignedOut("signed_out");
  // The service worker answers 503 {error:"offline"} when the network is down.
  const err = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `http_${res.status}`;
  if (res.status === 503 && err === "offline") throw new Offline("offline");
  if (res.status >= 500 || res.status === 429) throw new Error(err); // transient: retry later
  throw new Rejected(err); // the server refused this meal; retrying won't help
}
