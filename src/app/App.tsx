import { useEffect, useState } from "preact/hooks";

type Health = { user: string; d1: string; r2: string } | { error: string };

export function App() {
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json() as Promise<Health>)
      .then(setHealth)
      .catch(() => setHealth({ error: "offline" }));
  }, []);

  return (
    <main>
      <h1>Bitebook</h1>
      <p class="muted">Meal log. Capture is coming in step 2.</p>
      <section class="card">
        <h2>Status</h2>
        {!health && <p>Checking…</p>}
        {health && "error" in health && <p class="bad">API: {health.error}</p>}
        {health && "user" in health && (
          <ul>
            <li>Signed in as {health.user}</li>
            <li class={health.d1 === "ok" ? "good" : "bad"}>Database: {health.d1}</li>
            <li class={health.r2 === "ok" ? "good" : "bad"}>Photo storage: {health.r2}</li>
          </ul>
        )}
      </section>
    </main>
  );
}
