import { useEffect, useMemo, useState } from "preact/hooks";
import type { Meal } from "../shared/meals";
import { extractJson, selfReportedModel } from "../shared/reply";
import { NoPhoto, mealLabel } from "./MealRow";
import { mealsChanged, onMealsChanged, showToast } from "./lib/notify";
import { timeOfDay } from "./lib/time";

type BatchView = {
  id: string;
  created_at: string;
  status: string;
  prompt: string;
  reply_model: string | null;
  imported_at: string | null;
  summary: { text: string; suggestion: string | null } | null;
  asked: { topic: string; question: string; answer: string | null }[];
  entries: { key: string; meal: Meal; files: { photo_id: string; name: string }[] }[];
};

// Export and import (SPEC §3): pick pending meals, freeze them into a batch, hand the prompt
// and photos to a chat app, then paste its reply back.
export function Analyze() {
  const [pending, setPending] = useState<Meal[] | null>(null);
  const [maxPhotos, setMaxPhotos] = useState(20);
  const [open, setOpen] = useState<BatchView[]>([]);
  const [last, setLast] = useState<BatchView | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoModel, setAutoModel] = useState<string | null>(null);

  const load = async () => {
    try {
      fetch("/api/analysis/settings")
        .then((r) => r.json() as Promise<{ model: string | null }>)
        .then((s) => setAutoModel(s.model))
        .catch(() => {});
      const [p, b, done] = await Promise.all([
        fetch("/api/batches/pending-meals").then((r) => (r.ok ? r.json() : Promise.reject())),
        fetch("/api/batches?status=open").then((r) => (r.ok ? r.json() : Promise.reject())),
        fetch("/api/batches?status=imported").then((r) => (r.ok ? r.json() : Promise.reject())),
      ]);
      setLast((done as { batches: BatchView[] }).batches[0] ?? null);
      const meals = (p as { meals: Meal[]; max_photos: number }).meals;
      setMaxPhotos((p as { max_photos: number }).max_photos);
      setPending(meals);
      setOpen((b as { batches: BatchView[] }).batches);
      // Oldest first, as many as fit in one batch.
      const pick = new Set<string>();
      let photos = 0;
      for (const m of meals) {
        if (photos + m.photos.length > (p as { max_photos: number }).max_photos) break;
        pick.add(m.id);
        photos += m.photos.length;
      }
      setSelected(pick);
      setError(null);
    } catch {
      setError("Couldn't load. Are you online?");
    }
  };
  useEffect(() => {
    load();
    return onMealsChanged(load);
  }, []);

  const photoCount = useMemo(
    () => (pending ?? []).filter((m) => selected.has(m.id)).reduce((n, m) => n + m.photos.length, 0),
    [pending, selected],
  );
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const create = async () => {
    setBusy(true);
    const res = await fetch("/api/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ meal_ids: [...selected] }),
    }).catch(() => null);
    setBusy(false);
    if (!res?.ok) {
      const err = ((await res?.json().catch(() => ({}))) as { error?: string } | undefined)?.error;
      setError(err === "too_many_photos" ? `A batch can hold at most ${maxPhotos} photos.` : "Couldn't create the batch. Are you online?");
      return;
    }
    await load();
  };

  // With automatic analysis on, the picked meals can go to the API path instead (D28).
  const analyzeNow = async () => {
    setBusy(true);
    const res = await fetch("/api/analysis/queue-pending", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ meal_ids: [...selected] }),
    }).catch(() => null);
    setBusy(false);
    const d = res?.ok ? ((await res.json()) as { queued: number }) : null;
    showToast({ text: d ? `Analyzing ${d.queued} meal${d.queued === 1 ? "" : "s"}. The estimates show on Timeline in a minute or two.` : "Couldn't queue them. Are you online?" });
    await load();
  };

  const abandon = async (id: string) => {
    if (!confirm("Abandon this batch? Its meals go back to the list, ready for another batch.")) return;
    const res = await fetch(`/api/batches/${id}/abandon`, { method: "POST" }).catch(() => null);
    if (!res?.ok) return showToast({ text: "Couldn't abandon the batch. Are you online?" });
    await load();
  };

  if (pending === null) return error ? <p class="bad">{error}</p> : <p class="muted">Loading…</p>;
  return (
    <section class="analyze" aria-label="Analyze">
      <a class="link back" href="#/trends">← Trends</a>
      {error && <p class="bad">{error}</p>}
      {open.map((b) => (
        <BatchCard key={b.id} batch={b} onAbandon={() => abandon(b.id)} onImported={load} />
      ))}
      {last?.summary && open.length === 0 && <LastSummary batch={last} />}
      <h2 class="section-title">Ready to analyze</h2>
      {pending.length === 0 ? (
        <p class="muted">{open.length ? "Every saved meal is in a batch." : "No meals waiting. New meals show up here once they're saved."}</p>
      ) : (
        <>
          <ul class="meals pick">
            {pending.map((m) => (
              <li key={m.id} class="meal">
                <label class="pick-row">
                  <input type="checkbox" checked={selected.has(m.id)} onChange={() => toggle(m.id)} />
                  {m.photos.length ? <img class="thumb small" src={`/api/photos/${m.photos[0].id}/display`} alt="" loading="lazy" /> : <NoPhoto small />}
                  <span>
                    <strong>{m.taken_at.slice(5, 10).replace("-", "/")} {timeOfDay(m.taken_at)}</strong> {m.meal_type ?? "meal"}
                    <span class="muted small"> · {m.photos.length ? `${m.photos.length} photo${m.photos.length === 1 ? "" : "s"}` : "no photo"}</span>
                    {m.note && <span class="muted small"><br />{m.note}</span>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <button class="button wide" disabled={busy || selected.size === 0 || photoCount > maxPhotos} onClick={create}>
            {busy ? "Creating…" : `Create batch · ${selected.size} meal${selected.size === 1 ? "" : "s"}, ${photoCount} photo${photoCount === 1 ? "" : "s"}`}
          </button>
          {autoModel && (
            <button class="button wide secondary" disabled={busy || selected.size === 0} onClick={analyzeNow}>
              Analyze {selected.size} with {autoModel.split("/").pop()} instead
            </button>
          )}
          {photoCount > maxPhotos && <p class="bad small">Too many photos for one message. Pick at most {maxPhotos}.</p>}
        </>
      )}
    </section>
  );
}

function LastSummary({ batch }: { batch: BatchView }) {
  const when = new Date(batch.imported_at ?? batch.created_at);
  return (
    <article class="card summary" aria-label="Last batch">
      <h2>Last batch · {batch.entries.length} meal{batch.entries.length === 1 ? "" : "s"}</h2>
      <p class="muted small">
        {batch.reply_model} · {when.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
      </p>
      <p>{batch.summary!.text}</p>
      {batch.summary!.suggestion && <p class="suggestion">💡 {batch.summary!.suggestion}</p>}
      {batch.asked.length > 0 && (
        <ul class="asked small">
          {batch.asked.map((q) => (
            <li key={q.question}>
              {q.question} <span class="muted">→ {q.answer ?? "no answer"}</span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

const MODEL_KEY = "bitebook.model";
const lastModel = () => {
  try {
    return localStorage.getItem(MODEL_KEY) ?? "";
  } catch {
    return "";
  }
};

// Step 3: paste the reply back. The server validates it all-or-nothing and says what's wrong.
function ImportBox({ batchId, onImported }: { batchId: string; onImported: () => void }) {
  const [text, setText] = useState("");
  const [model, setModel] = useState(lastModel);
  const [fromReply, setFromReply] = useState(false); // the model box was filled from the reply

  // The reply names its own model (prompt/3). Use that as the suggestion, unless the user
  // has typed their own; it's a model's claim about itself, so it stays editable.
  const onPaste = (value: string) => {
    setText(value);
    let reported: string | null = null;
    try {
      reported = selfReportedModel(extractJson(value));
    } catch {
      /* not JSON yet: nothing to read */
    }
    if (reported && (fromReply || !model.trim() || model === lastModel())) {
      setModel(reported);
      setFromReply(true);
    }
  };
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setErrors([]);
    const res = await fetch(`/api/batches/${batchId}/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reply: text, model }),
    }).catch(() => null);
    setBusy(false);
    if (!res) return setErrors(["Couldn't reach the server. Are you online?"]);
    const data = (await res.json().catch(() => ({}))) as {
      errors?: string[];
      analyzed?: number;
      skipped?: { key: string }[];
      remembered?: { action: string; code: string; name: string }[];
      asked?: unknown[];
    };
    if (!res.ok) return setErrors(data.errors ?? [`Import failed (${res.status}).`]);
    try {
      localStorage.setItem(MODEL_KEY, model.trim());
    } catch {
      /* fine: we just won't prefill next time */
    }
    const parts = [`${data.analyzed} meal${data.analyzed === 1 ? "" : "s"} analyzed`];
    if (data.skipped?.length) parts.push(`${data.skipped.length} skipped (they stay ready to analyze)`);
    if (data.asked?.length) parts.push(`${data.asked.length} question${data.asked.length === 1 ? "" : "s"} remembered`);
    if (data.remembered?.length) parts.push(`memory: ${data.remembered.map((r) => `${r.action} ${r.code} ${r.name}`).join(", ")}`);
    showToast({ text: `Imported: ${parts.join("; ")}.` }, 10_000);
    mealsChanged();
    onImported();
  };

  return (
    <div class="import">
      <textarea
        class="note"
        rows={5}
        placeholder="Paste the chat app's whole reply here"
        value={text}
        onInput={(e) => onPaste((e.target as HTMLTextAreaElement).value)}
      />
      <label class="model">
        Model{" "}
        <input
          list="models"
          value={model}
          placeholder="e.g. Claude Opus (Claude app)"
          onInput={(e) => {
            setModel((e.target as HTMLInputElement).value);
            setFromReply(false);
          }}
        />
      </label>
      {fromReply && <p class="muted small">Filled in from the reply. Models sometimes get their own name wrong, so check it.</p>}
      <datalist id="models">
        <option value="Claude Opus (Claude app)" />
        <option value="Claude Sonnet (Claude app)" />
      </datalist>
      <button class="button" disabled={busy || !text.trim() || !model.trim()} onClick={submit}>
        {busy ? "Importing…" : "Import reply"}
      </button>
      {errors.length > 0 && (
        <ul class="errors bad small">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BatchCard({ batch, onAbandon, onImported }: { batch: BatchView; onAbandon: () => void; onImported: () => void }) {
  const [files, setFiles] = useState<File[] | null>(null);
  const [copied, setCopied] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const all = batch.entries.flatMap((e) => e.files);

  // Fetch the photos up front: iOS only opens the share sheet right after a tap, so the
  // files must already be in hand when the button is pressed.
  useEffect(() => {
    let cancelled = false;
    Promise.all(
      all.map(async (f) => new File([await (await fetch(`/api/photos/${f.photo_id}/display`)).blob()], f.name, { type: "image/jpeg" })),
    )
      .then((fs) => !cancelled && setFiles(fs))
      .catch(() => !cancelled && setFiles([]));
    return () => {
      cancelled = true;
    };
  }, [batch.id]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(batch.prompt);
      setCopied(true);
    } catch {
      setShowPrompt(true);
      showToast({ text: "Couldn't copy. Select the prompt below and copy it." });
    }
  };

  const canShare = files !== null && files.length > 0 && typeof navigator.canShare === "function" && navigator.canShare({ files });
  const share = async () => {
    if (!files) return;
    if (canShare) {
      try {
        await navigator.share({ files });
      } catch (e) {
        if ((e as Error).name !== "AbortError") showToast({ text: "Sharing failed. Try Download instead." });
      }
      return;
    }
    for (const f of files) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(f);
      a.download = f.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    }
  };

  const created = new Date(batch.created_at);
  return (
    <article class="card batch" aria-label={`Batch ${batch.id}`}>
      <h2>
        Open batch · {batch.entries.length} meal{batch.entries.length === 1 ? "" : "s"}, {all.length} photo{all.length === 1 ? "" : "s"}
      </h2>
      <p class="muted small">
        Created {created.toLocaleDateString(undefined, { month: "short", day: "numeric" })} {created.toTimeString().slice(0, 5)}
      </p>
      <ol class="steps">
        <li>
          <button class="button" onClick={copy}>{copied ? "Prompt copied ✓" : "Copy prompt"}</button>
        </li>
        <li>
          <button class="button" disabled={files === null || all.length === 0} onClick={share}>
            {all.length === 0 ? "No photos in this batch" : files === null ? "Preparing photos…" : canShare ? "Share photos" : "Download photos"}
          </button>
          <span class="muted small"> to your chat app (e.g. Claude), then paste the prompt with them.</span>
        </li>
        <li>
          Paste the reply:
          <ImportBox batchId={batch.id} onImported={onImported} />
        </li>
      </ol>
      <div class="thumbs">
        {batch.entries.map((e) => (
          <figure key={e.key} class="thumb keyed" title={mealLabel(e.meal.taken_at, e.meal.meal_type)}>
            {e.files.length ? <img src={`/api/photos/${e.files[0].photo_id}/display`} alt="" loading="lazy" /> : <NoPhoto />}
            <figcaption>{e.key}</figcaption>
          </figure>
        ))}
      </div>
      <p>
        <button class="link" onClick={() => setShowPrompt((s) => !s)}>{showPrompt ? "Hide prompt" : "Show prompt"}</button>
        {" · "}
        <button class="link" onClick={onAbandon}>Abandon batch</button>
      </p>
      {showPrompt && <pre class="prompt">{batch.prompt}</pre>}
    </article>
  );
}
