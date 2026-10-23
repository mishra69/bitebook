import { useEffect, useMemo } from "preact/hooks";
import type { Meal } from "../shared/meals";
import { retryMeal, removeFromOutbox, type OutboxMeal } from "./lib/outbox";
import { mealHref } from "./lib/router";
import { timeOfDay } from "./lib/time";

export type Row = { kind: "server"; meal: Meal } | { kind: "local"; meal: OutboxMeal };

export const rowTakenAt = (r: Row) => (r.kind === "local" ? r.meal.takenAt : r.meal.taken_at);

export const mealLabel = (takenAt: string, type: string | null) => `${timeOfDay(takenAt)} ${type ?? "meal"}`;

// One meal in a list. Saved meals open their detail screen; meals still on the phone
// show their upload state and can be deleted right here (there's nothing to open yet).
export function MealRow({ row }: { row: Row }) {
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
  const body = (
    <>
      <div class="meal-head">
        <strong>{timeOfDay(rowTakenAt(row))}</strong>
        {type && <span class="chip on small">{type}</span>}
        {local && !local.error && <span class="badge">uploading</span>}
        {local?.error && (
          <button class="badge bad" onClick={() => retryMeal(local)} title={local.error}>
            failed · retry
          </button>
        )}
        {local && (
          <button
            class="link push"
            onClick={() =>
              confirm("Delete this meal? It hasn't been uploaded, so it can't be restored.") && removeFromOutbox(local.id)
            }
          >
            Delete
          </button>
        )}
      </div>
      <div class="thumbs">
        {urls.map((u) => (
          <img key={u} class="thumb" src={u} alt="" loading="lazy" />
        ))}
      </div>
      {row.kind === "server" && row.meal.analysis && (
        <p class="meal-analysis">
          {row.meal.analysis.description} · <strong>~{Math.round(row.meal.analysis.kcal ?? 0)} kcal</strong>
          {row.meal.analysis.protein_g !== null && ` · P${Math.round(row.meal.analysis.protein_g)}`}
          {row.meal.analysis.fiber_g !== null && ` · fiber ${Math.round(row.meal.analysis.fiber_g)}`}
        </p>
      )}
      {row.meal.note && <p class="meal-note">{row.meal.note}</p>}
    </>
  );
  return (
    <li class="meal">
      {row.kind === "server" ? (
        <a class="meal-link" href={mealHref(row.meal.id)}>
          {body}
        </a>
      ) : (
        body
      )}
    </li>
  );
}
