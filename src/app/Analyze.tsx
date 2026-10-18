import { useEffect, useMemo, useState } from "preact/hooks";
import type { Meal } from "../shared/meals";
import { mealLabel } from "./MealRow";
import { onMealsChanged, showToast } from "./lib/notify";
import { timeOfDay } from "./lib/time";

type BatchView = {
  id: string;
  created_at: string;
  status: string;
  prompt: string;
  entries: { key: string; meal: Meal; files: { photo_id: string; name: string }[] }[];
};

// Export (SPEC §3): pick pending meals, freeze them into a batch, then hand the prompt and
// photos to a chat app. Importing the reply comes with step 5.
export function Analyze() {
  const [pending, setPending] = useState<Meal[] | null>(null);
  const [maxPhotos, setMaxPhotos] = useState(20);
  const [open, setOpen] = useState<BatchView[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const [p, b] = await Promise.all([
        fetch("/api/batches/pending-meals").then((r) => (r.ok ? r.json() : Promise.reject())),
        fetch("/api/batches?status=open").then((r) => (r.ok ? r.json() : Promise.reject())),
      ]);
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

  const abandon = async (id: string) => {
    if (!confirm("Abandon this batch? Its meals go back to the list, ready for another batch.")) return;
    const res = await fetch(`/api/batches/${id}/abandon`, { method: "POST" }).catch(() => null);
    if (!res?.ok) return showToast({ text: "Couldn't abandon the batch. Are you online?" });
    await load();
  };

  if (pending === null) return error ? <p class="bad">{error}</p> : <p class="muted">Loading…</p>;
  return (
    <section class="analyze" aria-label="Analyze">
      {error && <p class="bad">{error}</p>}
      {open.map((b) => (
        <BatchCard key={b.id} batch={b} onAbandon={() => abandon(b.id)} />
      ))}
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
                  <img class="thumb small" src={`/api/photos/${m.photos[0]?.id}/display`} alt="" loading="lazy" />
                  <span>
                    <strong>{m.taken_at.slice(5, 10).replace("-", "/")} {timeOfDay(m.taken_at)}</strong> {m.meal_type ?? "meal"}
                    <span class="muted small"> · {m.photos.length} photo{m.photos.length === 1 ? "" : "s"}</span>
                    {m.note && <span class="muted small"><br />{m.note}</span>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <button class="button wide" disabled={busy || selected.size === 0 || photoCount > maxPhotos} onClick={create}>
            {busy ? "Creating…" : `Create batch · ${selected.size} meal${selected.size === 1 ? "" : "s"}, ${photoCount} photo${photoCount === 1 ? "" : "s"}`}
          </button>
          {photoCount > maxPhotos && <p class="bad small">Too many photos for one message. Pick at most {maxPhotos}.</p>}
        </>
      )}
    </section>
  );
}

function BatchCard({ batch, onAbandon }: { batch: BatchView; onAbandon: () => void }) {
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
          <button class="button" disabled={files === null} onClick={share}>
            {files === null ? "Preparing photos…" : canShare ? "Share photos" : "Download photos"}
          </button>
          <span class="muted small"> to your chat app (e.g. Claude), then paste the prompt with them.</span>
        </li>
        <li class="muted small">Pasting the reply back into Bitebook comes next (import isn't built yet).</li>
      </ol>
      <div class="thumbs">
        {batch.entries.map((e) => (
          <figure key={e.key} class="thumb keyed" title={mealLabel(e.meal.taken_at, e.meal.meal_type)}>
            <img src={`/api/photos/${e.files[0]?.photo_id}/display`} alt="" loading="lazy" />
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
