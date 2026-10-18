import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { DeletedMeal, Meal } from "../shared/meals";
import { getSyncState, listMeals, removeFromOutbox, retryMeal, subscribe, type OutboxMeal } from "./lib/outbox";
import { startOfToday, timeOfDay } from "./lib/time";

type Row =
  | { kind: "server"; meal: Meal }
  | { kind: "local"; meal: OutboxMeal };

// Today's meals: the ones already on the server, plus everything still in the outbox.
export function MealList({ userId }: { userId: string }) {
  const [server, setServer] = useState<Meal[] | null>(null);
  const [local, setLocal] = useState<OutboxMeal[]>([]);
  const [sync, setSync] = useState(getSyncState());
  const [hidden, setHidden] = useState<Set<string>>(new Set()); // deleted, awaiting the server
  const [undo, setUndo] = useState<{ id: string; label: string } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [deletedOpen, setDeletedOpen] = useState(false);
  const [deletedVersion, setDeletedVersion] = useState(0);

  // Server and outbox lists are updated together: a meal leaves the outbox the moment
  // it's committed, and showing that before the server list has it makes it blink out.
  const refresh = async () => {
    const [outbox, fromServer] = await Promise.all([
      listMeals(userId),
      fetch("/api/meals?since=" + startOfToday())
        .then((r) => (r.ok ? (r.json() as Promise<{ meals: Meal[] }>).then((d) => d.meals) : null))
        .catch(() => null), // offline: keep what we have
    ]);
    if (fromServer) setServer(fromServer);
    setLocal(outbox);
  };

  useEffect(() => {
    refresh();
    let shown = new Set<string>();
    return subscribe(async () => {
      setSync(getSyncState());
      const outbox = await listMeals(userId);
      const left = [...shown].some((id) => !outbox.some((m) => m.id === id));
      shown = new Set(outbox.map((m) => m.id));
      if (left || !getSyncState().syncing) refresh();
      else setLocal(outbox);
    });
  }, [userId]);

  const rows: Row[] = useMemo(() => {
    const localIds = new Set(local.map((m) => m.id));
    const merged: Row[] = [
      ...local.map((meal) => ({ kind: "local" as const, meal })),
      ...(server ?? []).filter((m) => !localIds.has(m.id) && !hidden.has(m.id)).map((meal) => ({ kind: "server" as const, meal })),
    ];
    return merged.sort((a, b) => takenAt(b).localeCompare(takenAt(a)));
  }, [local, server, hidden]);

  const remove = async (row: Row) => {
    if (row.kind === "local") {
      // Never reached the server, so there's nothing to restore it from: ask first.
      if (confirm("Delete this meal? It hasn't been uploaded, so it can't be restored.")) await removeFromOutbox(row.meal.id);
      return;
    }
    const id = row.meal.id;
    setHidden((h) => new Set(h).add(id));
    const res = await fetch(`/api/meals/${id}`, { method: "DELETE" }).catch(() => null);
    if (!res?.ok) {
      setHidden((h) => withoutId(h, id));
      alert("Couldn't delete the meal. Are you online?");
      return;
    }
    clearTimeout(undoTimer.current);
    setUndo({ id, label: `${timeOfDay(row.meal.taken_at)} ${row.meal.meal_type ?? "meal"}` });
    undoTimer.current = setTimeout(() => setUndo(null), 8000);
    setDeletedVersion((v) => v + 1);
    refresh();
  };

  const restore = async (id: string) => {
    const res = await fetch(`/api/meals/${id}/restore`, { method: "POST" }).catch(() => null);
    if (!res?.ok) return alert("Couldn't restore the meal. Are you online?");
    setHidden((h) => withoutId(h, id));
    setUndo((u) => (u?.id === id ? null : u));
    setDeletedVersion((v) => v + 1);
    refresh();
  };

  const waiting = local.filter((m) => !m.error).length;
  const failed = local.filter((m) => m.error).length;

  return (
    <section aria-label="Today's meals">
      <p class="sync-line" aria-live="polite">
        {sync.signedOut
          ? "Signed out. Sign in again to upload."
          : waiting === 0 && failed === 0
            ? "All meals saved."
            : sync.syncing
              ? `Uploading ${waiting} meal${waiting === 1 ? "" : "s"}…${sync.progress ? ` ${mb(sync.progress.sent)} of ${mb(sync.progress.total)} MB` : ""}`
              : sync.offline
                ? `Offline. ${waiting} meal${waiting === 1 ? "" : "s"} will upload when you're back online.`
                : waiting
                  ? `${waiting} meal${waiting === 1 ? "" : "s"} waiting to upload.${sync.lastError ? " Retrying soon." : ""}`
                  : ""}
        {failed > 0 && <span class="bad"> {failed} couldn't be uploaded.</span>}
      </p>
      {waiting > 0 && !sync.signedOut && (
        <p class="hint">Keep Bitebook open until this finishes. iPhone pauses apps in the background.</p>
      )}
      <h2 class="section-title">Today</h2>
      {rows.length === 0 && server !== null && <p class="muted">No meals yet today.</p>}
      <ul class="meals">
        {rows.map((r) => (
          <MealRow key={r.meal.id} row={r} onDelete={() => remove(r)} />
        ))}
      </ul>
      <button class="link" onClick={() => setDeletedOpen((o) => !o)}>
        {deletedOpen ? "Hide recently deleted" : "Recently deleted"}
      </button>
      {deletedOpen && <RecentlyDeleted version={deletedVersion} onRestore={restore} />}
      {undo && (
        <div class="toast" role="status">
          <span>Deleted {undo.label}.</span>
          <button class="link" onClick={() => restore(undo.id)}>Undo</button>
        </div>
      )}
    </section>
  );
}

const withoutId = (s: Set<string>, id: string) => {
  const next = new Set(s);
  next.delete(id);
  return next;
};

// Deleted meals stay restorable until the daily purge removes them (30 days).
function RecentlyDeleted({ version, onRestore }: { version: number; onRestore: (id: string) => void }) {
  const [meals, setMeals] = useState<DeletedMeal[] | null>(null);
  useEffect(() => {
    fetch("/api/meals/deleted")
      .then((r) => r.json() as Promise<{ meals: DeletedMeal[] }>)
      .then((d) => setMeals(d.meals))
      .catch(() => setMeals([]));
  }, [version]);
  if (meals === null) return <p class="muted">Loading…</p>;
  if (meals.length === 0) return <p class="muted">Nothing deleted in the last 30 days.</p>;
  const daysLeft = (iso: string) => Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000));
  return (
    <ul class="meals deleted">
      {meals.map((m) => (
        <li key={m.id} class="meal">
          <div class="meal-head">
            {m.cover_photo_id && <img class="thumb small" src={`/api/photos/${m.cover_photo_id}/display`} alt="" loading="lazy" />}
            <span>
              <strong>{m.taken_at.slice(0, 10)} {timeOfDay(m.taken_at)}</strong> {m.meal_type ?? ""}
              <br />
              <span class="muted small">Removed for good in {daysLeft(m.purge_at)} days</span>
            </span>
            <button class="link push" onClick={() => onRestore(m.id)}>Restore</button>
          </div>
        </li>
      ))}
    </ul>
  );
}

const mb = (bytes: number) => (bytes / 1_048_576).toFixed(1);

const takenAt = (r: Row) => (r.kind === "local" ? r.meal.takenAt : r.meal.taken_at);

function MealRow({ row, onDelete }: { row: Row; onDelete: () => void }) {
  const local = row.kind === "local" ? row.meal : null;
  const urls = useMemo(
    () =>
      row.kind === "local"
        ? row.meal.photos.map((p) => URL.createObjectURL(p.display))
        : row.meal.photos.map((p) => `/api/photos/${p.id}/display`),
    [row.meal.id, row.kind],
  );
  useEffect(() => () => void (row.kind === "local" && urls.forEach((u) => URL.revokeObjectURL(u))), [urls]);

  const type = row.kind === "local" ? row.meal.mealType : row.meal.meal_type;
  return (
    <li class="meal">
      <div class="meal-head">
        <strong>{timeOfDay(takenAt(row))}</strong>
        {type && <span class="chip on small">{type}</span>}
        {local && !local.error && <span class="badge">uploading</span>}
        {local?.error && (
          <button class="badge bad" onClick={() => retryMeal(local)} title={local.error}>
            failed · retry
          </button>
        )}
        <button class="link push" onClick={onDelete} aria-label="Delete meal">Delete</button>
      </div>
      <div class="thumbs">
        {urls.map((u) => (
          <img key={u} class="thumb" src={u} alt="" loading="lazy" />
        ))}
      </div>
      {row.meal.note && <p class="meal-note">{row.meal.note}</p>}
    </li>
  );
}
