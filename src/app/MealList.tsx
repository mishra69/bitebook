import { useEffect, useMemo, useState } from "preact/hooks";
import type { Meal } from "../shared/meals";
import { getSyncState, listMeals, retryMeal, subscribe, type OutboxMeal } from "./lib/outbox";
import { startOfToday, timeOfDay } from "./lib/time";

type Row =
  | { kind: "server"; meal: Meal }
  | { kind: "local"; meal: OutboxMeal };

// Today's meals: the ones already on the server, plus everything still in the outbox.
export function MealList({ userId }: { userId: string }) {
  const [server, setServer] = useState<Meal[] | null>(null);
  const [local, setLocal] = useState<OutboxMeal[]>([]);
  const [sync, setSync] = useState(getSyncState());

  const refresh = async () => {
    setLocal(await listMeals(userId));
    try {
      const res = await fetch("/api/meals?since=" + startOfToday());
      if (res.ok) setServer(((await res.json()) as { meals: Meal[] }).meals);
    } catch {
      /* offline: keep what we have */
    }
  };

  useEffect(() => {
    refresh();
    return subscribe(() => {
      setSync(getSyncState());
      listMeals(userId).then(setLocal);
      if (!getSyncState().syncing) refresh();
    });
  }, [userId]);

  const rows: Row[] = useMemo(() => {
    const localIds = new Set(local.map((m) => m.id));
    const merged: Row[] = [
      ...local.map((meal) => ({ kind: "local" as const, meal })),
      ...(server ?? []).filter((m) => !localIds.has(m.id)).map((meal) => ({ kind: "server" as const, meal })),
    ];
    return merged.sort((a, b) => takenAt(b).localeCompare(takenAt(a)));
  }, [local, server]);

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
              ? `Uploading ${waiting} meal${waiting === 1 ? "" : "s"}…`
              : sync.offline
                ? `Offline. ${waiting} meal${waiting === 1 ? "" : "s"} will upload when you're back online.`
                : waiting
                  ? `${waiting} meal${waiting === 1 ? "" : "s"} waiting to upload.${sync.lastError ? " Retrying soon." : ""}`
                  : ""}
        {failed > 0 && <span class="bad"> {failed} couldn't be uploaded.</span>}
      </p>
      <h2 class="section-title">Today</h2>
      {rows.length === 0 && server !== null && <p class="muted">No meals yet today.</p>}
      <ul class="meals">
        {rows.map((r) => (
          <MealRow key={r.meal.id} row={r} />
        ))}
      </ul>
    </section>
  );
}

const takenAt = (r: Row) => (r.kind === "local" ? r.meal.takenAt : r.meal.taken_at);

function MealRow({ row }: { row: Row }) {
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
