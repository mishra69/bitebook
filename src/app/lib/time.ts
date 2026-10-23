// ISO 8601 in the device's local time with its UTC offset, e.g. 2026-10-17T19:32:05-05:00.
export function localIso(d: Date): string {
  const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${off >= 0 ? "+" : "-"}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`
  );
}

// EXIF local time without an offset is taken to be in the device's current zone.
export function withLocalOffset(local: string): string {
  const [date, time] = local.split("T");
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm, ss] = time.split(":").map(Number);
  return localIso(new Date(y, m - 1, d, hh, mm, ss));
}

export const deviceTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export const timeOfDay = (iso: string) => iso.slice(11, 16);

export function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// A meal added afterwards without a photo has no real time, only a day and a meal type
// (D24). It gets that meal's usual hour, so it sorts and digests in the right place.
const USUAL_HOUR: Record<string, [number, number]> = { breakfast: [8, 30], lunch: [13, 0], snack: [16, 30], dinner: [19, 30] };
export function missedMealTime(daysAgo: number, mealType: string | null, now = new Date()): string {
  const d = new Date(now);
  d.setDate(d.getDate() - daysAgo);
  const [h, m] = mealType ? USUAL_HOUR[mealType] : [d.getHours(), d.getMinutes()];
  d.setHours(h, m, 0, 0);
  return localIso(d);
}
