import { useEffect, useState } from "preact/hooks";
import type { Analysis, Meal } from "../shared/meals";
import { mealLabel } from "./MealRow";
import { ApiPanel } from "./ApiPanel";
import { deleteSavedMeal } from "./lib/mealsApi";
import { timeOfDay } from "./lib/time";

export function MealDetail({ id }: { id: string }) {
  const [meal, setMeal] = useState<Meal | null | "missing" | "error">(null);

  const load = () =>
    fetch(`/api/meals/${id}`)
      .then(async (r) => (r.status === 404 ? "missing" : r.ok ? ((await r.json()) as { meal: Meal }).meal : "error"))
      .catch(() => "error" as const)
      .then((m) => setMeal((prev) => (m === "error" && prev && typeof prev === "object" ? prev : m))); // keep showing it through a failed refresh

  useEffect(() => {
    setMeal(null);
    load();
  }, [id]);

  const back = () => (history.length > 1 ? history.back() : (location.hash = "#/"));

  if (meal === null) return <p class="muted">Loading…</p>;
  if (meal === "missing") return <p class="muted">This meal doesn't exist or was deleted. <a href="#/">Meals</a></p>;
  if (meal === "error") return <p class="bad">Couldn't load this meal. Are you online?</p>;

  const date = new Date(meal.taken_at.slice(0, 10) + "T12:00:00");
  const remove = async () => {
    if (await deleteSavedMeal(meal.id, mealLabel(meal.taken_at, meal.meal_type))) back();
  };

  return (
    <article class="detail">
      <button class="link" onClick={back}>
        ← Back
      </button>
      <h2>
        {date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })} · {meal.photos.length ? "" : "about "}
        {timeOfDay(meal.taken_at)}
      </h2>
      <p>
        {meal.meal_type && <span class="chip on small">{meal.meal_type}</span>}
        <span class="muted small"> {meal.tz}</span>
      </p>
      {meal.photos.length === 0 && <p class="muted small">Added afterwards without a photo; the time is the meal's usual hour.</p>}
      <div class="detail-photos">
        {meal.photos.map((p) => (
          <img key={p.id} src={`/api/photos/${p.id}/display`} alt="" width={p.width ?? undefined} height={p.height ?? undefined} />
        ))}
      </div>
      {meal.note && <p class="meal-note">{meal.note}</p>}
      {meal.voice && (
        <div class="card voice-detail">
          <audio controls src={`/api/meals/${meal.id}/voice`} preload="none" />
          <p class={meal.voice.transcript ? "" : "muted"}>
            {meal.voice.transcript ?? "Transcribing… (it'll be done by the time you analyze)"}
          </p>
        </div>
      )}
      <h3 class="section-title">Analysis</h3>
      <ApiPanel meal={meal} onChanged={load} />
      {meal.analyses?.length ? meal.analyses.map((a) => <AnalysisCard key={a.id} a={a} />) : <p class="muted">Not analyzed yet.</p>}
      <button class="button secondary danger" onClick={remove}>
        Delete meal
      </button>
    </article>
  );
}

// One model's reading of the meal. Every analysis is kept (principle 5), newest first.
function AnalysisCard({ a }: { a: Analysis }) {
  const n = (v: number | null) => (v === null ? "?" : Math.round(v));
  const when = new Date(a.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return (
    <div class="card analysis">
      {a.skipped ? (
        <p>Skipped: {a.skip_reason ?? "no reason given"}</p>
      ) : (
        <>
          <p class="analysis-desc">{a.description}</p>
          <p class="macros">
            <strong>~{n(a.kcal)} kcal</strong> · protein {n(a.protein_g)} g · carbs {n(a.carbs_g)} g · fat {n(a.fat_g)} g
            {a.fiber_g !== null && ` · fiber ${n(a.fiber_g)} g`}
          </p>
          {a.comment && <p class="muted small">{a.comment}</p>}
        </>
      )}
      <p class="muted small">
        {a.model} · {when}
        {a.confidence && ` · ${a.confidence} confidence`}
        {a.foods_used.length > 0 && ` · used ${a.foods_used.join(", ")}`}
      </p>
    </div>
  );
}
