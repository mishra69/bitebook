import { useEffect, useState } from "preact/hooks";
import { showToast } from "./lib/notify";

type Status = {
  key: { created_at: string; last_used_at: string | null } | null;
  last_run: { done_at: string; meals: number } | null;
  sent: number;
  changed_after: number;
  waiting: number;
};

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    showToast({ text: `${what} copied.` });
  } catch {
    showToast({ text: "Couldn't copy. Select it and copy instead." });
  }
}

// In Settings: Apple Health through an iOS Shortcut (D34). The key is shown once, with the
// steps to build the Shortcut; afterwards this shows when it last ran and what it sent.
export function AppleHealth() {
  const [s, setS] = useState<Status | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const load = () =>
    fetch("/api/apple-health")
      .then((r) => r.json() as Promise<Status>)
      .then(setS)
      .catch(() => {});
  useEffect(() => {
    load();
  }, []);

  const create = async () => {
    if (s?.key && !confirm("Make a new key? The Shortcut stops working until you paste the new one into it.")) return;
    const res = await fetch("/api/apple-health/key", { method: "POST" }).catch(() => null);
    if (!res?.ok) return showToast({ text: "Couldn't make a key. Are you online?" });
    setKey(((await res.json()) as { key: string }).key);
    load();
  };
  const revoke = async () => {
    if (!confirm("Turn off the Apple Health export? The Shortcut stops working.")) return;
    await fetch("/api/apple-health/key", { method: "DELETE" }).catch(() => null);
    setKey(null);
    load();
  };

  if (!s) return null;
  const url = `${location.origin}/shortcut/meals`;
  return (
    <>
      <h2 class="section-title">Apple Health</h2>
      <div class="card apple-health">
        <p class="muted small">
          Each night an iOS Shortcut sends the day's settled meals (energy, protein, carbs, fat, fiber) to Health at their
          meal times. A meal is sent once its estimate has settled: no question waiting, unchanged for an hour.
        </p>
        {s.key ? (
          <>
            <p>
              On · {s.last_run ? `last sent ${when(s.last_run.done_at)}, ${s.last_run.meals} meal${s.last_run.meals === 1 ? "" : "s"}` : "the Shortcut hasn't run yet"}
              {` · ${s.sent} sent in all · ${s.waiting} ready to send`}
            </p>
            {s.changed_after > 0 && (
              <p class="muted small">
                {s.changed_after} meal{s.changed_after === 1 ? " was" : "s were"} re-estimated after being sent. Health keeps the earlier numbers.
              </p>
            )}
            <p>
              <button class="link" onClick={create}>New key</button> · <button class="link" onClick={revoke}>Turn off</button>
            </p>
          </>
        ) : (
          !key && <button class="button" onClick={create}>Set up the Shortcut</button>
        )}
        {key && <Guide url={url} keyValue={key} />}
      </div>
    </>
  );
}

function Guide({ url, keyValue }: { url: string; keyValue: string }) {
  const header = `Bearer ${keyValue}`;
  return (
    <div class="guide">
      <p>
        <strong>Your key</strong> (shown only now; make a new one any time):
      </p>
      <p class="mono">{keyValue}</p>
      <p>
        <button class="button secondary" onClick={() => copy(url, "Address")}>Copy address</button>{" "}
        <button class="button secondary" onClick={() => copy(header, "Header value")}>Copy header value</button>
      </p>
      <p><strong>Build the Shortcut</strong> (Shortcuts app → +, name it “Bitebook to Health”):</p>
      <ol class="steps">
        <li>
          <b>Get Contents of URL</b>: paste the address. Tap ▸ to show more: Method <b>GET</b>, Headers → add <code>Authorization</code> with the
          header value.
        </li>
        <li>
          <b>Get Dictionary Value</b>: Value for <code>meals</code> in <i>Contents of URL</i>.
        </li>
        <li>
          <b>Repeat with Each</b> item in <i>Dictionary Value</i>. Inside the repeat:
          <ol>
            <li>
              <b>Get Dictionary Value</b> <code>date</code> in <i>Repeat Item</i>, then <b>Get Dates from Input</b> on it.
            </li>
            <li>
              <b>Get Dictionary Value</b> <code>kcal</code> in <i>Repeat Item</i>, then <b>Log Health Sample</b>: Dietary Energy, value{" "}
              <i>Dictionary Value</i>, kcal, Date <i>Dates</i>.
            </li>
            <li>
              The same for <code>protein_g</code> → Protein, <code>carbs_g</code> → Carbohydrates, <code>fat_g</code> → Total Fat (all in g).
            </li>
            <li>
              <b>Get Dictionary Value</b> <code>fiber_g</code>, then <b>If</b> it <i>has any value</i>: <b>Log Health Sample</b> Fiber (g),
              Date <i>Dates</i>. Older estimates have no fiber.
            </li>
          </ol>
        </li>
        <li>
          After <b>End Repeat</b>: <b>Get Dictionary Value</b> <code>done_url</code> in <i>Contents of URL</i>, then <b>Get Contents of URL</b>{" "}
          on it with Method <b>POST</b> and the same Authorization header. This tells Bitebook the meals are in Health, so they're never sent twice.
        </li>
        <li>Run it once by hand and allow Health access when asked. The first run sends every past meal.</li>
        <li>
          Automation tab → + → <b>Time of Day</b>, 11:45 PM, Daily → <b>Run Immediately</b> → run “Bitebook to Health”.
        </li>
      </ol>
    </div>
  );
}
