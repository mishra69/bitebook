import { pushSupport, subscribe } from "webpush-edge/client";
import { deviceTz } from "./time";

// Reminders by Web Push (D25). On iPhone they work only in the home-screen app, and the
// permission prompt must come from a tap. The subscription carries the device's zone,
// which decides when 10:30 pm is.
const OPTIONS = { keyUrl: "/api/push/key", subscribeUrl: "/api/push/subscribe" };
const headers = () => ({ "X-Timezone": deviceTz() });

export const reminderState = () => pushSupport().state;

// From a tap: asks for permission if needed, then registers this device.
export const turnOnReminders = () => subscribe({ ...OPTIONS, headers: headers() });

// On every app open once permission is granted, never prompting: the server may have lost
// the subscription, and the zone may have changed since (travel).
export function refreshReminders() {
  if (reminderState() !== "granted") return;
  subscribe({ ...OPTIONS, headers: headers(), prompt: false }).catch(() => {});
}

export async function sendTestReminder(): Promise<string> {
  const res = await fetch("/api/push/test", { method: "POST" });
  if (!res.ok) return `The server couldn't send it (${res.status}).`;
  const r = (await res.json()) as { sent: number; failed: number; statuses: number[] };
  if (r.sent + r.failed === 0) return "No devices are registered for reminders.";
  return r.failed ? `Sent to ${r.sent}, failed for ${r.failed} (push service said ${r.statuses.join(", ")}).` : "Sent. It should arrive in a few seconds.";
}
