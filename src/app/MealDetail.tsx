import { useEffect, useState } from "preact/hooks";
import type { Analysis, Meal } from "../shared/meals";
import { mealLabel } from "./MealRow";
import { ApiPanel } from "./ApiPanel";
import { deleteSavedMeal } from "./lib/mealsApi";
import { timeOfDay } from "./lib/time";
import { mealsChanged, showToast } from "./lib/notify";

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
      {meal.photos.length === 0 && <p class="muted small">Added without a photo, by voice or a note; the time is approximate.</p>}
      <div class="detail-photos">
        {meal.photos.map((p) => (
          <img key={p.id} src={`/api/photos/${p.id}/display`} alt="" width={p.width ?? undefined} height={p.height ?? undefined} />
        ))}
      </div>
      {meal.note && <p class="meal-note">{meal.note}</p>}
      {(meal.voices ?? []).map((v, i, all) => (
        <div key={v.id} class="card voice-detail">
          {all.length > 1 && (
            <p class="muted small">
              Voice note {i + 1}
              {v.recorded_at && ` · ${v.recorded_at.slice(11, 16)}`}
            </p>
          )}
          <audio controls src={`/api/voice/${v.id}`} preload="none" />
          <p class={v.transcript ? "" : "muted"}>{v.transcript ?? "Transcribing… (it'll be done by the time you analyze)"}</p>
        </div>
      ))}
      <h3 class="section-title">Analysis</h3>
      <ApiPanel meal={meal} onChanged={load} />
      {meal.not_counted && <NotCounted meal={meal} onChanged={load} />}
      {meal.reanalyze_requested && <p class="muted">Waiting to be analyzed again.</p>}
      {meal.analyses?.length ? meal.analyses.map((a) => <AnalysisCard key={a.id} a={a} />) : <p class="muted">Not analyzed yet.</p>}
      <button class="button secondary danger" onClick={remove}>
        Delete meal
      </button>
    </article>
  );
}

// Skipped by the model, so it adds nothing to the day (D51): a duplicate of another meal, or
// a photo it couldn't use. Delete it, or have it analyzed again if the model was wrong.
function NotCounted({ meal, onChanged }: { meal: Meal; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const again = async () => {
    setBusy(true);
    const r = await fetch(`/api/meals/${meal.id}/reanalyze`, { method: "POST" }).catch(() => null);
    setBusy(false);
    if (!r?.ok) return showToast({ text: "Couldn't ask for that. Are you online?" });
    const { queued } = (await r.json()) as { queued: boolean };
    showToast({ text: queued ? "Analyzing it again." : "It's back with the meals waiting for analysis." });
    onChanged();
    mealsChanged();
  };
  return (
    <div class="card not-counted">
      <p>
        <strong>Not counted.</strong> {meal.not_counted}
      </p>
      <p class="muted small">It adds nothing to the day. If it's a duplicate, delete it; if the model got it wrong, analyze it again.</p>
      <button class="button secondary" onClick={again} disabled={busy}>
        Analyze again
      </button>
    </div>
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
