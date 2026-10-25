import { useEffect, useState } from "preact/hooks";
import { mealsChanged, onMealsChanged } from "./notify";

// The numbers behind Today's running total and the Trends charts (GET /api/overview).
export type DayTotals = {
  date: string;
  meals: number;
  analyzed: number;
  analyzing: number;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
  fiber_meals: number;
};
export type Overview = {
  days: DayTotals[];
  questions: { id: string; question: string; meal_id: string; taken_at: string; meal_type: string | null }[];
  latest: { text: string; suggestion: string | null; model: string; at: string } | null;
  auto_model: string | null;
  chat_waiting: number;
};

export const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// Every date in the window, newest first, with empty days filled in.
export function dayWindow(o: Overview, days: number, today = new Date()): (DayTotals & { complete: boolean })[] {
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const date = localDate(d);
    const t = o.days.find((x) => x.date === date) ?? { date, meals: 0, analyzed: 0, analyzing: 0, kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0, fiber_meals: 0 };
    out.push({ ...t, complete: t.meals > 0 && t.analyzed === t.meals });
  }
  return out;
}

// "Your usual day": the average over the last 7 days before today whose meals are all
// analyzed (a half-analyzed day would drag it down).
export function usualDay(o: Overview, today = new Date()) {
  const past = dayWindow(o, 8, today).slice(1).filter((d) => d.complete);
  if (past.length === 0) return null;
  const avg = (k: "kcal" | "protein_g") => Math.round(past.reduce((n, d) => n + d[k], 0) / past.length);
  return { days: past.length, kcal: avg("kcal"), protein_g: avg("protein_g") };
}

// Loads it, reloads when meals change, and checks back while something is being analyzed;
// when an estimate lands, the meal lists are told to refresh too.
export function useOverview(days = 30) {
  const [o, setO] = useState<Overview | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastAnalyzed = -1;
    const load = async () => {
      clearTimeout(timer);
      const next = await fetch(`/api/overview?days=${days}`)
        .then((r) => (r.ok ? (r.json() as Promise<Overview>) : null))
        .catch(() => null);
      if (!next) return;
      setO(next);
      const analyzed = next.days.reduce((n, d) => n + d.analyzed, 0);
      if (lastAnalyzed >= 0 && analyzed !== lastAnalyzed) mealsChanged();
      lastAnalyzed = analyzed;
      if (next.days.some((d) => d.analyzing > 0)) timer = setTimeout(load, 15_000);
    };
    load();
    const off = onMealsChanged(() => {
      lastAnalyzed = -1; // our own refresh; don't echo it back
      load();
    });
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(timer);
      off();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [days]);
  return o;
}
