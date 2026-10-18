import { useEffect, useState } from "preact/hooks";
import { Capture } from "./Capture";
import { MealDetail } from "./MealDetail";
import { MealList } from "./MealList";
import { GoogleSignIn } from "./SignIn";
import { Timeline } from "./Timeline";
import { ToastHost } from "./Toast";
import { startSync } from "./lib/outbox";
import { useRoute } from "./lib/router";
import { liveVersion, versionLabel } from "./version";

type Health = { user: string; userId: string; d1: string; r2: string } | { error: string };

// The signed-in user is remembered on the device so the app (and its outbox) still
// works when it's opened offline.
const USER_KEY = "bitebook.user";
type User = { id: string; email: string };
const rememberedUser = (): User | null => {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) ?? "null");
  } catch {
    return null;
  }
};

export function App() {
  const [user, setUser] = useState<User | null>(rememberedUser);
  const [authState, setAuthState] = useState<"checking" | "ok" | "signed_out" | "offline" | "error">("checking");
  const [live, setLive] = useState<string>();
  const route = useRoute();

  const checkSession = async () => {
    let h: Health;
    try {
      h = (await fetch("/api/health").then((r) => r.json())) as Health;
    } catch {
      h = { error: "offline" };
    }
    if ("userId" in h) {
      const u = { id: h.userId, email: h.user };
      try {
        localStorage.setItem(USER_KEY, JSON.stringify(u));
      } catch {
        /* storage blocked: we just won't work offline */
      }
      setUser(u);
      setAuthState("ok");
    } else if (h.error === "unauthenticated") {
      setUser(null);
      setAuthState("signed_out");
    } else {
      setAuthState(h.error === "offline" ? "offline" : "error");
    }
  };

  useEffect(() => {
    checkSession();
    const check = () => liveVersion().then(setLive);
    check();
    // A new service worker taking over means a new build just landed.
    navigator.serviceWorker?.addEventListener("controllerchange", check);
  }, []);

  useEffect(() => {
    if (user) startSync(user.id);
  }, [user?.id]);

  // The install prompt must not cover the sign-in button, so only offer it once signed in.
  useEffect(() => {
    if (authState === "ok" && typeof PWAInstall !== "undefined") PWAInstall.show(false);
  }, [authState]);

  const signOut = async () => {
    await fetch("/auth/logout", { method: "POST" }).catch(() => {});
    if (typeof google !== "undefined") google.accounts.id.disableAutoSelect();
    try {
      localStorage.removeItem(USER_KEY);
    } catch {
      /* ignore */
    }
    setUser(null);
    setAuthState("signed_out");
  };

  return (
    <main class="screen">
      <header class="app-header">
        <h1>Bitebook</h1>
        {user && (
          <button class="link" onClick={signOut} title={user.email}>
            Sign out
          </button>
        )}
      </header>
      {authState === "checking" && !user && <p class="muted">Loading…</p>}
      {authState === "error" && <p class="bad">The server isn't responding properly. Try again in a bit.</p>}
      {!user && authState === "signed_out" && <GoogleSignIn onSignedIn={checkSession} />}
      {!user && authState === "offline" && <p class="muted">You're offline. Sign in once you're back online.</p>}
      {user && (
        <>
          <nav class="tabs" aria-label="Sections">
            <a href="#/" aria-current={route.name === "today" ? "page" : undefined}>Today</a>
            <a href="#/timeline" aria-current={route.name !== "today" ? "page" : undefined}>Timeline</a>
          </nav>
          {route.name === "today" && (
            <>
              <Capture userId={user.id} />
              <MealList userId={user.id} />
            </>
          )}
          {route.name === "timeline" && <Timeline userId={user.id} />}
          {route.name === "meal" && <MealDetail id={route.id} />}
        </>
      )}
      <p class="version-tag" data-version>{versionLabel(live)}</p>
      <ToastHost />
    </main>
  );
}
