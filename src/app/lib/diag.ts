import { VERSION } from "../version";

// Diagnostics: what the phone saw while uploading (each attempt's timing and outcome,
// the app going to the background, the network dropping). Kept on the phone first,
// because the moments worth logging are often the ones when nothing reaches the
// server; sent later, in the background, and stored for 30 days (D23).
export type DiagEvent = { t: number; type: string; [k: string]: unknown };

const DB = "bitebook-diag"; // its own database, so the outbox's schema never has to change for it
const STORE = "events";
const KEEP = 2000; // on the phone; older events go once this many are waiting
const SEND = 200; // per request

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => Promise<T> | T): Promise<T> {
  const db = await open();
  try {
    const t = db.transaction(STORE, mode);
    const done = new Promise<void>((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = t.onabort = () => reject(t.error);
    });
    const out = await fn(t.objectStore(STORE));
    await done;
    return out;
  } finally {
    db.close();
  }
}

const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

// Never throws: diagnostics must not be able to break what they observe.
export function diag(type: string, data: Record<string, unknown> = {}) {
  const e: DiagEvent = { t: Date.now(), type, v: VERSION, vis: document.visibilityState, online: navigator.onLine, ...data };
  withStore("readwrite", async (s) => {
    s.add(e);
    const n = await req(s.count());
    if (n > KEEP) {
      // Drop the oldest beyond the cap (keys only grow, so the first keys are the oldest).
      const keys = await req(s.getAllKeys(null, n - KEEP));
      for (const k of keys) s.delete(k);
    }
  }).catch(() => {});
}

let flushing = false;

// Sends what's waiting, oldest first, and deletes only what the server confirmed.
export async function flushDiag() {
  if (flushing || !navigator.onLine) return;
  flushing = true;
  try {
    for (;;) {
      const [keys, events] = await withStore("readonly", async (s) => [
        await req(s.getAllKeys(null, SEND)),
        await req(s.getAll(null, SEND)) as DiagEvent[],
      ] as const);
      if (keys.length === 0) return;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15_000);
      const res = await fetch("/api/diag", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events }),
        signal: ctrl.signal,
      }).finally(() => clearTimeout(timer));
      if (!res.ok) return;
      await withStore("readwrite", (s) => keys.forEach((k) => s.delete(k)));
      if (keys.length < SEND) return;
    }
  } catch {
    // Offline or timed out: they stay on the phone for the next try.
  } finally {
    flushing = false;
  }
}
