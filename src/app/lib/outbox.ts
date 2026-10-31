import type { MealType, NewMeal } from "../../shared/meals";
import { diag, flushDiag } from "./diag";
import { mealsChanged } from "./notify";

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
  takenAt?: string; // when the photo was taken (EXIF, else capture time); missing before D19
  addedAt?: number; // when it was added to the draft (epoch ms), for auto-saving idle drafts
};

export type OutboxVoice = { blob: Blob; mime: string; sha256: string; durationMs: number; uploaded: boolean };

export type OutboxMeal = {
  id: string;
  userId: string; // only the user who captured it uploads it
  takenAt: string;
  tz: string;
  mealType: MealType | null;
  note: string | null;
  photos: OutboxPhoto[];
  createdAt: string;
  savedAt?: number; // when Save was tapped (epoch ms), to time the whole upload
  voice?: OutboxVoice; // one spoken note per meal (D21)
  error?: string; // set when the server rejected it; it then waits for the user
  // Added afterwards without a photo (D24): its takenAt is the time the user set (D39).
  // typePicked: the user chose or cleared the meal type, so moving the time won't re-suggest it.
  missed?: { daysAgo: number; typePicked?: boolean };
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

// Files are stored as bytes, not Blobs (D36). On iPhone a Blob read back from IndexedDB
// can go unreadable while the page lives on: its thumbnail shows a broken image and its
// upload hangs with no bytes sent, until a reload. A Blob made from bytes in memory can't.
type Bytes<T> = { [K in keyof T]: T[K] extends Blob ? ArrayBuffer | Blob : T[K] };
type StoredMeal = Omit<OutboxMeal, "photos" | "voice"> & { photos: Bytes<OutboxPhoto>[]; voice?: Bytes<OutboxVoice> };

const toBytes = (b: Blob) => b.arrayBuffer();
async function toBlob(v: ArrayBuffer | Blob, type: string, meal: string): Promise<Blob> {
  if (v instanceof ArrayBuffer) return new Blob([v], { type });
  // Saved before D36: copy it into memory while it can still be read.
  try {
    return new Blob([await v.arrayBuffer()], { type });
  } catch (e) {
    diag("blob_unreadable", { meal, error: String((e as Error).message ?? e) });
    return v;
  }
}

async function store(m: OutboxMeal): Promise<StoredMeal> {
  return {
    ...m,
    photos: await Promise.all(m.photos.map(async (p) => ({ ...p, original: await toBytes(p.original), display: await toBytes(p.display) }))),
    voice: m.voice && { ...m.voice, blob: await toBytes(m.voice.blob) },
  };
}

async function load(m: StoredMeal): Promise<OutboxMeal> {
  return {
    ...m,
    photos: await Promise.all(
      m.photos.map(async (p) => ({ ...p, original: await toBlob(p.original, p.mime, m.id), display: await toBlob(p.display, "image/jpeg", m.id) })),
    ),
    voice: m.voice && { ...m.voice, blob: await toBlob(m.voice.blob, m.voice.mime, m.id) },
  };
}

// Converted before the transaction opens: one left waiting on anything else commits early.
export const putMeal = async (m: OutboxMeal) => {
  const stored = await store(m);
  await tx("readwrite", (s) => s.put(stored));
  changed();
};
export const deleteMeal = (id: string) => tx("readwrite", (s) => s.delete(id)).then(() => changed());
const all = async (userId: string) =>
  Promise.all(((await tx("readonly", (s) => s.getAll())) as StoredMeal[]).filter((m) => m.userId === userId).map(load));
export const listMeals = async (userId: string) =>
  (await all(userId)).filter((m) => !m.draft).sort((a, b) => b.takenAt.localeCompare(a.takenAt));
const hasMeal = async (id: string) => (await tx("readonly", (s) => s.getKey(id))) !== undefined;
export const getDraft = async (userId: string) => (await all(userId)).find((m) => m.draft) ?? null;

// ── Sync ────────────────────────────────────────────────────────────────────

export type SyncState = {
  syncing: boolean;
  offline: boolean;
  signedOut: boolean;
  lastError: string | null;
  progress: { sent: number; total: number } | null; // bytes, for the meal being uploaded
};
let state: SyncState = { syncing: false, offline: false, signedOut: false, lastError: null, progress: null };
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
// A stalled request isn't a lost network: a fresh one usually goes straight through (D32).
const STALL_RETRY_DELAYS = [1_000, 3_000, 10_000, 30_000];
let retryIndex = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let running: Promise<void> | null = null;
let currentUser: string | null = null;

class Offline extends Error {}
class Stalled extends Error {} // hung or timed out with the network up: retry soon, quietly
class SignedOut extends Error {}
class Rejected extends Error {}
class Removed extends Error {} // the user deleted the meal while it was uploading

let uploadingId: string | null = null;

// Deletes a meal that hasn't reached the server yet, stopping its upload if one is running.
export async function removeFromOutbox(id: string) {
  await deleteMeal(id);
  if (uploadingId === id) inflight?.abort();
}

async function ensureQueued(id: string) {
  if (!(await hasMeal(id))) throw new Removed("removed");
}

export function startSync(userId: string) {
  currentUser = userId;
  if (!startSync.wired) {
    startSync.wired = true;
    window.addEventListener("online", () => {
      diag("online");
      restartSync();
    });
    window.addEventListener("offline", () => diag("offline"));
    // iOS freezes a backgrounded web app, often mid-upload. A request frozen that way may
    // never settle, so on return abandon it and start over: every step is idempotent.
    document.addEventListener("visibilitychange", () => {
      diag("visibility", { inflight: !!inflight });
      if (document.visibilityState === "visible") restartSync();
    });
    window.addEventListener("pageshow", (e) => {
      diag("pageshow", { persisted: e.persisted });
      restartSync();
    });
    diag("start", { conn: (navigator as { connection?: { effectiveType?: string } }).connection?.effectiveType });
  }
  flushDiag();
  return sync();
}
startSync.wired = false;

let inflight: AbortController | null = null;

function restartSync() {
  if (inflight) abandoned.add(inflight);
  inflight?.abort();
  retryIndex = 0;
  return sync();
}

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
          uploadingId = meal.id;
          await uploadMeal(meal);
          await deleteMeal(meal.id);
          diag("meal_done", { meal: meal.id, sinceSaveMs: meal.savedAt ? Date.now() - meal.savedAt : null });
          mealsChanged(); // a missed meal from an earlier day now belongs to that day's list
        } catch (e) {
          // Deleted mid-upload (its request was aborted): move on to the next meal.
          if (e instanceof Removed || !(await hasMeal(meal.id))) continue;
          if (!(e instanceof Rejected)) throw e;
          await putMeal({ ...meal, error: e.message });
        } finally {
          uploadingId = null;
        }
      }
      retryIndex = 0;
      changed({ offline: false, signedOut: false, lastError: null });
      setTimeout(flushDiag, 2_000); // after this pass's own events are written
    } catch (e) {
      if (e instanceof SignedOut) {
        changed({ signedOut: true });
      } else {
        changed({ offline: e instanceof Offline, lastError: e instanceof Offline ? null : String((e as Error).message ?? e) });
        const delays = e instanceof Stalled ? STALL_RETRY_DELAYS : RETRY_DELAYS;
        const delay = delays[Math.min(retryIndex++, delays.length - 1)];
        diag("retry_scheduled", { delayMs: delay, error: String((e as Error).message ?? e) });
        retryTimer = setTimeout(() => sync(), delay);
      }
    } finally {
      running = null;
      changed({ syncing: false, progress: null });
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
  // Display copies first: they're small, so a short stay in the app still gets them done.
  const voiceSize = meal.voice?.blob.size ?? 0;
  const total = meal.photos.reduce((n, p) => n + p.original.size + p.display.size, 0) + voiceSize;
  let sent =
    meal.photos.reduce((n, p) => n + (p.uploaded.original ? p.original.size : 0) + (p.uploaded.display ? p.display.size : 0), 0) +
    (meal.voice?.uploaded ? voiceSize : 0);
  changed({ progress: { sent, total } });
  if (meal.voice && !meal.voice.uploaded) {
    await request(`/api/voice/${meal.id}`, {
      method: "PUT",
      headers: { "Content-Type": meal.voice.mime, "X-Sha256": meal.voice.sha256, "X-Taken-At": meal.takenAt },
      body: meal.voice.blob,
    });
    meal.voice.uploaded = true;
    sent += voiceSize;
    changed({ progress: { sent, total } });
    await ensureQueued(meal.id);
    await putMeal(meal);
  }
  for (const kind of ["display", "original"] as const) {
    for (const p of meal.photos) {
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
      sent += blob.size;
      changed({ progress: { sent, total } });
      await ensureQueued(meal.id); // don't resurrect a meal deleted mid-upload
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
      taken_at: p.takenAt,
    })),
    voice: meal.voice
      ? { mime: meal.voice.mime, bytes: meal.voice.blob.size, sha256: meal.voice.sha256, duration_ms: meal.voice.durationMs }
      : undefined,
  };
  await ensureQueued(meal.id);
  try {
    await request("/api/meals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) {
    // The server doesn't have every file as described: upload them all again next pass.
    if (!(e instanceof Rejected) || e.message !== "files_missing") throw e;
    for (const p of meal.photos) p.uploaded = { original: false, display: false };
    if (meal.voice) meal.voice.uploaded = false;
    await putMeal(meal);
    throw new Error("files_missing");
  }
}

// Generous for a slow connection (≈100 KB/s), but finite: a request that never settles
// would otherwise block every later upload. Uploads also have a stall watchdog (below).
const timeoutFor = (body: BodyInit | null | undefined) => 20_000 + (body instanceof Blob ? body.size / 100 : 0);

// On iPhone an upload sometimes hangs outright: no bytes move, and only a timeout ends it,
// while a fresh request goes through in a second or two (seen in the upload log, D32). So
// file uploads go through XHR, which reports progress: with no progress for this long, the
// request is dropped and retried at once.
const UPLOAD_STALL_MS = 8_000;
const RESPONSE_STALL_MS = 15_000; // after the last byte is sent; the server answers in about a second
class StallError extends Error {
  constructor(readonly sent: number) {
    super("stalled");
  }
}

function upload(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(init.method ?? "PUT", url);
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) xhr.setRequestHeader(k, v);
    let last = Date.now();
    let sent = 0;
    let uploaded = false;
    const done = () => {
      clearInterval(watchdog);
      signal.removeEventListener("abort", onAbort);
    };
    const watchdog = setInterval(() => {
      if (Date.now() - last <= (uploaded ? RESPONSE_STALL_MS : UPLOAD_STALL_MS)) return;
      done();
      xhr.abort();
      reject(new StallError(sent));
    }, 1_000);
    const onAbort = () => {
      done();
      xhr.abort();
      reject(new DOMException("aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort);
    xhr.upload.onprogress = (e) => {
      last = Date.now();
      sent = e.loaded;
    };
    xhr.upload.onload = () => {
      uploaded = true;
      last = Date.now();
    };
    xhr.onload = () => {
      done();
      resolve(new Response(xhr.responseText, { status: xhr.status, headers: { "Content-Type": "application/json" } }));
    };
    xhr.onerror = () => {
      done();
      reject(new TypeError("network error"));
    };
    xhr.send(init.body as Blob);
  });
}

// Requests aborted because the app came back from the background (not timed out).
const abandoned = new WeakSet<AbortController>();

async function request(url: string, init: RequestInit) {
  const ctrl = new AbortController();
  inflight = ctrl;
  let timedOut = false;
  const timeout = timeoutFor(init.body);
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeout);
  const started = Date.now();
  const what = { url: url.replace(/^\/api\//, ""), bytes: init.body instanceof Blob ? init.body.size : null };
  let res: Response;
  try {
    res = init.body instanceof Blob ? await upload(url, init, ctrl.signal) : await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    const error =
      e instanceof StallError ? "stalled" : timedOut ? "timeout" : abandoned.has(ctrl) ? "abandoned" : ctrl.signal.aborted ? "aborted" : `network: ${(e as Error).message}`;
    diag("request", { ...what, ms: Date.now() - started, timeoutMs: timeout, error, ...(e instanceof StallError ? { sent: e.sent } : {}) });
    // Hung, timed out or abandoned while the phone says it's online: try again soon, and
    // don't tell the user they're offline. A real network failure is reported as one.
    if ((e instanceof StallError || timedOut || abandoned.has(ctrl)) && navigator.onLine) throw new Stalled("stalled");
    throw new Offline("offline");
  } finally {
    clearTimeout(timer);
    if (inflight === ctrl) inflight = null;
  }
  diag("request", { ...what, ms: Date.now() - started, status: res.status });
  if (res.ok) return res;
  if (res.status === 401) throw new SignedOut("signed_out");
  // The service worker answers 503 {error:"offline"} when the network is down.
  const err = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `http_${res.status}`;
  if (res.status === 503 && err === "offline") throw new Offline("offline");
  if (res.status >= 500 || res.status === 429) throw new Error(err); // transient: retry later
  throw new Rejected(err); // the server refused this meal; retrying won't help
}
