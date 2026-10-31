import { useEffect, useRef, useState } from "preact/hooks";
import type { DeletedMeal, Meal } from "../shared/meals";
import { MealRow } from "./MealRow";
import { onMealsChanged } from "./lib/notify";
import { restoreSavedMeal } from "./lib/mealsApi";
import { localDate, type DayTotals } from "./lib/overview";
import { timeOfDay } from "./lib/time";

const PAGE = 30; // days per request; more load as the list scrolls into view

// Below today on the Meals tab (D39): one row per earlier day with meals, newest first,
// with that day's totals. A row opens to its meals (photos and estimates), fetched then.
// Yesterday, and any day with a meal not yet analyzed, start open.
export function EarlierDays() {
  const [days, setDays] = useState<DayTotals[]>([]);
  const [next, setNext] = useState<string | null | undefined>(undefined); // undefined: not loaded yet
  const [error, setError] = useState(false);
  const [version, setVersion] = useState(0); // bumped when meals change, so open days refetch
  const [showDeleted, setShowDeleted] = useState(false);
  const loading = useRef(false);
  const sentinel = useRef<HTMLDivElement>(null);

  const load = async (before: string, replace: boolean, limit = PAGE) => {
    if (loading.current) return;
    loading.current = true;
    try {
      const res = await fetch(`/api/days?before=${before}&limit=${limit}`);
      if (!res.ok) throw new Error();
      const d = (await res.json()) as { days: DayTotals[]; next_before: string | null };
      setDays((old) => (replace ? d.days : [...old, ...d.days]));
      setNext(d.next_before);
      setError(false);
    } catch {
      setError(true);
    } finally {
      loading.current = false;
    }
  };

  const shown = useRef(0);
  shown.current = days.length;
  useEffect(() => {
    load(localDate(), true);
    return onMealsChanged(() => {
      // As many days as are showing, so the list doesn't jump back to the first page.
      loading.current = false;
      load(localDate(), true, Math.min(Math.max(shown.current, PAGE), 92));
      setVersion((v) => v + 1);
    });
  }, []);

  // Infinite scroll: the next page loads as the end of the list comes near.
  useEffect(() => {
    if (!next || !sentinel.current) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && load(next, false), { rootMargin: "400px" });
    io.observe(sentinel.current);
    return () => io.disconnect();
  }, [next]);

  return (
    <section class="timeline" aria-label="Earlier meals">
      <div class="earlier-head">
        <h2 class="section-title">Earlier</h2>
        <button class="link" onClick={() => setShowDeleted((o) => !o)}>
          {showDeleted ? "Hide recently deleted" : "Recently deleted"}
        </button>
      </div>
      {showDeleted && <RecentlyDeleted version={version} />}
      {error && <p class="bad">Couldn't load earlier meals. Are you online?</p>}
      {next !== undefined && days.length === 0 && !error && <p class="muted">No earlier meals.</p>}
      <ul class="days">
        {days.map((d) => (
          <DayRow key={d.date} day={d} version={version} />
        ))}
      </ul>
      {next && <div ref={sentinel} class="muted small more">Loading older days…</div>}
    </section>
  );
}

const n = (v: number) => Math.round(v).toLocaleString();

function DayRow({ day, version }: { day: DayTotals; version: number }) {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const pending = day.analyzed < day.meals;
  const [open, setOpen] = useState(day.date === localDate(yesterday) || pending);
  const [meals, setMeals] = useState<Meal[] | null>(null);

  useEffect(() => {
    if (!open) return;
    fetch(`/api/meals?day=${day.date}&limit=200`)
      .then((r) => (r.ok ? (r.json() as Promise<{ meals: Meal[] }>) : Promise.reject()))
      .then((d) => setMeals(d.meals))
      .catch(() => setMeals((m) => m ?? []));
  }, [open, version]);

  return (
    <li class={"day" + (open ? " open" : "")}>
      <button class="day-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span class="day-title">
          <strong>{dayLabel(day.date)}</strong>
          <span class="muted small">
            {day.meals} meal{day.meals === 1 ? "" : "s"}
            {pending && ` · ${day.analyzed} analyzed${day.analyzing ? `, ${day.analyzing} analyzing` : ""}`}
          </span>
          <span class="chevron" aria-hidden="true">{open ? "▾" : "▸"}</span>
        </span>
        {day.analyzed > 0 && (
          <span class="day-macros">
            {pending && "≥ "}
            <strong>{n(day.kcal)} kcal</strong> · P {n(day.protein_g)} · C {n(day.carbs_g)} · F {n(day.fat_g)}
            {day.fiber_meals > 0 && ` · fiber ${n(day.fiber_g)}`}
          </span>
        )}
      </button>
      {open &&
        (meals === null ? (
          <p class="muted small">Loading…</p>
        ) : (
          <ul class="meals">
            {meals.map((meal) => (
              <MealRow key={meal.id} row={{ kind: "server", meal }} />
            ))}
          </ul>
        ))}
    </li>
  );
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
