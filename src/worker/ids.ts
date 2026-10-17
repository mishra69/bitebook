// ULID: 48-bit millisecond timestamp + 80 random bits, Crockford base32. Sorts by time.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(now = Date.now()): string {
  let time = "";
  for (let i = 0, t = now; i < 10; i++, t = Math.floor(t / 32)) time = ALPHABET[t % 32] + time;
  let rand = "";
  for (const b of crypto.getRandomValues(new Uint8Array(16))) rand += ALPHABET[b % 32];
  return time + rand;
}
