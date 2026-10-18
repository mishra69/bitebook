import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ulid } from "../shared/ulid";
import { MEAL_TYPES, type MealType } from "../shared/meals";
import { preparePhoto } from "./lib/image";
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
export function Capture({ userId }: { userId: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraftState] = useState<OutboxMeal | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getDraft(userId).then((d) => d && setDraftState(d));
  }, [userId]);

  const setDraft = async (d: OutboxMeal | null) => {
    clearTimeout(noteTimer.current);
    setDraftState(d);
    if (d) await putMeal(d);
  };

  // Notes are persisted after a pause in typing, not on every keystroke.
  const noteTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const setNote = (d: OutboxMeal, note: string) => {
    const next = { ...d, note };
    setDraftState(next);
    clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => putMeal(next), 400);
  };

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

  const save = async () => {
    if (!draft) return;
    clearTimeout(noteTimer.current);
    setBusy("Saving…");
    try {
      await putMeal({ ...draft, note: draft.note?.trim() || null, draft: false });
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
    if (draft && draft.photos.length > 0 && !confirm("Discard this meal's photos?")) return;
    if (draft) await deleteMeal(draft.id);
    setDraftState(null);
  };

  const removePhoto = async (id: string) => {
    if (!draft) return;
    const photos = draft.photos.filter((p) => p.id !== id).map((p, position) => ({ ...p, position }));
    if (photos.length) await setDraft({ ...draft, photos });
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
                onClick={() => setDraft({ ...draft, mealType: draft.mealType === t ? null : t })}
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
        </section>
      )}
      {error && <p class="bad">{error}</p>}
      <div class="bottom-bar">
        {busy ? (
          <button class="primary" disabled>{busy}</button>
        ) : draft ? (
          <>
            <button class="secondary" onClick={discard}>Discard</button>
            <button class="primary" onClick={save}>Save meal</button>
          </>
        ) : (
          <button class="primary big" onClick={openCamera}>New meal</button>
        )}
      </div>
    </>
  );
}
