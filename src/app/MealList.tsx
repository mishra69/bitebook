import { useEffect, useMemo, useState } from "preact/hooks";
import type { Meal } from "../shared/meals";
import { MealRow, rowTakenAt, type Row } from "./MealRow";
import { onMealsChanged } from "./lib/notify";
import { getSyncState, listMeals, subscribe, type OutboxMeal } from "./lib/outbox";
import { startOfToday } from "./lib/time";

// Today's meals: the ones already on the server, plus everything still in the outbox.
export function MealList({ userId }: { userId: string }) {
  const [server, setServer] = useState<Meal[] | null>(null);
  const [local, setLocal] = useState<OutboxMeal[]>([]);
  const [sync, setSync] = useState(getSyncState());

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
    const offSync = subscribe(async () => {
      setSync(getSyncState());
      const outbox = await listMeals(userId);
      const left = [...shown].some((id) => !outbox.some((m) => m.id === id));
      shown = new Set(outbox.map((m) => m.id));
      if (left || !getSyncState().syncing) refresh();
      else setLocal(outbox);
    });
    const offChanged = onMealsChanged(refresh);
    return () => {
      offSync();
      offChanged();
    };
  }, [userId]);

  const rows: Row[] = useMemo(() => {
    const localIds = new Set(local.map((m) => m.id));
    const merged: Row[] = [
      ...local.map((meal) => ({ kind: "local" as const, meal })),
      ...(server ?? []).filter((m) => !localIds.has(m.id)).map((meal) => ({ kind: "server" as const, meal })),
    ];
    return merged.sort((a, b) => rowTakenAt(b).localeCompare(rowTakenAt(a)));
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
          <MealRow key={r.meal.id} row={r} />
        ))}
      </ul>
    </section>
  );
}

const mb = (bytes: number) => (bytes / 1_048_576).toFixed(1);
