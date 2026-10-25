import { useLayoutEffect, useRef, useState } from "preact/hooks";
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
        <p class="readout">
          {avg !== null ? (
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
        <Chart days={days} k={key} unit={nutrient.unit} avg={avg} focus={focus} onFocus={setFocus} />
        <p class="muted small">Drag across the chart to read each day. Paler bars: not every meal that day is analyzed yet, so the total is low.</p>
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
// at 24 px and get 4 px rounded tops (the dataviz skill's mark specs).
//
// Read by dragging, as in Cadence's charts (github.com/mishra69/cadence,
// frontend/js/charts.js): a pill pinned to the top of the plot tracks the finger's x and
// stays after it lifts, because that's when the number is read. The drag is taken on a
// <div>, not the <svg>: WebKit ignores touch-action on SVG elements, so on an iPhone the
// page would scroll out from under the read. The cost is that the plot itself doesn't
// scroll the page; everything around it does.
function Chart({ days, k, unit, avg, focus, onFocus }: { days: Day[]; k: Key; unit: string; avg: number | null; focus: string | null; onFocus: (d: string | null) => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const W = 340;
  const H = 150;
  const bottom = 22;
  const plot = H - bottom;
  const max = Math.max(1, ...days.map((d) => d[k]), avg ?? 0) * 1.1;
  const slot = W / days.length;
  const bw = Math.min(24, slot - 2);
  const y = (v: number) => plot - (v / max) * plot;
  const today = localDate();
  const labelEvery = days.length <= 7 ? 1 : 7;
  const fi = days.findIndex((d) => d.date === focus);

  // The day under a screen x: whole columns are the target, not just the bars.
  const pick = (clientX: number) => {
    const svg = wrap.current?.querySelector("svg");
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const i = Math.floor(((clientX - r.left) / r.width) * days.length);
    onFocus(days[Math.max(0, Math.min(days.length - 1, i))].date);
  };
  const onPointer = (e: PointerEvent) => {
    e.preventDefault(); // a drag that starts on the plot is a read, never a scroll
    pick(e.clientX);
  };

  // Centre the pill on the column, clamped to the plot: at the ends of the range an
  // x-centred pill would hang off the card, which on a phone is a sideways scrollbar.
  useLayoutEffect(() => {
    const t = tip.current;
    const w = wrap.current;
    if (!t || !w || fi < 0) return;
    const cx = ((fi + 0.5) / days.length) * w.clientWidth;
    t.style.left = `${Math.max(0, Math.min(w.clientWidth - t.offsetWidth, cx - t.offsetWidth / 2))}px`;
  });

  const d = fi >= 0 ? days[fi] : null;
  return (
    <div
      ref={wrap}
      class="chart-plot"
      tabIndex={0}
      aria-label={`Daily ${k.replace("_g", "")}, last ${days.length} days. Drag across, or use the arrow keys, to read a day.`}
      onPointerDown={(e) => {
        try {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); // keeps the read alive past the edge
        } catch {
          /* already gone; the drag still works while over the plot */
        }
        onPointer(e);
      }}
      onPointerMove={onPointer}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const i = fi < 0 ? days.length - 1 : Math.max(0, Math.min(days.length - 1, fi + (e.key === "ArrowLeft" ? -1 : 1)));
        onFocus(days[i].date);
      }}
    >
      <div ref={tip} class={"chart-tip" + (d ? " is-on" : "")} aria-live="polite">
        {d && (
          <>
            <strong>{d.meals ? `${fmt(d[k])} ${unit}` : "nothing logged"}</strong>
            <br />
            <span class="ro-dim">
              {dayName(d.date)} {short(d.date)}
              {d.meals > 0 && ` · ${d.analyzed} of ${d.meals} analyzed`}
            </span>
          </>
        )}
      </div>
      <svg class="chart" viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
        {fi >= 0 && <rect class="focus-band" x={fi * slot} y={0} width={slot} height={plot} />}
        <line class="grid" x1={0} x2={W} y1={plot} y2={plot} />
        {days.map((d, i) => {
          const x = i * slot + (slot - bw) / 2;
          const h = Math.max(0, plot - y(d[k]));
          const r = Math.min(4, bw / 2, h);
          return (
            <g key={d.date}>
              {d.meals > 0 && h > 0 && (
                <path
                  class={"bar" + (d.complete ? "" : " partial")}
                  d={`M${x},${plot} V${plot - h + r} Q${x},${plot - h} ${x + r},${plot - h} H${x + bw - r} Q${x + bw},${plot - h} ${x + bw},${plot - h + r} V${plot} Z`}
                />
              )}
              {(i % labelEvery === (days.length - 1) % labelEvery || d.date === today) && (
                <text x={i * slot + slot / 2} y={H - 6} text-anchor="middle">
                  {days.length <= 7 ? dayName(d.date) : short(d.date)}
                </text>
              )}
            </g>
          );
        })}
        {avg !== null && (
          <>
            <line class="avg" x1={0} x2={W} y1={y(avg)} y2={y(avg)} />
            <text x={2} y={y(avg) - 4}>
              avg {fmt(avg)}
            </text>
          </>
        )}
      </svg>
    </div>
  );
}
