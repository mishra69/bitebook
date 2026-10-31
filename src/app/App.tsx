import { useEffect, useRef, useState } from "preact/hooks";
import { Analyze } from "./Analyze";
import { Capture } from "./Capture";
import { MealDetail } from "./MealDetail";
import { MealList } from "./MealList";
import { Memory } from "./Memory";
import { ReminderOffer } from "./Reminders";
import { Settings } from "./Settings";
import { TodayPanel } from "./TodayPanel";
import { Trends } from "./Trends";
import { GoogleSignIn } from "./SignIn";
import { EarlierDays } from "./EarlierDays";
import { ToastHost } from "./Toast";
import { startSync } from "./lib/outbox";
import { refreshReminders } from "./lib/reminders";
import { useRoute } from "./lib/router";
import { liveVersion, versionLabel } from "./version";

type Health = { user: string; userId: string; picture: string | null; d1: string; r2: string } | { error: string };

// The signed-in user is remembered on the device so the app (and its outbox) still
// works when it's opened offline.
const USER_KEY = "bitebook.user";
type User = { id: string; email: string; picture?: string | null };
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
      const u = { id: h.userId, email: h.user, picture: h.picture };
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

  useEffect(() => {
    if (authState === "ok") refreshReminders();
  }, [authState]);

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
      {(user || authState !== "signed_out") && (
        <header class="app-header">
          <h1>
            <a class="home" href="#/">Bitebook</a>
          </h1>
          {user && <AccountMenu email={user.email} picture={user.picture ?? null} active={MENU_ROUTES.includes(route.name)} />}
        </header>
      )}
      {authState === "checking" && !user && <p class="muted">Loading…</p>}
      {authState === "error" && <p class="bad">The server isn't responding properly. Try again in a bit.</p>}
      {!user && authState === "signed_out" && <GoogleSignIn onSignedIn={checkSession} />}
      {!user && authState === "offline" && <p class="muted">You're offline. Sign in once you're back online.</p>}
      {user && (
        <>
          {MENU_ROUTES.includes(route.name) && (
            <a class="link back" href="#/">
              ← Meals
            </a>
          )}
          {route.name === "meals" && (
            <>
              <Capture userId={user.id} missed={route.missed} />
              <TodayPanel />
              <ReminderOffer />
              <MealList userId={user.id} />
              <EarlierDays />
            </>
          )}
          {route.name === "trends" && <Trends />}
          {route.name === "analyze" && <Analyze />}
          {route.name === "memory" && <Memory />}
          {route.name === "settings" && <Settings email={user.email} onSignOut={signOut} />}
          {route.name === "meal" && <MealDetail id={route.id} />}
        </>
      )}
      <p class="version-tag" data-version>{versionLabel(live)}</p>
      <ToastHost />
    </main>
  );
}

// The screens behind the avatar (D37, D41): Meals is the app; these are visited now and then.
// Apple Health draws the long-term charts for most people; Trends stays for those without
// the Shortcut.
const MENU_ROUTES: string[] = ["trends", "memory", "settings"];

function AccountMenu({ email, picture, active }: { email: string; picture: string | null; active: boolean }) {
  const [open, setOpen] = useState(false);
  const [broken, setBroken] = useState(false); // offline, or the photo's URL went stale
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e.type === "hashchange" || !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    window.addEventListener("hashchange", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("hashchange", close);
    };
  }, [open]);
  return (
    <div class="account" ref={ref}>
      <button
        class={`avatar${active ? " on" : ""}`}
        aria-label="Account"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {picture && !broken ? (
          <img class="avatar-img" src={picture} alt="" referrerpolicy="no-referrer" onError={() => setBroken(true)} />
        ) : (
          email.charAt(0).toUpperCase()
        )}
      </button>
      {open && (
        <div class="account-menu" role="menu">
          <p class="muted small">{email}</p>
          <a role="menuitem" href="#/trends">Trends</a>
          <a role="menuitem" href="#/memory">Memory</a>
          <a role="menuitem" href="#/settings">Settings</a>
        </div>
      )}
    </div>
  );
}
