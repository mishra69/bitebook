import { mealHref } from "./lib/router";
import { localDate, usualDay, useOverview } from "./lib/overview";

const n = (v: number) => Math.round(v).toLocaleString();

// The top of Today (D30): the model's questions waiting for an answer, the day's running
// total against a usual day, and, in chat mode, the meals waiting for a handoff.
export function TodayPanel() {
  const o = useOverview(8);
  if (!o) return null;
  const today = o.days.find((d) => d.date === localDate());
  const usual = usualDay(o);
  return (
    <>
      {o.questions.length > 0 && (
        <section class="card waiting-questions" aria-label="Questions waiting">
          <p>
            <strong>❓ Waiting for your answer</strong>
          </p>
          {o.questions.map((q) => (
            <a key={q.id} class="waiting-question" href={mealHref(q.meal_id)}>
              <span class="muted small">
                {q.taken_at.slice(5, 10).replace("-", "/")} {q.taken_at.slice(11, 16)} {q.meal_type ?? "meal"}
              </span>
              <br />
              {q.question}
            </a>
          ))}
        </section>
      )}
      {today && today.meals > 0 && (
        <section class="card day-total" aria-label="Today so far">
          <p>
            <strong>Today so far: {n(today.kcal)} kcal</strong> · protein {n(today.protein_g)} g · carbs {n(today.carbs_g)} g · fat{" "}
            {n(today.fat_g)} g{today.fiber_meals > 0 && ` · fiber ${n(today.fiber_g)} g`}
          </p>
          <p class="muted small">
            {today.analyzed} of {today.meals} meal{today.meals === 1 ? "" : "s"} analyzed
            {today.analyzing > 0 && ` · ${today.analyzing} analyzing`}
            {usual && ` · a usual day: ~${n(usual.kcal)} kcal, ${n(usual.protein_g)} g protein`}
          </p>
        </section>
      )}
      {!o.auto_model && o.chat_waiting > 0 && (
        <a class="card chat-waiting" href="#/analyze">
          {o.chat_waiting} meal{o.chat_waiting === 1 ? "" : "s"} waiting for analysis → <strong>Analyze in a chat</strong>
        </a>
      )}
    </>
  );
}
