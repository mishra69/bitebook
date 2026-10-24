import { AutoAnalysis } from "./AutoAnalysis";
import { ReminderSettings } from "./Reminders";

// Everything about how the app behaves for you, as opposed to what it knows about you
// (Memory). Reached from the gear in the header.
export function Settings({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  return (
    <section class="settings" aria-label="Settings">
      <AutoAnalysis />
      <ReminderSettings />
      <h2 class="section-title">Account</h2>
      <div class="card">
        <p>
          Signed in as <strong>{email}</strong>
        </p>
        <button class="button secondary" onClick={onSignOut}>Sign out</button>
      </div>
    </section>
  );
}
