import { isUlid } from "../shared/ulid";

// Signed, short-lived links to a photo's display copy, for the model provider (D27). Its
// own module so it can be tested without the Workers runtime.
type LinkEnv = { SESSION_SECRET?: string; AUTH_DISABLED?: string };
const IMAGE_LINK_MS = 30 * 60_000;

// The photos are private, so each run hands out short-lived signed links instead of
// uploading the images inline (which would cost CPU time and request size).

async function imageKey(env: LinkEnv) {
  const secret = env.SESSION_SECRET ?? (env.AUTH_DISABLED === "1" ? "local-dev-only" : null);
  if (!secret) throw new Error("SESSION_SECRET is not set");
  return crypto.subtle.importKey("raw", new TextEncoder().encode("bitebook-image-link:" + secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}
const b64url = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function imageLink(env: LinkEnv, origin: string, photoId: string, now = Date.now()) {
  const exp = now + IMAGE_LINK_MS;
  const sig = b64url(await crypto.subtle.sign("HMAC", await imageKey(env), new TextEncoder().encode(`${photoId}.${exp}`)));
  return `${origin}/img/${photoId}/${exp}/${sig}.jpg`;
}

export async function checkImageLink(env: LinkEnv, photo: string, expParam: string, sigParam: string, now = Date.now()) {
  const exp = Number(expParam);
  const sig = sigParam.replace(/\.jpg$/, "");
  if (!isUlid(photo) || !Number.isFinite(exp) || exp < now || !/^[\w-]+$/.test(sig)) return false;
  const raw = Uint8Array.from(atob(sig.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (sig.length % 4)) % 4)), (ch) => ch.charCodeAt(0));
  return crypto.subtle.verify("HMAC", await imageKey(env), raw, new TextEncoder().encode(`${photo}.${exp}`)).catch(() => false);
}

