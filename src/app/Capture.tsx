import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ulid } from "../shared/ulid";
import { MAX_VOICE_MS, MEAL_TYPES, type MealType } from "../shared/meals";
import { diag } from "./lib/diag";
import { isStaleDraft } from "./lib/drafts";
import { preparePhoto, sha256Hex } from "./lib/image";
import { formatDuration, startRecording, type Recording } from "./lib/voice";
import { showToast } from "./lib/notify";
import { missedMealTime, timeOfDay } from "./lib/time";
import { deleteMeal, getDraft, putMeal, sync, type OutboxMeal } from "./lib/outbox";
import { deviceTz } from "./lib/time";

function suggestMealType(iso: string): MealType {
  const h = Number(iso.slice(11, 13)) + Number(iso.slice(14, 16)) / 60;
  if (h >= 4 && h < 10.5) return "breakfast";
  if (h >= 11 && h < 15) return "lunch";
  if (h >= 17 && h < 22) return "dinner";
  return "snack";
}

// The capture flow: tap → camera → draft (add more photos, meal type, note) → save.
// The draft is written to the outbox on every change (marked draft, so it isn't
// uploaded), because iOS may reload the app while the camera is open. Saving clears
// the draft flag; uploading then happens in the background.
export function Capture({ userId, missed }: { userId: string; missed?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraftState] = useState<OutboxMeal | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const draftRef = useRef<OutboxMeal | null>(null);
  draftRef.current = draft;

  // On open and on every return to the app: restore the draft, or save it if it was left
  // open (the meal's time comes from its photos, so saving late changes nothing).
  useEffect(() => {
    const check = async () => {
      const d = await getDraft(userId);
      if (!d) return;
      if (!isStaleDraft(d)) return setDraftState(d);
      await putMeal({ ...d, note: d.note?.trim() || null, draft: false, savedAt: Date.now() });
      diag("saved", { meal: d.id, photos: d.photos.length, auto: true });
      setDraftState(null);
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
  const setDraft = async (d: OutboxMeal | null) => {
    clearTimeout(noteTimer.current);
    if (d) await putMeal(d);
    setDraftState(d);
  };

  // Notes are persisted after a pause in typing, not on every keystroke.
  const noteTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const setNote = (d: OutboxMeal, note: string) => {
    const next = { ...d, note };
    setDraftState(next);
    clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => putMeal(next), 400);
  };

  // Opened as #/missed (from Timeline): start a meal without a photo, unless one is
  // already being composed. The hash goes back to #/ so a reload doesn't start another.
  useEffect(() => {
    if (!missed) return;
    history.replaceState(null, "", "#/");
    (async () => {
      if (await getDraft(userId)) return;
      await setDraft({
        id: ulid(),
        userId,
        takenAt: missedMealTime(0, null),
        tz: deviceTz(),
        mealType: null,
        note: null,
        photos: [],
        createdAt: new Date().toISOString(),
        draft: true,
        missed: { daysAgo: 0 },
      });
    })();
  }, [missed, userId]);

  // A missed meal's time follows its day and meal type.
  const setMissed = (d: OutboxMeal, daysAgo: number, mealType: MealType | null) =>
    setDraft({ ...d, mealType, missed: { daysAgo }, takenAt: missedMealTime(daysAgo, mealType) });

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
      let d = draft;
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
      await setDraft(d);
    } catch (e) {
      setError((e as Error).message === "unsupported_image" ? "This photo's format can't be read on this device." : "Couldn't process or store that photo. Is storage full?");
    } finally {
      setBusy(null);
    }
  };

  // Without a photo, the description is the whole meal: it needs a voice note or a note,
  // and a meal type to place it in the day.
  const missedIncomplete = !!draft && draft.photos.length === 0 && (!draft.mealType || (!draft.voice && !draft.note?.trim()));

  const save = async () => {
    if (!draft || missedIncomplete) return;
    clearTimeout(noteTimer.current);
    setBusy("Saving…");
    try {
      await putMeal({ ...draft, note: draft.note?.trim() || null, draft: false, savedAt: Date.now() });
      diag("saved", { meal: draft.id, photos: draft.photos.length, voice: !!draft.voice });
      setDraftState(null);
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
    if (draft && (draft.photos.length > 0 || draft.voice) && !confirm("Discard this meal?")) return;
    if (draft) await deleteMeal(draft.id);
    setDraftState(null);
  };

  const removePhoto = async (id: string) => {
    if (!draft) return;
    const photos = draft.photos.filter((p) => p.id !== id).map((p, position) => ({ ...p, position }));
    if (photos.length || draft.missed) await setDraft({ ...draft, photos });
    else {
      await deleteMeal(draft.id);
      setDraftState(null);
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
        <section class="card draft" aria-label="New meal">
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
                    aria-checked={draft.missed!.daysAgo === daysAgo}
                    class={"chip" + (draft.missed!.daysAgo === daysAgo ? " on" : "")}
                    onClick={() => setMissed(draft, daysAgo, draft.mealType)}
                  >
                    {label}
                  </button>
                ))}
              </div>
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
                  const mealType = draft.mealType === t ? null : t;
                  if (draft.missed && draft.photos.length === 0) setMissed(draft, draft.missed.daysAgo, mealType);
                  else setDraft({ ...draft, mealType });
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
            onInput={(e) => setNote(draft, (e.target as HTMLTextAreaElement).value)}
          />
          <VoiceNote
            draft={draft}
            onRecorded={async (r) => {
              const d = draftRef.current;
              if (!d) return;
              const sha256 = await sha256Hex(await r.blob.arrayBuffer());
              await setDraft({ ...d, voice: { blob: r.blob, mime: r.mime, sha256, durationMs: r.durationMs, uploaded: false } });
            }}
            onRemove={() => draftRef.current && setDraft({ ...draftRef.current, voice: undefined })}
            onError={setError}
            onRecordingChange={(on) => setBusy(on ? "Recording…" : null)}
          />
          {missedIncomplete && <p class="muted small">To save it, pick a meal type and add a voice note or a note.</p>}
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
          <button class="primary big" onClick={openCamera}>New meal</button>
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
