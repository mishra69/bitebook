import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ulid } from "../shared/ulid";
import { MAX_VOICE_MS, MEAL_TYPES, type MealType } from "../shared/meals";
import { diag } from "./lib/diag";
import { isStaleDraft } from "./lib/drafts";
import { preparePhoto, sha256Hex } from "./lib/image";
import { formatDuration, startRecording, type Recording } from "./lib/voice";
import { showToast } from "./lib/notify";
import { daysAgoOf, deviceTz, localIso, missedMealOnDay, missedMealTime, suggestMealType, timeOfDay } from "./lib/time";
import { deleteMeal, getDraft, putMeal, sync, type OutboxMeal } from "./lib/outbox";

// The capture flow: tap → camera → draft (add more photos, meal type, note) → save.
// The draft is written to the outbox on every change (marked draft, so it isn't
// uploaded), because iOS may reload the app while the camera is open. Saving clears
// the draft flag; uploading then happens in the background.
export function Capture({ userId, missed }: { userId: string; missed?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraftState] = useState<OutboxMeal | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The newest draft, including an edit still being written to the phone. Every edit
  // starts from it, not from what's on screen: two quick edits (tapping "lunch", then
  // typing a note) would otherwise both start from the same old draft, and the second
  // would undo the first.
  const latest = useRef<OutboxMeal | null>(null);
  const writes = useRef<Promise<void>>(Promise.resolve());
  const show = (d: OutboxMeal | null) => {
    latest.current = d;
    setDraftState(d);
  };

  // On open and on every return to the app: restore the draft, or save it if it was left
  // open (the meal's time comes from its photos, so saving late changes nothing).
  useEffect(() => {
    const check = async () => {
      const d = await getDraft(userId);
      if (!d) return;
      if (!isStaleDraft(d)) return show(d);
      await putMeal({ ...d, note: d.note?.trim() || null, draft: false, savedAt: Date.now() });
      diag("saved", { meal: d.id, photos: d.photos.length, auto: true });
      show(null);
      const n = d.photos.length;
      showToast({ text: `Saved your ${timeOfDay(d.takenAt)} meal (${n} photo${n === 1 ? "" : "s"}) that was left open.` }, 10_000);
      sync();
    };
    check();
    const onVisible = () => document.visibilityState === "visible" && check();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [userId]);

  // Store first, then show: a photo on screen is a photo already safe on the phone.
  // Writes go one at a time, in order, so an older draft can never land after a newer one.
  const setDraft = (d: OutboxMeal) => {
    clearTimeout(noteTimer.current);
    latest.current = d;
    const done = writes.current.then(() => putMeal(d)).then(() => {
      if (latest.current === d) setDraftState(d);
    });
    writes.current = done.catch(() => {});
    return done;
  };
  // An edit to the newest draft.
  const edit = (fn: (d: OutboxMeal) => OutboxMeal) => (latest.current ? setDraft(fn(latest.current)) : Promise.resolve());

  // Notes are shown as typed and stored after a pause in typing, not on every keystroke.
  const noteTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const setNote = (note: string) => {
    if (!latest.current) return;
    show({ ...latest.current, note });
    clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => latest.current && setDraft(latest.current), 400);
  };

  // A meal without a photo (D24), unless one is already being composed.
  const startMissed = async () => {
    if (await getDraft(userId)) return;
    const takenAt = missedMealTime(localIso(new Date()), 0);
    await setDraft({
      id: ulid(),
      userId,
      takenAt,
      tz: deviceTz(),
      mealType: suggestMealType(takenAt),
      note: null,
      photos: [],
      createdAt: new Date().toISOString(),
      draft: true,
      missed: { daysAgo: 0 },
    });
  };

  // Opened as #/missed (an older link): the hash goes back to #/ so a reload doesn't
  // start another.
  useEffect(() => {
    if (!missed) return;
    history.replaceState(null, "", "#/");
    startMissed();
  }, [missed, userId]);

  // The form opens at the top of Meals: bring it into view, wherever the page was scrolled.
  const form = useRef<HTMLElement>(null);
  useEffect(() => {
    if (draft) form.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [draft?.id]);

  // A missed meal's time, set by the day chips and the hour steps (D39). The meal type
  // follows the time until the user picks one.
  const setMissedTime = (time: (takenAt: string) => string) =>
    edit((d) => {
      const takenAt = time(d.takenAt);
      const picked = d.missed?.typePicked;
      return { ...d, takenAt, mealType: picked ? d.mealType : suggestMealType(takenAt), missed: { daysAgo: daysAgoOf(takenAt), typePicked: picked } };
    });

  const urls = useMemo(() => draft?.photos.map((p) => URL.createObjectURL(p.display)) ?? [], [draft?.photos]);
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);

  const openCamera = () => {
    setError(null);
    input.current!.value = "";
    input.current!.click();
  };

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy("Processing photo…");
    try {
      let d = latest.current;
      for (const f of Array.from(files)) {
        const p = await preparePhoto(f, new Date());
        const photo = {
          id: ulid(),
          position: d?.photos.length ?? 0,
          original: p.original,
          mime: p.mime,
          sha256: p.sha256,
          display: p.display,
          displaySha256: p.displaySha256,
          width: p.width,
          height: p.height,
          uploaded: { original: false, display: false },
          takenAt: p.takenAt,
          addedAt: Date.now(),
        };
        d = d
          ? { ...d, photos: [...d.photos, photo] }
          : {
              id: ulid(),
              userId,
              takenAt: p.takenAt,
              tz: deviceTz(),
              mealType: suggestMealType(p.takenAt),
              note: null,
              photos: [photo],
              createdAt: new Date().toISOString(),
              draft: true,
            };
      }
      if (d) await setDraft(d);
    } catch (e) {
      setError((e as Error).message === "unsupported_image" ? "This photo's format can't be read on this device." : "Couldn't process or store that photo. Is storage full?");
    } finally {
      setBusy(null);
    }
  };

  // Without a photo, the description is the whole meal: it needs a voice note or a note,
  // and a meal type to place it in the day.
  const missedIncomplete = !!draft && draft.photos.length === 0 && !draft.voice && !draft.note?.trim();

  const save = async () => {
    if (!latest.current || missedIncomplete) return;
    clearTimeout(noteTimer.current);
    setBusy("Saving…");
    try {
      await writes.current; // a draft write landing after this would turn the meal back into a draft
      const d = latest.current;
      await putMeal({ ...d, note: d.note?.trim() || null, draft: false, savedAt: Date.now() });
      diag("saved", { meal: d.id, photos: d.photos.length, voice: !!d.voice });
      show(null);
      // Ask iOS not to evict the outbox under storage pressure. Best effort.
      navigator.storage?.persist?.().catch(() => {});
      sync();
    } catch {
      setError("Couldn't save on this device. Is storage full?");
    } finally {
      setBusy(null);
    }
  };

  const discard = async () => {
    const d = latest.current;
    if (d && (d.photos.length > 0 || d.voice) && !confirm("Discard this meal?")) return;
    clearTimeout(noteTimer.current);
    await writes.current;
    if (d) await deleteMeal(d.id);
    show(null);
  };

  const removePhoto = async (id: string) => {
    const d = latest.current;
    if (!d) return;
    const photos = d.photos.filter((p) => p.id !== id).map((p, position) => ({ ...p, position }));
    if (photos.length || d.missed) await setDraft({ ...d, photos });
    else {
      clearTimeout(noteTimer.current);
      await writes.current;
      await deleteMeal(d.id);
      show(null);
    }
  };

  return (
    <>
      <input
        ref={input}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => onFiles((e.target as HTMLInputElement).files)}
      />
      {draft && (
        <section ref={form} class="card draft" aria-label="New meal">
          {draft.missed && (
            <>
              <p class="missed-intro">
                <strong>A meal you missed.</strong> Say what you ate and roughly how much; a photo is optional.
              </p>
              <div class="chips" role="radiogroup" aria-label="Day">
                {["Today", "Yesterday"].map((label, daysAgo) => (
                  <button
                    key={label}
                    role="radio"
                    aria-checked={daysAgoOf(draft.takenAt) === daysAgo}
                    class={"chip" + (daysAgoOf(draft.takenAt) === daysAgo ? " on" : "")}
                    onClick={() => setMissedTime((t) => missedMealOnDay(t, daysAgo))}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <MissedTime takenAt={draft.takenAt} onStep={(h) => setMissedTime((t) => missedMealTime(t, h))} />
            </>
          )}
          <div class="thumbs">
            {draft.photos.map((p, i) => (
              <figure key={p.id} class="thumb">
                <img src={urls[i]} alt="" />
                <button class="thumb-remove" aria-label="Remove photo" onClick={() => removePhoto(p.id)}>×</button>
              </figure>
            ))}
            <button class="thumb add" onClick={openCamera} disabled={!!busy} aria-label="Add another photo">+</button>
          </div>
          <div class="chips" role="radiogroup" aria-label="Meal type">
            {MEAL_TYPES.map((t) => (
              <button
                key={t}
                role="radio"
                aria-checked={draft.mealType === t}
                class={"chip" + (draft.mealType === t ? " on" : "")}
                onClick={() => {
                  const d = latest.current!;
                  const mealType = d.mealType === t ? null : t;
                  edit((x) => ({ ...x, mealType, ...(x.missed ? { missed: { ...x.missed, typePicked: true } } : {}) }));
                }}
              >
                {t}
              </button>
            ))}
          </div>
          <textarea
            class="note"
            rows={2}
            maxLength={2000}
            placeholder="Note (optional): half eaten, no oil, shared…"
            value={draft.note ?? ""}
            onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)}
          />
          <VoiceNote
            draft={draft}
            onRecorded={async (r) => {
              const sha256 = await sha256Hex(await r.blob.arrayBuffer());
              await edit((d) => ({ ...d, voice: { blob: r.blob, mime: r.mime, sha256, durationMs: r.durationMs, uploaded: false } }));
            }}
            onRemove={() => edit((d) => ({ ...d, voice: undefined }))}
            onError={setError}
            onRecordingChange={(on) => setBusy(on ? "Recording…" : null)}
          />
          {missedIncomplete && <p class="muted small">To save it, add a voice note or a note.</p>}
        </section>
      )}
      {error && <p class="bad">{error}</p>}
      <div class="bottom-bar">
        {busy ? (
          <button class="primary" disabled>{busy}</button>
        ) : draft ? (
          <>
            <button class="secondary" onClick={discard}>Discard</button>
            <button class="primary" onClick={save} disabled={missedIncomplete}>Save meal</button>
          </>
        ) : (
          <>
            <button class="secondary big missed" onClick={startMissed}>＋ Missed meal</button>
            <button class="primary big" onClick={openCamera}>New meal</button>
          </>
        )}
      </div>
    </>
  );
}

// One spoken note per meal, up to MAX_VOICE_MS (D21). It's stored in the draft like the
// photos, uploaded with the meal, and transcribed on the server; the text isn't editable.
function VoiceNote({
  draft,
  onRecorded,
  onRemove,
  onError,
  onRecordingChange,
}: {
  draft: OutboxMeal;
  onRecorded: (r: Recording) => Promise<void>;
  onRemove: () => void;
  onError: (msg: string | null) => void;
  onRecordingChange: (recording: boolean) => void;
}) {
  const [rec, setRec] = useState<{ stop: () => Promise<Recording>; started: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  const url = useMemo(() => (draft.voice ? URL.createObjectURL(draft.voice.blob) : null), [draft.voice?.blob]);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);

  const finish = async (r: Recording) => {
    setRec(null);
    onRecordingChange(false);
    if (r.blob.size > 0) await onRecorded(r);
  };

  useEffect(() => {
    if (!rec) return;
    const tick = setInterval(() => setNow(Date.now()), 250);
    // Leaving the app ends the recording (iOS would freeze it anyway); keep what was said.
    const onHidden = () => document.visibilityState === "hidden" && rec.stop().then(finish);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, [rec]);

  const start = async () => {
    onError(null);
    try {
      const r = await startRecording(MAX_VOICE_MS, finish);
      setNow(Date.now());
      setRec(r);
      onRecordingChange(true);
    } catch {
      onError("Bitebook couldn't use the microphone. Allow it when asked, or check Settings → Safari → Microphone.");
    }
  };

  if (rec) {
    return (
      <button class="voice recording" onClick={() => rec.stop().then(finish)}>
        ● Recording {formatDuration(now - rec.started)} / {formatDuration(MAX_VOICE_MS)} · tap to stop
      </button>
    );
  }
  if (draft.voice && url) {
    return (
      <div class="voice saved">
        <span>🎙 Voice note · {formatDuration(draft.voice.durationMs)}</span>
        <audio controls src={url} preload="metadata" />
        <button class="link" onClick={onRemove}>Remove</button>
      </div>
    );
  }
  return (
    <button class="voice" onClick={start}>
      🎙 Add a voice note (up to {formatDuration(MAX_VOICE_MS)})
    </button>
  );
}

// When a missed meal was eaten: now, stepped back an hour at a time. "+1 h" shows once
// there's room to step forward again (D39).
function MissedTime({ takenAt, onStep }: { takenAt: string; onStep: (hours: number) => void }) {
  const at = new Date(Date.parse(takenAt));
  const canForward = Date.now() - at.getTime() >= 3_600_000;
  return (
    <div class="missed-time">
      <button class="chip" aria-label="An hour earlier" onClick={() => onStep(-1)}>−1 h</button>
      <strong aria-live="polite">{at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</strong>
      {canForward && <button class="chip" aria-label="An hour later" onClick={() => onStep(1)}>+1 h</button>}
    </div>
  );
}
