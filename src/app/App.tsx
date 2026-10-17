import { useEffect, useRef, useState } from "preact/hooks";
import { liveVersion, versionLabel } from "./version";

type Health = { user: string; d1: string; r2: string } | { error: string };

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [live, setLive] = useState<string>();

  const loadHealth = () =>
    fetch("/api/health")
      .then((r) => r.json() as Promise<Health>)
      .then(setHealth)
      .catch(() => setHealth({ error: "offline" }));

  useEffect(() => {
    loadHealth();
    const check = () => liveVersion().then(setLive);
    check();
    // A new service worker taking over means a new build just landed.
    navigator.serviceWorker?.addEventListener("controllerchange", check);
  }, []);

  const signedIn = health !== null && "user" in health;

  // The install prompt must not cover the sign-in button, so only offer it once signed in.
  useEffect(() => {
    if (signedIn && typeof PWAInstall !== "undefined") PWAInstall.show(false);
  }, [signedIn]);

  const signOut = async () => {
    await fetch("/auth/logout", { method: "POST" });
    if (typeof google !== "undefined") google.accounts.id.disableAutoSelect();
    loadHealth();
  };

  return (
    <main class="screen">
      <h1>Bitebook</h1>
      <p class="muted">Meal log. Capture is coming in step 2.</p>
      <section class="card">
        <h2>Status</h2>
        {!health && <p>Checking…</p>}
        {health && "error" in health && health.error === "unauthenticated" && (
          <GoogleSignIn onSignedIn={loadHealth} onError={setSignInError} />
        )}
        {signInError && <p class="bad">Sign-in failed: {signInError}</p>}
        {health && "error" in health && health.error !== "unauthenticated" && <p class="bad">API: {health.error}</p>}
        {health && "user" in health && (
          <>
            <ul>
              <li>Signed in as {health.user}</li>
              <li class={health.d1 === "ok" ? "good" : "bad"}>Database: {health.d1}</li>
              <li class={health.r2 === "ok" ? "good" : "bad"}>Photo storage: {health.r2}</li>
            </ul>
            <button class="button secondary" onClick={signOut}>Sign out</button>
          </>
        )}
      </section>
      <p class="version-tag" data-version>{versionLabel(live)}</p>
    </main>
  );
}

function GoogleSignIn({ onSignedIn, onError }: { onSignedIn: () => void; onError: (e: string | null) => void }) {
  const button = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("Loading Google sign-in…");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { googleClientId } = (await fetch("/auth/config").then((r) => r.json())) as { googleClientId: string };
      // The GIS script loads async from accounts.google.com; wait for it.
      for (let i = 0; typeof google === "undefined" && i < 100; i++) await new Promise((r) => setTimeout(r, 100));
      if (cancelled) return;
      if (typeof google === "undefined") return setStatus("Couldn't load Google sign-in. Are you online?");
      google.accounts.id.initialize({
        client_id: googleClientId,
        callback: async ({ credential }) => {
          onError(null);
          const res = await fetch("/auth/google", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ credential }),
          });
          if (res.ok) onSignedIn();
          else onError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? String(res.status));
        },
      });
      google.accounts.id.renderButton(button.current!, { theme: "outline", size: "large", text: "signin_with" });
      setStatus("");
    })().catch(() => setStatus("Couldn't load Google sign-in. Are you online?"));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      {status && <p>{status}</p>}
      <div ref={button} />
    </>
  );
}
