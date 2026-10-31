import type { MealType } from "../../shared/meals";

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

// A meal added afterwards without a photo (D24) gets the time the user sets, by stepping
// back from now an hour at a time (D39): never later than now, never before yesterday.
export function missedMealTime(takenAt: string, stepHours: number, now = new Date()): string {
  const earliest = new Date(now);
  earliest.setDate(earliest.getDate() - 1);
  earliest.setHours(0, 0, 0, 0);
  const t = Date.parse(takenAt) + stepHours * 3_600_000;
  const d = new Date(Math.min(Math.max(t, earliest.getTime()), now.getTime()));
  d.setSeconds(0, 0);
  return localIso(d);
}

// The same clock time on today or yesterday, no later than now.
export function missedMealOnDay(takenAt: string, daysAgo: number, now = new Date()): string {
  const d = new Date(Date.parse(takenAt));
  const day = new Date(now);
  day.setDate(day.getDate() - daysAgo);
  day.setHours(d.getHours(), d.getMinutes(), 0, 0);
  return localIso(new Date(Math.min(day.getTime(), now.getTime())));
}

// 0 for today, 1 for yesterday, on the phone's calendar.
export function daysAgoOf(takenAt: string, now = new Date()): number {
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  return Math.round((day(now) - day(new Date(Date.parse(takenAt)))) / 86_400_000);
}

// A meal type that fits the time of day: a suggestion the user can change or clear.
export function suggestMealType(iso: string): MealType {
  const h = Number(iso.slice(11, 13)) + Number(iso.slice(14, 16)) / 60;
  if (h >= 4 && h < 10.5) return "breakfast";
  if (h >= 11 && h < 15) return "lunch";
  if (h >= 17 && h < 22) return "dinner";
  return "snack";
}
