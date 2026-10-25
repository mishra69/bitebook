import { useState } from "preact/hooks";
import { dayWindow, localDate, useOverview, type DayTotals } from "./lib/overview";

const NUTRIENTS = [
  { key: "kcal", label: "kcal", unit: "kcal" },
  { key: "protein_g", label: "protein", unit: "g" },
  { key: "carbs_g", label: "carbs", unit: "g" },
  { key: "fat_g", label: "fat", unit: "g" },
  { key: "fiber_g", label: "fiber", unit: "g" },
] as const;
type Key = (typeof NUTRIENTS)[number]["key"];
type Day = DayTotals & { complete: boolean };

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const dayName = (date: string) => WEEKDAYS[new Date(date + "T12:00:00").getDay()];
const short = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
const fmt = (v: number) => Math.round(v).toLocaleString();

// A day counts toward the average only when every meal on it is analyzed (and, for fiber,
// every estimate has fiber: older ones don't).
const counts = (d: Day, key: Key) => d.complete && (key !== "fiber_g" || d.fiber_meals === d.analyzed);

// Daily totals over time, one nutrient at a time, and the model's latest comment (D30). The
// chat handoff lives at the bottom, for when it has something to do.
export function Trends() {
  const o = useOverview(30);
  const [key, setKey] = useState<Key>("kcal");
  const [range, setRange] = useState<7 | 30>(7);
  const [focus, setFocus] = useState<string | null>(null);
  if (!o) return <p class="muted">Loading…</p>;

  const nutrient = NUTRIENTS.find((x) => x.key === key)!;
  const days = dayWindow(o, range).reverse(); // oldest first, left to right
  const counted = days.filter((d) => counts(d, key));
  const avg = counted.length ? counted.reduce((n, d) => n + d[key], 0) / counted.length : null;
  const focused = days.find((d) => d.date === focus) ?? null;

  return (
    <section class="trends" aria-label="Trends">
      <div class="chips" role="radiogroup" aria-label="Nutrient">
        {NUTRIENTS.map((x) => (
          <button key={x.key} role="radio" aria-checked={key === x.key} class={"chip" + (key === x.key ? " on" : "")} onClick={() => setKey(x.key)}>
            {x.label}
          </button>
        ))}
      </div>
      <div class="chips" role="radiogroup" aria-label="Range">
        {([7, 30] as const).map((r) => (
          <button key={r} role="radio" aria-checked={range === r} class={"chip small" + (range === r ? " on" : "")} onClick={() => setRange(r)}>
            {r} days
          </button>
        ))}
      </div>

      <div class="card">
        <p class="readout" aria-live="polite">
          {focused ? (
            <>
              <strong>
                {focused.meals ? `${fmt(focused[key])} ${nutrient.unit}` : "nothing logged"}
              </strong>{" "}
              <span class="muted small">
                {dayName(focused.date)} {short(focused.date)}
                {focused.meals > 0 && ` · ${focused.analyzed} of ${focused.meals} meal${focused.meals === 1 ? "" : "s"} analyzed`}
              </span>
            </>
          ) : avg !== null ? (
            <>
              <strong>
                {fmt(avg)} {nutrient.unit}
              </strong>{" "}
              <span class="muted small">
                a day on average, over {counted.length} fully analyzed day{counted.length === 1 ? "" : "s"}
              </span>
            </>
          ) : (
            <span class="muted">No fully analyzed days in this range yet.</span>
          )}
        </p>
        <Chart days={days} k={key} avg={avg} focus={focus} onFocus={setFocus} />
        <p class="muted small">Tap a day for its total. Paler bars: not every meal that day is analyzed yet, so the total is low.</p>
        <details>
          <summary class="small">Show as a table</summary>
          <table class="trend-table">
            <thead>
              <tr>
                <th>Day</th>
                <th>{nutrient.label}</th>
                <th>Meals</th>
              </tr>
            </thead>
            <tbody>
              {[...days].reverse().map((d) => (
                <tr key={d.date}>
                  <td>
                    {dayName(d.date)} {short(d.date)}
                  </td>
                  <td>{d.meals ? fmt(d[key]) : "—"}</td>
                  <td>{d.meals ? `${d.analyzed}/${d.meals}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </div>

      {o.latest && (
        <>
          <h2 class="section-title">Latest from the model</h2>
          <div class="card summary">
            <p>{o.latest.text}</p>
            {o.latest.suggestion && <p class="suggestion">💡 {o.latest.suggestion}</p>}
            <p class="muted small">
              {o.latest.model} · {new Date(o.latest.at).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}
            </p>
          </div>
        </>
      )}

      <p>
        <a class="link" href="#/analyze">
          {o.chat_waiting > 0
            ? `${o.chat_waiting} meal${o.chat_waiting === 1 ? "" : "s"} waiting → Analyze in a chat`
            : o.auto_model
              ? "Analyze in a chat instead"
              : "Analyze in a chat"}
        </a>
      </p>
    </section>
  );
}

// One column per day, from a zero baseline, with the average as a hairline. Bars are capped
// at 24 px and get 4 px rounded tops (the dataviz skill's mark specs); every day's whole
// column is the tap target, not just its bar.
function Chart({ days, k, avg, focus, onFocus }: { days: Day[]; k: Key; avg: number | null; focus: string | null; onFocus: (d: string | null) => void }) {
  const W = 340;
  const H = 170;
  const top = 12;
  const bottom = 22;
  const plot = H - top - bottom;
  const max = Math.max(1, ...days.map((d) => d[k]), avg ?? 0) * 1.1;
  const slot = W / days.length;
  const bw = Math.min(24, slot - 2);
  const y = (v: number) => top + plot - (v / max) * plot;
  const today = localDate();
  const labelEvery = days.length <= 7 ? 1 : 7;
  return (
    <svg class="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Daily ${k.replace("_g", "")}, last ${days.length} days`} onPointerLeave={() => onFocus(null)}>
      <line class="grid" x1={0} x2={W} y1={top + plot} y2={top + plot} />
      {days.map((d, i) => {
        const x = i * slot + (slot - bw) / 2;
        const v = d[k];
        const h = Math.max(0, top + plot - y(v));
        const r = Math.min(4, bw / 2, h);
        return (
          <g key={d.date}>
            <rect
              class={"hit" + (focus === d.date ? " on" : "")}
              x={i * slot}
              y={0}
              width={slot}
              height={H}
              tabIndex={0}
              onPointerEnter={() => onFocus(d.date)}
              onPointerDown={() => onFocus(d.date)}
              onFocus={() => onFocus(d.date)}
            />
            {d.meals > 0 && h > 0 && (
              <path
                class={"bar" + (d.complete ? "" : " partial")}
                pointer-events="none"
                d={`M${x},${top + plot} V${top + plot - h + r} Q${x},${top + plot - h} ${x + r},${top + plot - h} H${x + bw - r} Q${x + bw},${top + plot - h} ${x + bw},${top + plot - h + r} V${top + plot} Z`}
              />
            )}
            {(i % labelEvery === (days.length - 1) % labelEvery || d.date === today) && (
              <text x={i * slot + slot / 2} y={H - 6} text-anchor="middle" pointer-events="none">
                {days.length <= 7 ? dayName(d.date) : short(d.date)}
              </text>
            )}
          </g>
        );
      })}
      {avg !== null && (
        <>
          <line class="avg" x1={0} x2={W} y1={y(avg)} y2={y(avg)} pointer-events="none" />
          <text x={W - 2} y={y(avg) - 4} text-anchor="end" pointer-events="none">
            avg {fmt(avg)}
          </text>
        </>
      )}
    </svg>
  );
}
