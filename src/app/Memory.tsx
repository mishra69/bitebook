import { useEffect, useState } from "preact/hooks";
import { showToast } from "./lib/notify";
import { ReminderSettings } from "./Reminders";

type Note = { id: string; body: string };
type Question = { id: string; topic: string; question: string; answer: string | null; created_at: string };
type Food = {
  code: string;
  name: string;
  serving: string;
  kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  status: "active" | "retired";
};

// What every prompt is told about you (SPEC §3, principle 9). Both parts are optional:
// notes are yours to write; remembered foods are kept by the replies themselves.
export function Memory() {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [foods, setFoods] = useState<Food[] | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [draft, setDraft] = useState("");

  const load = async () => {
    try {
      const [n, f, q] = await Promise.all([
        fetch("/api/notes").then((r) => r.json()),
        fetch("/api/foods").then((r) => r.json()),
        fetch("/api/questions").then((r) => r.json()),
      ]);
      setNotes((n as { notes: Note[] }).notes);
      setFoods((f as { foods: Food[] }).foods);
      setQuestions((q as { questions: Question[] }).questions);
    } catch {
      showToast({ text: "Couldn't load memory. Are you online?" });
    }
  };
  useEffect(() => void load(), []);

  const call = async (url: string, method: string, body?: unknown) => {
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).catch(() => null);
    if (!res?.ok) showToast({ text: "Couldn't save. Are you online?" });
    await load();
    return res?.ok ?? false;
  };

  const active = (foods ?? []).filter((f) => f.status === "active");
  const retired = (foods ?? []).filter((f) => f.status === "retired");
  const n = (v: number | null) => (v === null ? "?" : Math.round(v * 10) / 10);

  return (
    <section class="memory" aria-label="Memory">
      <h2 class="section-title">Notes</h2>
      <p class="muted small">
        Every analysis sees these. Useful: goals, your usual portions, recipes you make often (e.g. what goes into your lassi
        shake).
      </p>
      {notes?.map((note) => (
        <NoteEditor key={note.id} note={note} onSave={(body) => call(`/api/notes/${note.id}`, "PUT", { body })} onDelete={() => call(`/api/notes/${note.id}`, "DELETE")} />
      ))}
      <div class="card">
        <textarea class="note" rows={3} maxLength={2000} placeholder="Add a note…" value={draft} onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)} />
        <button
          class="button"
          disabled={!draft.trim()}
          onClick={async () => (await call("/api/notes", "POST", { body: draft })) && setDraft("")}
        >
          Add note
        </button>
      </div>

      <h2 class="section-title">Remembered foods</h2>
      <p class="muted small">Added by the analyses when they read a label or notice a dish you eat often. Retire one if it's wrong.</p>
      {foods !== null && active.length === 0 && <p class="muted">Nothing remembered yet.</p>}
      <ul class="meals">
        {active.map((f) => (
          <li key={f.code} class="meal">
            <div class="meal-head">
              <strong>{f.code}</strong> {f.name}
              <button class="link push" onClick={() => call(`/api/foods/${f.code}/retire`, "POST")}>
                Retire
              </button>
            </div>
            <p class="muted small">
              {f.serving} · {n(f.kcal)} kcal · P{n(f.protein_g)} C{n(f.carbs_g)} F{n(f.fat_g)}
              {f.fiber_g !== null && ` · fiber ${n(f.fiber_g)} g`}
            </p>
          </li>
        ))}
      </ul>
      <h2 class="section-title">Questions already asked</h2>
      <p class="muted small">Every analysis sees these, so it won't ask them again. Tap "Ask again" to let a question come back.</p>
      {questions.length === 0 && <p class="muted">No questions asked yet.</p>}
      <ul class="meals">
        {questions.map((q) => (
          <li key={q.id} class="meal">
            <div class="meal-head">
              <span>
                {q.question}
                <br />
                <span class="muted small">→ {q.answer ?? "no answer"}</span>
              </span>
              <button class="link push" onClick={() => call(`/api/questions/${q.id}`, "DELETE")}>
                Ask again
              </button>
            </div>
          </li>
        ))}
      </ul>
      {retired.length > 0 && (
        <details>
          <summary class="muted small">Retired ({retired.length})</summary>
          <ul class="meals">
            {retired.map((f) => (
              <li key={f.code} class="meal">
                <div class="meal-head">
                  <span class="muted">
                    {f.code} {f.name}
                  </span>
                  <button class="link push" onClick={() => call(`/api/foods/${f.code}/restore`, "POST")}>
                    Restore
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
      <ReminderSettings />
    </section>
  );
}

function NoteEditor({ note, onSave, onDelete }: { note: Note; onSave: (body: string) => void; onDelete: () => void }) {
  const [body, setBody] = useState(note.body);
  return (
    <div class="card">
      <textarea class="note" rows={3} maxLength={2000} value={body} onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)} />
      <button class="button" disabled={body.trim() === note.body || !body.trim()} onClick={() => onSave(body)}>
        Save
      </button>{" "}
      <button class="link" onClick={() => confirm("Delete this note?") && onDelete()}>
        Delete
      </button>
    </div>
  );
}
