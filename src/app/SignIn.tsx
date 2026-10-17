import { useEffect, useRef, useState } from "preact/hooks";

export function GoogleSignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const button = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("Loading Google sign-in…");
  const [error, setError] = useState<string | null>(null);

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
          setError(null);
          const res = await fetch("/auth/google", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ credential }),
          });
          if (res.ok) onSignedIn();
          else setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? String(res.status));
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
    <section class="card">
      <h2>Sign in</h2>
      {status && <p>{status}</p>}
      <div ref={button} />
      {error && <p class="bad">Sign-in failed: {error}</p>}
    </section>
  );
}
