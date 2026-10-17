import { useEffect, useState } from "preact/hooks";

type Health =
  | { user: string; authMode: string; d1: string; r2: string }
  | { error: string; login?: string | null };

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const authError = new URLSearchParams(location.search).get("auth_error");

  useEffect(() => {
    if (authError) history.replaceState(null, "", "/");
    fetch("/api/health")
      .then((r) => r.json() as Promise<Health>)
      .then(setHealth)
      .catch(() => setHealth({ error: "offline" }));
  }, []);

  const signOut = async () => {
    await fetch("/auth/logout", { method: "POST" });
    location.reload();
  };

  return (
    <main>
      <h1>Bitebook</h1>
      <p class="muted">Meal log. Capture is coming in step 2.</p>
      {authError && <p class="bad">Sign-in failed: {authError}</p>}
      <section class="card">
        <h2>Status</h2>
        {!health && <p>Checking…</p>}
        {health && "error" in health &&
          (health.login ? (
            <a class="button" href={health.login}>Sign in with Google</a>
          ) : (
            <p class="bad">API: {health.error}</p>
          ))}
        {health && "user" in health && (
          <>
            <ul>
              <li>Signed in as {health.user} ({health.authMode === "google" ? "Google" : "Cloudflare Access"})</li>
              <li class={health.d1 === "ok" ? "good" : "bad"}>Database: {health.d1}</li>
              <li class={health.r2 === "ok" ? "good" : "bad"}>Photo storage: {health.r2}</li>
            </ul>
            {health.authMode === "google" && (
              <button class="button secondary" onClick={signOut}>Sign out</button>
            )}
          </>
        )}
      </section>
    </main>
  );
}
