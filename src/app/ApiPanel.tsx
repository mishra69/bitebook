import { useEffect, useRef, useState } from "preact/hooks";
import type { Meal } from "../shared/meals";
import { MAX_VOICE_MS } from "../shared/meals";
import { formatDuration, startRecording, type Recording } from "./lib/voice";
import { showToast } from "./lib/notify";

// The API path on a meal (D28): its run's progress, the model's questions waiting for an
// answer, and "Correct this". Answers and corrections can be typed or spoken; either way
// the meal is re-estimated, and the earlier estimate is kept.
export function ApiPanel({ meal, onChanged }: { meal: Meal; onChanged: () => void }) {
  const api = meal.api;
  const working = api?.job && (api.job.status === "queued" || api.job.status === "running");

  // While a run is in flight, check back every few seconds.
  useEffect(() => {
    if (!working) return;
    const t = setInterval(onChanged, 5000);
    return () => clearInterval(t);
  }, [working]);

  const post = async (path: string, body?: unknown) => {
    const res = await fetch(`/api/meals/${meal.id}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    }).catch(() => null);
    if (!res?.ok) {
      const err = res ? ((await res.json().catch(() => ({}))) as { error?: string }).error : "offline";
      showToast({ text: err === "off" ? "Automatic analysis is off (Memory → Automatic analysis)." : "Couldn't send that. Are you online?" });
      return false;
    }
    onChanged();
    return true;
  };

  return (
    <>
      {working && (
        <p class="card api-status">
          {api!.job!.kind === "revise" ? "Revising the estimate…" : "Analyzing…"} <span class="muted small">This takes a minute or so.</span>
        </p>
      )}
      {api?.job?.status === "failed" && (
        <p class="card api-status bad">
          The analysis failed: {api.job.error ?? "unknown error"}.{" "}
          <button class="link" onClick={() => post("retry")}>Try again</button>
        </p>
      )}
      {!working && api && api.questions.length > 0 && <Questions meal={meal} post={post} onChanged={onChanged} />}
      {!working && (meal.analyses?.length ?? 0) > 0 && <Correct post={post} />}
    </>
  );
}

type Post = (path: string, body?: unknown) => Promise<boolean>;

function Questions({ meal, post, onChanged }: { meal: Meal; post: Post; onChanged: () => void }) {
  const qs = meal.api!.questions;
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const send = async () => {
    const list = qs.map((q) => ({ id: q.id, answer: answers[q.id] ?? "" })).filter((a) => a.answer.trim());
    if (list.length && (await post("answers", { answers: list }))) setAnswers({});
  };
  const skip = async (id: string) => {
    await fetch(`/api/questions/${id}`, { method: "DELETE" }).catch(() => {});
    onChanged();
  };
  return (
    <section class="card questions" aria-label="Questions">
      <p><strong>❓ To sharpen this estimate</strong></p>
      {qs.map((q) => (
        <div key={q.id} class="question">
          <p>{q.question}</p>
          <TextWithVoice
            value={answers[q.id] ?? ""}
            placeholder="Your answer"
            onChange={(v) => setAnswers((a) => ({ ...a, [q.id]: v }))}
          />
          <button class="link small" onClick={() => skip(q.id)}>Skip this question</button>
        </div>
      ))}
      <button class="button" disabled={!qs.some((q) => answers[q.id]?.trim())} onClick={send}>Send answers</button>
    </section>
  );
}

function Correct({ post }: { post: Post }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  if (!open) {
    return (
      <p>
        <button class="link" onClick={() => setOpen(true)}>Something wrong? Correct this</button>
      </p>
    );
  }
  return (
    <section class="card correct" aria-label="Correct this">
      <p class="muted small">Say what's wrong, e.g. "it was paneer, not chicken" or "I only ate half". The meal is re-estimated; the old estimate is kept.</p>
      <TextWithVoice value={text} placeholder="What's wrong?" onChange={setText} />
      <button
        class="button"
        disabled={!text.trim()}
        onClick={async () => {
          if (await post("correct", { text })) {
            setText("");
            setOpen(false);
          }
        }}
      >
        Send correction
      </button>{" "}
      <button class="link" onClick={() => setOpen(false)}>Cancel</button>
    </section>
  );
}

// A text box with a 🎙 button: what's said is transcribed on the server and added to the text.
function TextWithVoice({ value, placeholder, onChange }: { value: string; placeholder: string; onChange: (v: string) => void }) {
  const [rec, setRec] = useState<{ stop: () => Promise<Recording>; started: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const latest = useRef(value);
  latest.current = value;

  useEffect(() => {
    if (!rec) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [rec]);

  const finish = async (r: Recording) => {
    setRec(null);
    if (r.blob.size === 0) return;
    setBusy(true);
    try {
      const res = await fetch("/api/analysis/transcribe", { method: "POST", headers: { "Content-Type": r.mime }, body: r.blob });
      const { text } = (await res.json()) as { text?: string };
      if (!res.ok || !text) throw new Error();
      onChange(latest.current.trim() ? `${latest.current.trim()} ${text}` : text);
    } catch {
      showToast({ text: "Couldn't transcribe that. Try again, or type it." });
    } finally {
      setBusy(false);
    }
  };

  const toggle = async () => {
    if (rec) return rec.stop().then(finish);
    try {
      const r = await startRecording(MAX_VOICE_MS, finish);
      setNow(Date.now());
      setRec(r);
    } catch {
      showToast({ text: "Bitebook couldn't use the microphone." });
    }
  };

  return (
    <div class="text-voice">
      <textarea rows={2} maxLength={2000} placeholder={placeholder} value={value} onInput={(e) => onChange((e.target as HTMLTextAreaElement).value)} />
      <button class={"voice" + (rec ? " recording" : "")} disabled={busy} onClick={toggle}>
        {busy ? "Transcribing…" : rec ? `● ${formatDuration(now - rec.started)} · tap to stop` : "🎙 Say it"}
      </button>
    </div>
  );
}
