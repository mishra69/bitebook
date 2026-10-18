import { useEffect, useState } from "preact/hooks";
import type { Meal } from "../shared/meals";
import { mealLabel } from "./MealRow";
import { deleteSavedMeal } from "./lib/mealsApi";
import { timeOfDay } from "./lib/time";

export function MealDetail({ id }: { id: string }) {
  const [meal, setMeal] = useState<Meal | null | "missing" | "error">(null);

  useEffect(() => {
    setMeal(null);
    fetch(`/api/meals/${id}`)
      .then(async (r) => (r.status === 404 ? "missing" : r.ok ? ((await r.json()) as { meal: Meal }).meal : "error"))
      .catch(() => "error" as const)
      .then(setMeal);
  }, [id]);

  const back = () => (history.length > 1 ? history.back() : (location.hash = "#/timeline"));

  if (meal === null) return <p class="muted">Loading…</p>;
  if (meal === "missing") return <p class="muted">This meal doesn't exist or was deleted. <a href="#/timeline">Timeline</a></p>;
  if (meal === "error") return <p class="bad">Couldn't load this meal. Are you online?</p>;

  const date = new Date(meal.taken_at.slice(0, 10) + "T12:00:00");
  const remove = async () => {
    if (await deleteSavedMeal(meal.id, mealLabel(meal.taken_at, meal.kind, meal.meal_type))) back();
  };

  return (
    <article class="detail">
      <button class="link" onClick={back}>
        ← Back
      </button>
      <h2>
        {date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })} · {timeOfDay(meal.taken_at)}
      </h2>
      <p>
        {meal.kind === "label" ? <span class="chip small label">label</span> : meal.meal_type && <span class="chip on small">{meal.meal_type}</span>}
        <span class="muted small"> {meal.tz}</span>
      </p>
      <div class="detail-photos">
        {meal.photos.map((p) => (
          <img key={p.id} src={`/api/photos/${p.id}/display`} alt="" width={p.width ?? undefined} height={p.height ?? undefined} />
        ))}
      </div>
      {meal.note && <p class="meal-note">{meal.note}</p>}
      <h3 class="section-title">Analysis</h3>
      <p class="muted">Not analyzed yet.</p>
      <button class="button secondary danger" onClick={remove}>
        Delete {meal.kind === "label" ? "label" : "meal"}
      </button>
    </article>
  );
}
