import { describe, expect, it } from "vitest";
import { dueReminders, localClock, morningMessage, nextReminderAt, nightlyMessage, type ReminderUser } from "../../src/shared/reminders";

const at = (iso: string) => Date.parse(iso);
const user = (extra: Partial<ReminderUser> = {}): ReminderUser => ({
  userId: "u1",
  tz: "America/Chicago",
  lastMealMs: at("2026-10-22T19:30:00-05:00"),
  lastMorningMs: null,
  sentToday: { nightly: false, morning: false },
  ...extra,
});
const kinds = (u: ReminderUser, iso: string) => dueReminders([u], at(iso)).map((r) => `${r.kind} ${r.localDate}`);

describe("localClock", () => {
  it("gives the date and minutes in the user's zone", () => {
    expect(localClock("America/Chicago", at("2026-10-23T03:30:00Z"))).toEqual({ date: "2026-10-22", minutes: 22 * 60 + 30 });
    expect(localClock("Asia/Kolkata", at("2026-10-22T17:00:00Z"))).toEqual({ date: "2026-10-22", minutes: 22 * 60 + 30 });
  });
});

describe("the nightly reminder", () => {
  it("goes at 10:30 pm local, however many meals were logged, once a night", () => {
    expect(kinds(user(), "2026-10-22T22:15:00-05:00")).toEqual([]);
    expect(kinds(user(), "2026-10-22T22:30:00-05:00")).toEqual(["nightly 2026-10-22"]);
    expect(kinds(user({ lastMealMs: null }), "2026-10-22T22:30:00-05:00")).toEqual(["nightly 2026-10-22"]);
    expect(kinds(user(), "2026-10-22T23:45:00-05:00")).toEqual(["nightly 2026-10-22"]); // a late cron run still sends
    expect(kinds(user({ sentToday: { nightly: true, morning: false } }), "2026-10-22T22:45:00-05:00")).toEqual([]);
    expect(kinds(user({ tz: "Asia/Kolkata" }), "2026-10-22T22:30:00+05:30")).toEqual(["nightly 2026-10-22"]);
  });
  it("says how many meals were logged, and opens the timeline", () => {
    expect(nightlyMessage(0)).toMatchObject({ body: "Nothing logged today. Tap to add what you ate.", navigate: "/#/" });
    expect(nightlyMessage(1).body).toBe("1 meal logged today. Missed anything? Tap to add it.");
    expect(nightlyMessage(3).body).toBe("3 meals logged today. Missed anything? Tap to add it.");
  });
});

describe("the morning reminder", () => {
  it("goes at 8 am after more than 24 hours without a meal, once per gap", () => {
    const quiet = user({ lastMealMs: at("2026-10-21T19:30:00-05:00") });
    expect(kinds(quiet, "2026-10-23T07:45:00-05:00")).toEqual([]);
    expect(kinds(quiet, "2026-10-23T08:00:00-05:00")).toEqual(["morning 2026-10-23"]);
    expect(kinds(user(), "2026-10-23T08:00:00-05:00")).toEqual([]); // last meal 12.5 hours ago
    // Already reminded since the last meal: not again the next morning.
    expect(kinds({ ...quiet, lastMorningMs: at("2026-10-23T08:00:00-05:00") }, "2026-10-24T08:00:00-05:00")).toEqual([]);
    expect(kinds(user({ lastMealMs: null }), "2026-10-23T08:00:00-05:00")).toEqual([]); // nothing ever logged
  });
  it("names the day of the last meal", () => {
    expect(morningMessage(at("2026-10-21T19:30:00-05:00"), "America/Chicago").body).toBe(
      "Nothing logged since Wednesday. Snap your next meal, or add the ones you missed.",
    );
  });
});

describe("nextReminderAt (the alarm's next wake-up, D31)", () => {
  const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
  it("is tonight's 10:30 pm, or tomorrow's once tonight's has gone", () => {
    expect(iso(nextReminderAt(user(), at("2026-10-22T15:00:00-05:00")))).toBe("2026-10-23T03:30:00.000Z");
    expect(iso(nextReminderAt(user({ sentToday: { nightly: true, morning: false } }), at("2026-10-22T22:40:00-05:00")))).toBe(
      "2026-10-24T03:30:00.000Z",
    );
  });
  it("is 8 am when the last meal will be more than a day old by then, and not otherwise", () => {
    const quiet = user({ lastMealMs: at("2026-10-21T19:30:00-05:00") });
    expect(iso(nextReminderAt(quiet, at("2026-10-23T02:00:00-05:00")))).toBe("2026-10-23T13:00:00.000Z");
    // Last meal at 19:30 yesterday: by 8 am it's only 12.5 hours, so tonight comes first.
    expect(iso(nextReminderAt(user(), at("2026-10-23T02:00:00-05:00")))).toBe("2026-10-24T03:30:00.000Z");
  });
  it("finds local times across a DST change and in half-hour zones", () => {
    // US clocks fall back on 2026-11-01: 10:30 pm CST that night is 04:30 UTC.
    expect(iso(nextReminderAt(user(), at("2026-11-01T12:00:00-06:00")))).toBe("2026-11-02T04:30:00.000Z");
    expect(iso(nextReminderAt(user({ tz: "Asia/Kolkata" }), at("2026-10-22T12:00:00+05:30")))).toBe("2026-10-22T17:00:00.000Z");
  });
  it("never returns a time that dueReminders wouldn't send at", () => {
    for (let h = 0; h < 48; h++) {
      const now = at("2026-10-22T00:00:00-05:00") + h * 1_800_000;
      for (const u of [user(), user({ lastMealMs: at("2026-10-20T12:00:00-05:00") }), user({ lastMealMs: null })]) {
        const t = nextReminderAt(u, now);
        expect(t).not.toBeNull();
        expect(t! > now).toBe(true);
        expect(dueReminders([u], t!).length).toBeGreaterThan(0);
      }
    }
  });
});
