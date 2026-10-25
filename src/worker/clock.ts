import { DurableObject } from "cloudflare:workers";
import { nextJob, runDueJobs } from "./analyze";
import { nextReminder, runReminders } from "./push";

// Each user's clock (D31): one Durable Object per user, holding one alarm set for the
// next thing that user needs, whichever comes first: an analysis run that's due, or a
// reminder (10:30 pm, or 8 am after a quiet day). Nothing polls. The pattern is the
// one Cadence uses for its check-ins (github.com/mishra69/cadence, worker/do/).
//
// The alarm holds no plan of its own. Each time it fires it does what's due, then works
// out the next wake-up from D1 again, so it can't drift from the data: a meal saved, a
// question answered or a subscription renewed just wakes it to re-plan.
//
// Woken by: enqueue() for every analysis run, every subscription (re-sent on each app
// open, which also follows a change of time zone), and the daily purge cron as a safety
// net for an alarm lost to a bad deploy.

type ClockEnv = Env & { APP_ORIGIN: string };

export class UserClock extends DurableObject<ClockEnv> {
  // Re-plans now. Called through RPC from the Worker.
  async wake(userId: string) {
    await this.ctx.storage.put("userId", userId);
    await this.plan(userId);
  }

  async alarm() {
    const userId = await this.ctx.storage.get<string>("userId");
    if (!userId) return;
    const now = Date.now();
    try {
      // Runs first: a question it raises is a notification too, and reminders don't wait
      // on the model (a run takes 15–20 seconds).
      await runReminders(this.env, userId, now);
      await runDueJobs(this.env, this.env.APP_ORIGIN, userId, now);
    } finally {
      // Whatever happened above, the chain continues.
      await this.plan(userId);
    }
  }

  private async plan(userId: string) {
    const now = Date.now();
    const [job, reminder] = await Promise.all([nextJob(this.env, userId), nextReminder(this.env, userId, now)]);
    const next = [job, reminder].filter((t): t is number => t !== null).sort((a, b) => a - b)[0];
    if (next === undefined) await this.ctx.storage.deleteAlarm();
    // A time in the past fires straight away: a run that was due while nothing was awake.
    else await this.ctx.storage.setAlarm(Math.max(next, now));
  }
}

export const clockFor = (env: Env, userId: string) => env.CLOCK.get(env.CLOCK.idFromName(userId));

// Never fails the request that triggered it: the daily safety net re-plans anyway.
export async function wake(env: Env, userId: string) {
  try {
    await clockFor(env, userId).wake(userId);
  } catch (e) {
    console.error(`clock wake ${userId}:`, e);
  }
}

// From the daily cron: re-plan every user who has something a clock should be waiting for.
export async function wakeAll(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT user_id FROM push_subscriptions
     UNION SELECT user_id FROM analysis_jobs WHERE status IN ('queued','running')`,
  ).all<{ user_id: string }>();
  for (const r of results) await wake(env, r.user_id);
}
