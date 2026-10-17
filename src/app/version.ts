// Build stamp + stale-build detection, adapted from the pwa-cloudflare skill's
// version-check.js: the app boots from the service worker cache, so compare the
// build that's running with the one the server has. The ?_v= query is what makes
// the service worker pass this probe straight to the network.
export const VERSION = __APP_VERSION__;

export function versionLabel(live?: string) {
  const running = VERSION === "dev" ? "dev build" : "v" + VERSION;
  return live && live !== VERSION ? `${running} — v${live} available, reopen to update` : running;
}

export async function liveVersion(): Promise<string | undefined> {
  if (VERSION === "dev" || !navigator.onLine) return;
  try {
    const res = await fetch("/version.json?_v=" + Date.now(), { cache: "no-store" });
    return ((await res.json()) as { version?: string }).version;
  } catch {
    return; // offline or blocked: the version already shown is still accurate
  }
}
