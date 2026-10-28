import { useEffect, useState } from "preact/hooks";
import type { DeletedMeal, Meal } from "../shared/meals";
import { MealRow } from "./MealRow";
import { onMealsChanged } from "./lib/notify";
import { restoreSavedMeal } from "./lib/mealsApi";
import { startOfToday, timeOfDay } from "./lib/time";

const PAGE = 40;

// Below today on the Meals tab (D37): every earlier meal, newest first, grouped by the day
// it was eaten (in the zone it was eaten in). Today and meals still on the phone are
// MealList's.
export function EarlierDays() {
  const [meals, setMeals] = useState<Meal[]>([]);
  const [next, setNext] = useState<number | null | undefined>(undefined); // undefined: not loaded yet
  const [error, setError] = useState(false);
  const [showDeleted, setShowDeleted] = useState(false);
  const [deletedVersion, setDeletedVersion] = useState(0);

  const load = async (before: number | null, replace: boolean) => {
    try {
      const res = await fetch(`/api/meals?limit=${PAGE}${before ? `&before=${before}` : ""}`);
      if (!res.ok) throw new Error();
      const d = (await res.json()) as { meals: Meal[]; next_before: number | null };
      setMeals((m) => (replace ? d.meals : [...m, ...d.meals]));
      setNext(d.next_before);
      setError(false);
    } catch {
      setError(true);
    }
  };

  useEffect(() => {
    load(null, true);
    return onMealsChanged(() => {
      load(null, true);
      setDeletedVersion((v) => v + 1);
    });
  }, []);

  const today = startOfToday();
  const days = groupByDay(meals.filter((m) => Date.parse(m.taken_at) < today));
  return (
    <section class="timeline" aria-label="Earlier meals">
      {error && <p class="bad">Couldn't load earlier meals. Are you online?</p>}
      {days.map(([day, list]) => (
        <div key={day}>
          <h2 class="section-title">{dayLabel(day)}</h2>
          <ul class="meals">
            {list.map((meal) => (
              <MealRow key={meal.id} row={{ kind: "server", meal }} />
            ))}
          </ul>
        </div>
      ))}
      {next && (
        <button class="button secondary wide" onClick={() => load(next, false)}>
          Show older meals
        </button>
      )}
      <button class="link" onClick={() => setShowDeleted((o) => !o)}>
        {showDeleted ? "Hide recently deleted" : "Recently deleted"}
      </button>
      {showDeleted && <RecentlyDeleted version={deletedVersion} />}
    </section>
  );
}

// taken_at carries the local time of the meal, so its date part is the day it was eaten.
function groupByDay(meals: Meal[]): [string, Meal[]][] {
  const out = new Map<string, Meal[]>();
  for (const m of meals) out.set(m.taken_at.slice(0, 10), [...(out.get(m.taken_at.slice(0, 10)) ?? []), m]);
  return [...out];
}

function dayLabel(day: string) {
  const [y, mo, d] = day.split("-").map(Number);
  const date = new Date(y, mo - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - date.getTime()) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: diff > 300 ? "numeric" : undefined });
}

// Deleted meals stay restorable until the daily purge removes them (30 days).
function RecentlyDeleted({ version }: { version: number }) {
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
              <strong>
                {m.taken_at.slice(0, 10)} {timeOfDay(m.taken_at)}
              </strong>{" "}
              {m.meal_type ?? ""}
              <br />
              <span class="muted small">Removed for good in {daysLeft(m.purge_at)} days</span>
            </span>
            <button class="link push" onClick={() => restoreSavedMeal(m.id)}>
              Restore
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
