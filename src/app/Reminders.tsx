import { useEffect, useState } from "preact/hooks";
import { reminderState, sendTestReminder, turnOnReminders } from "./lib/reminders";
import { showToast } from "./lib/notify";

const DISMISS_KEY = "bitebook.remindersDismissed";
const WHAT = "A check every night at 10:30, and a nudge in the morning after a day with nothing logged.";

const why: Record<string, string | undefined> = {
  "needs-install": "Reminders work only in the home-screen app: open Bitebook from your Home Screen.",
  blocked: "Notifications are blocked for Bitebook. Turn them on in Settings → Notifications → Bitebook.",
  unsupported: "This browser can't show notifications.",
  dismissed: "No problem. You can turn them on here any time.",
};

async function turnOn(after: (state: ReturnType<typeof reminderState>) => void) {
  const r = await turnOnReminders().catch(() => ({ ok: false, reason: "error" }));
  if (r.ok) showToast({ text: "Reminders are on." });
  else showToast({ text: why[r.reason ?? ""] ?? `Couldn't turn reminders on (${r.reason}).` }, 8000);
  after(reminderState());
}

// On Today, until reminders are on or the offer is dismissed.
export function ReminderOffer() {
  const [state, setState] = useState(reminderState);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === "1";
    } catch {
      return false;
    }
  });
  if (state !== "prompt" || dismissed) return null;
  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* it'll just be offered again */
    }
    setDismissed(true);
  };
  return (
    <section class="card reminder-offer">
      <p>🔔 <strong>Turn on reminders?</strong> {WHAT}</p>
      <button class="button" onClick={() => turnOn(setState)}>Turn on</button>{" "}
      <button class="link" onClick={dismiss}>Not now</button>
    </section>
  );
}

// On Memory: the state, a way to turn them on, and a test.
export function ReminderSettings() {
  const [state, setState] = useState(reminderState);
  const [devices, setDevices] = useState<number | null>(null);
  useEffect(() => {
    fetch("/api/push/status")
      .then((r) => r.json() as Promise<{ devices: number }>)
      .then((d) => setDevices(d.devices))
      .catch(() => {});
  }, [state]);
  return (
    <>
      <h2 class="section-title">Reminders</h2>
      <div class="card reminders">
        <p class="muted small">{WHAT}</p>
        {state === "granted" ? (
          <p>
            On{devices !== null && ` · ${devices} device${devices === 1 ? "" : "s"}`}.{" "}
            <button class="link" onClick={async () => showToast({ text: await sendTestReminder() }, 8000)}>Send a test</button>
          </p>
        ) : state === "prompt" ? (
          <button class="button" onClick={() => turnOn(setState)}>Turn on reminders</button>
        ) : (
          <p class="muted">{why[state]}</p>
        )}
      </div>
    </>
  );
}
