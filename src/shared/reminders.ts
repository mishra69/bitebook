// When reminders go out and what they say (D25). Pure, so it can be tested at any hour.
// Each user's Durable Object alarm (src/worker/clock.ts) wakes at nextReminderAt() and
// sends whatever dueReminders() says then (D31).

export const NIGHTLY_AT = 22 * 60 + 30; // 10:30 pm local, after a late dinner
export const MORNING_AT = 8 * 60; // 8:00 am local
const WINDOW = 2 * 60; // a run missed by the cron can still send within this window
export const MORNING_GAP_MS = 24 * 3_600_000;

export type ReminderUser = {
  userId: string;
  tz: string;
  lastMealMs: number | null; // when the newest meal was eaten
  lastMorningMs: number | null; // when the last morning reminder went out
  sentToday: { nightly: boolean; morning: boolean }; // already sent on today's local date
};

export type Reminder = { userId: string; kind: "nightly" | "morning"; localDate: string };

// The user's local date (YYYY-MM-DD) and minutes since local midnight.
export function localClock(tz: string, now: number): { date: string; minutes: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(now))
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

const inWindow = (minutes: number, at: number) => minutes >= at && minutes < at + WINDOW;

// The instant a local wall-clock time happens in a zone (DST-safe: the offset is measured
// at the guess and the guess corrected, twice, which settles across any transition).
export function zonedInstant(tz: string, date: string, minutes: number): number {
  const [y, m, d] = date.split("-").map(Number);
  const wanted = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  let t = wanted;
  for (let i = 0; i < 2; i++) {
    const c = localClock(tz, t);
    const [cy, cm, cd] = c.date.split("-").map(Number);
    t += wanted - Date.UTC(cy, cm - 1, cd, Math.floor(c.minutes / 60), c.minutes % 60);
  }
  return t;
}

const addDays = (date: string, n: number) => new Date(Date.parse(date + "T12:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);

// The next moment after `now` at which dueReminders() would have something to send, if
// nothing changes meanwhile (a meal logged later only makes the morning one unneeded,
// and that's checked when the alarm fires). Null when nothing can come due.
export function nextReminderAt(u: ReminderUser, now: number): number | null {
  const today = localClock(u.tz, now).date;
  let best: number | null = null;
  for (let i = 0; i <= 2; i++) {
    const date = addDays(today, i);
    for (const at of [MORNING_AT, NIGHTLY_AT]) {
      const t = zonedInstant(u.tz, date, at);
      if (t <= now || (best !== null && t >= best)) continue;
      const user = i === 0 ? u : { ...u, sentToday: { nightly: false, morning: false } };
      if (dueReminders([user], t).length) best = t;
    }
  }
  // A morning reminder can be days out (24 hours after the last meal): no need to look
  // further, since the nightly one always comes within a day and the alarm re-plans then.
  return best;
}

export function dueReminders(users: ReminderUser[], now: number): Reminder[] {
  const due: Reminder[] = [];
  for (const u of users) {
    const { date, minutes } = localClock(u.tz, now);
    // Every night, however many meals were logged: snacks are what usually get missed.
    if (inWindow(minutes, NIGHTLY_AT) && !u.sentToday.nightly) due.push({ userId: u.userId, kind: "nightly", localDate: date });
    // In the morning, after a day with nothing logged; once per gap, not every morning.
    const quiet = u.lastMealMs !== null && now - u.lastMealMs > MORNING_GAP_MS;
    const alreadyThisGap = u.lastMorningMs !== null && u.lastMealMs !== null && u.lastMorningMs > u.lastMealMs;
    if (inWindow(minutes, MORNING_AT) && quiet && !alreadyThisGap && !u.sentToday.morning) {
      due.push({ userId: u.userId, kind: "morning", localDate: date });
    }
  }
  return due;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function nightlyMessage(mealsToday: number) {
  return {
    title: "Bitebook",
    body:
      mealsToday === 0
        ? "Nothing logged today. Tap to add what you ate."
        : `${mealsToday} meal${mealsToday === 1 ? "" : "s"} logged today. Missed anything? Tap to add it.`,
    navigate: "/#/timeline",
    tag: "nightly",
  };
}

export function morningMessage(lastMealMs: number, tz: string) {
  const weekday = WEEKDAYS[new Date(`${localClock(tz, lastMealMs).date}T12:00:00Z`).getUTCDay()];
  return {
    title: "Bitebook",
    body: `Nothing logged since ${weekday}. Snap your next meal, or add the ones you missed.`,
    navigate: "/#/",
    tag: "morning",
  };
}
