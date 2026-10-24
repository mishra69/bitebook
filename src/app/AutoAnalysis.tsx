import { useEffect, useState } from "preact/hooks";
import { showToast } from "./lib/notify";

type Settings = { model: string | null; suggested: string[]; configured: boolean; waiting: number };
type Day = { day: string; runs: number; cost_usd: number; input_tokens: number; output_tokens: number; avg_latency_ms: number };

const usd = (n: number) => (n < 0.1 ? `${(n * 100).toFixed(1)}¢` : `$${n.toFixed(2)}`);

// In Settings: which model analyzes new meals automatically (D27, D28), and what it costs.
export function AutoAnalysis() {
  const [s, setS] = useState<Settings | null>(null);
  const [choice, setChoice] = useState("");
  const [usage, setUsage] = useState<{ days: Day[]; meals_30d: number } | null>(null);

  const load = () => {
    fetch("/api/analysis/settings")
      .then((r) => r.json() as Promise<Settings>)
      .then((d) => {
        setS(d);
        setChoice(d.model ?? d.suggested[0] ?? "");
      })
      .catch(() => {});
    fetch("/api/analysis/usage")
      .then((r) => r.json() as Promise<{ days: Day[]; meals_30d: number }>)
      .then(setUsage)
      .catch(() => {});
  };
  useEffect(load, []);

  const save = async (model: string | null) => {
    const res = await fetch("/api/analysis/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    }).catch(() => null);
    if (!res?.ok) return showToast({ text: "Couldn't save. Is that a valid OpenRouter model id?" });
    showToast({ text: model ? `New meals will be analyzed by ${model}.` : "Automatic analysis is off." });
    load();
  };

  const queuePending = async () => {
    const res = await fetch("/api/analysis/queue-pending", { method: "POST" }).catch(() => null);
    const d = res?.ok ? ((await res.json()) as { queued: number }) : null;
    showToast({ text: d ? (d.queued ? `Analyzing ${d.queued} waiting meal${d.queued === 1 ? "" : "s"}.` : "No meals are waiting.") : "Couldn't queue them." });
    load();
  };

  if (!s) return null;
  const week = usage?.days.slice(0, 7) ?? [];
  const weekCost = week.reduce((n, d) => n + (d.cost_usd ?? 0), 0);
  const weekRuns = week.reduce((n, d) => n + d.runs, 0);

  return (
    <>
      <h2 class="section-title">Automatic analysis</h2>
      <div class="card auto-analysis">
        <p class="muted small">
          Each new meal is analyzed a minute or so after it's saved, through OpenRouter. The model's questions and your
          corrections happen on the meal itself. The chat handoff on Analyze still works.
        </p>
        {!s.configured && <p class="bad small">The OpenRouter key isn't set on the server yet (secret OPENROUTER_API_KEY).</p>}
        <p>
          {s.model ? (
            <>
              On · <strong>{s.model}</strong>
            </>
          ) : (
            "Off"
          )}
        </p>
        <label class="small">
          Model (any OpenRouter id that takes images)
          <input class="model-input" list="model-suggestions" value={choice} onInput={(e) => setChoice((e.target as HTMLInputElement).value)} />
          <datalist id="model-suggestions">
            {s.suggested.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
        <p>
          <button class="button" disabled={!choice.trim() || choice.trim() === s.model} onClick={() => save(choice.trim())}>
            {s.model ? "Switch model" : "Turn on"}
          </button>{" "}
          {s.model && (
            <>
              {s.waiting > 0 && (
                <>
                  <button class="button secondary" onClick={queuePending}>
                    Analyze {s.waiting} waiting meal{s.waiting === 1 ? "" : "s"}
                  </button>{" "}
                </>
              )}
              <button class="link" onClick={() => save(null)}>Turn off</button>
            </>
          )}
        </p>
        {usage && usage.days.length > 0 && (
          <div class="usage">
            <p>
              <strong>Last 7 days:</strong> {usd(weekCost)} for {weekRuns} run{weekRuns === 1 ? "" : "s"}
              {weekRuns > 0 && ` · ${usd(weekCost / weekRuns)} a run`} · about {usd(weekCost / Math.max(week.length, 1))} a day
            </p>
            <ul class="usage-days">
              {usage.days.slice(0, 14).map((d) => (
                <li key={d.day}>
                  {d.day.slice(5)} · {usd(d.cost_usd ?? 0)} · {d.runs} run{d.runs === 1 ? "" : "s"} · {Math.round((d.input_tokens ?? 0) / 1000)}k in /{" "}
                  {Math.round((d.output_tokens ?? 0) / 1000)}k out · {Math.round((d.avg_latency_ms ?? 0) / 1000)} s
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </>
  );
}
