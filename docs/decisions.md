# Decisions

Append-only. Each entry is dated and never edited afterward. To change course, add a new
entry that names the one it supersedes.

---

## D1 · 2026-10-17 · Build a PWA instead of using the Camera app or an iOS Shortcut

The iPhone Camera can't save straight into a separate album, and a Shortcut still drops
photos into Recents. Meal photos must stay out of the camera roll and be kept as their own
corpus. A PWA using `<input type="file" accept="image/*" capture="environment">` captures
straight into the app.

## D2 · 2026-10-17 · The human is the API

Analysis happens by pasting an exported batch into a chatbot and pasting the JSON reply
back into the app. There are no LLM API calls and no per-token cost, and any chat model
can be used. In return, the app must validate replies strictly, because a human is
carrying data across by hand.

## D3 · 2026-10-17 · Store photos in Cloudflare R2, not Google Photos

Google Photos' API was considered because it's already paid for, but API uploads show up
in its main Photos view, not only in an album. The R2 free tier (10 GB-month, free egress)
covers about two years of originals. Combined with D4, it stays free.

## D4 · 2026-10-17 · Keep originals and roll them off locally

Keep the full-resolution original and a compressed display copy of every photo. Only
the originals grow meaningfully. A local script periodically downloads old originals,
verifies their checksums, and then deletes them from R2. Display copies, metadata and
analyses stay in Cloudflare permanently.

## D5 · 2026-10-17 · Store every analysis with its model and date

Analyses are never overwritten. Each one records the model that produced it, the prompt
version, and the date. User corrections are stored separately as ground truth. This
makes the data usable later as an evaluation corpus for comparing models.

## D6 · 2026-10-17 · Add an optional API path (amends D2)

The chat handoff stays the default, but a batch can also be run directly through an LLM
API from the Worker. This is a fallback for when the handoff is inconvenient, and it
makes it easy to run the same batch on several models for comparison. The constraint
is that the API path reuses the batch, prompt, reply schema and validator unchanged,
so there is only one contract to maintain. It's opt-in because it is the only part that
costs money.

## D7 · 2026-10-17 · Try two sign-in modes before picking one

Cloudflare Access was the plan, but Google is the identity used across all the user's
other apps. Instead of deciding on paper, the same code is deployed twice, sharing one
database and bucket: `bitebook` behind Cloudflare Access, and `bitebook-google` with
Google sign-in handled by the Worker. Only an allowlisted email can get in, and both
refuse every request until they are configured. Once one has been used on the iPhone
for a while, keep it and remove the other. That outcome will be recorded as a new entry.

## D8 · 2026-10-17 · Google sign-in only (supersedes D7)

The two-deployment trial was more machinery than it was worth. Google sign-in, run by the
Worker, is the only mode, on the single `bitebook` Worker. Cloudflare Access is built
for keeping employees in and the public out: it's priced per seat beyond 50 users, and
people get in by being added to a list. Google sign-in has no seat limit, is the identity
used across the user's other apps, and leaves "who may use this" to the app. The
`bitebook-google` Worker and the Access code were removed. Access remains a reasonable
choice later for operator-only tools.

## D9 · 2026-10-17 · All data is owned by a user from day one

There is one user today, but decisions are made as if there could be more. Every D1 row
carries `user_id`, and every R2 object lives under `users/<user_id>/`. Adding this
before the first photo is stored is almost free. Adding it afterward would mean
migrating every row and moving every object. The operator (whoever owns the Cloudflare
account) can see all data. Hiding it with end-to-end encryption was rejected, because it
would break server-side thumbnails and the API path, and a lost key would lose the corpus.

## D10 · 2026-10-17 · Follow the pwa-cloudflare skill (v1.0.0)

The PWA layer follows the user's `pwa-cloudflare` skill, which records what has actually
failed on real devices. That changed several things:
- the iOS status bar style is `default` (it is baked in at install time);
- icons are padded for apple-touch and maskable;
- `sw.js` precaches per file and is version-stamped by the build;
- `_headers` keeps the shell and `sw.js` uncached;
- the install prompt is shown only after sign-in;
- deploys wait until the new version is live.

Sign-in moved from the authorization-code flow to Google's ID-token flow, which needs no
client secret, so the secret was deleted. Users are keyed on Google's `sub` instead of
email (migration 0002, run while the table was still empty). Files copied unmodified
are listed in `.skill-assets` and checked for drift with the skill's `sync-assets.sh`.

One finding goes beyond the skill: Vite marks its bundles `crossorigin`, so a
`Vary: Origin` response header makes the cache lookup miss when offline. `sw.js`
therefore matches with `ignoreVary`.

## D11 · 2026-10-17 · Uploads only progress while the app is open (iOS)

Found on the first real meal: the upload sat for about 20 minutes. iOS freezes a
backgrounded web app within seconds and offers web apps no background upload. So an
upload only moves while Bitebook is on screen. A request frozen mid-flight may also never
settle, which blocked every later upload until a relaunch. In response:
- every request has a timeout;
- returning to the app abandons the in-flight request and restarts the queue (each step
  is idempotent, so redoing it is safe);
- display copies upload before originals;
- the app shows progress and asks the user to keep it open until uploads finish.

The same meal showed that iOS hands the app JPEG, not HEIC, and that Safari ignores
`canvas.toBlob`'s quality argument. Display copies are now encoded with `toDataURL`.

## D12 · 2026-10-18 · Meals can be deleted (refines principle 5)

The first real upload was a test photo, not a meal, and there was no way to remove it.
"History is append-only" was meant to stop silent rewrites of what a model said about a
meal, not to keep mistakes forever. So the principle now reads: within a meal, history
is append-only, but a whole meal can be deleted on purpose.

Deleting sets `deleted_at`, which hides the meal everywhere at once. Undo is offered
right away, and a "Recently deleted" list keeps the meal restorable for 30 days. A daily
cron trigger (`src/worker/purge.ts`) then removes its R2 files and its rows. Files go
first, so a failed run leaves rows behind and the next day's run retries. A meal still
in the phone's outbox is deleted locally, after a confirmation, since there is no server
copy to restore from. A 30-day window was chosen over immediate deletion because
accidental deletes become costly once meals carry analyses.

## D13 · 2026-10-18 · Continuity lives in the app, not in a chat thread

Each batch is analyzed in isolation, so something learned once (a tortilla's nutrition
label) is gone by the next batch. Reusing one long chat thread was rejected: long
threads get lossy, they tie the corpus to one model, and they leave no record of what
context an analysis saw.

Instead, every prompt starts with a context block that the app builds:
- the **pantry**: confirmed foods with label values and stable codes (`F1`, …);
- the user's **standing notes**;
- a **trend** the app computes itself from stored analyses.

Labels are captured like meals but marked as labels. The model reads them, and its
reading becomes a proposed pantry food that the user confirms. The model never changes
memory directly. This adds principle 9, a `kind` on meals, the `foods` and `notes`
tables, and context, label and `food_code` parts to the prompt and reply contract. That
contract isn't implemented yet, so it was edited in place and stays at version 1.

## D14 · 2026-10-18 · Display copies are JPEG-encoded in JS (follows D11)

The `toDataURL` fix in D11 didn't hold. The next real meal came from the new build, since
its display copy uploaded first, yet it still carried Safari's ~0.95 quantization tables.
iOS Safari ignores the quality argument of canvas JPEG encoding altogether. Display
copies are now encoded with `jpeg-js` from the canvas pixels: quality 0.8 on every
browser, about 250 KB per photo, loaded only when a photo is processed. The encoder is
CommonJS and returns `Buffer.from(...)`; a one-line stand-in replaces that instead of
patching the library.

## D15 · 2026-10-18 · Approximate tracking; memory maintains itself (supersedes parts of D13)

The label-and-pantry design from D13 drifted toward precise tracking: a Meal/Label
switch at capture, and proposed pantry foods waiting for confirmation. Both are the
kind of chore that makes people stop logging. New principle 10: approximate and
consistent beats precise and abandoned.

- **No label switch.** Any meal can include a photo of a package or label, and the
  model uses what it can read. `meals.kind` is dropped (migration 0005); no real meal
  used it.
- **Rough estimates.** Each meal gets a description, kcal and macros, and a confidence.
  Item breakdowns, gram weights and fiber are gone from the reply.
- **Remembered foods replace the pantry.** Replies add, update or retire them directly,
  with no confirmation step. The user can retire a wrong one but never has to manage the
  list. A wrong memory can persist until noticed; at this level of precision that's
  accepted, and each change records the batch that made it.
- **A 30-day digest gives continuity.** Every prompt carries one text line per analyzed
  meal from the last 30 days. That lets any model spot recurring dishes and stay
  consistent across batches, which is the continuity a long chat thread would have
  given, without its lossiness or its tie to one model.
- **No monthly review prompt.** With the digest in every batch it would only add a
  narrative, at the cost of a second prompt type and reply format. App-computed trends
  cover long horizons, and a "copy digest" button can serve one-off questions later.

## D16 · 2026-10-18 · Import, built against the first real reply

The first real reply, from the Claude app on 2026-10-18 for two meals, followed the
format exactly, and it's kept as a test fixture. It also asked to be told a recurring
recipe "once" so it could remember it. A model can't save that, but the user's notes can,
and every batch sees them. So `prompt/2` adds one line: suggest adding such things to
Bitebook notes. Batches created earlier keep `prompt/1`, which is stored with them.

Import is one D1 transaction (analyses, remembered-food changes, closing the batch) and
reports every validation error at once. The handoff stays as two taps (copy the prompt,
share the photos). The user found that fine, since it's not a back-and-forth.

## D17 · 2026-10-18 · The reply names its own model; the user confirms it

Typing the model name on every import is tedious, so `prompt/3` asks the model to put
its own name and version in the reply. A model's knowledge of itself is unreliable,
though: it may give an older name, only a family name, or a confident wrong version. So
the self-report only prefills the Model box. The user's confirmed name is what analyses
record, and the raw self-report is kept separately in `batches.reply_model_reported`.
That also lets the corpus measure how often models misreport themselves. The reply
schema stays `bitebook.reply/1`, since the field is optional and older replies lack it.

## D18 · 2026-10-18 · Models may ask, in the chat, before replying (prompt/4)

The first real reply carried an open question ("chicken or paneer?") with nowhere for an
answer to go. Re-analyzing a meal once a question is answered was rejected as needless
machinery. Instead the model asks in the chat before writing its JSON, the user answers
there, and the one reply already includes the answers.

To keep this in line with principle 10, there are three limits:
- **Only if necessary:** roughly 100 kcal or more at stake, or the answer matters for
  future meals. Otherwise the model assumes and says so in the comment.
- **At most two, asked together.** Skipping a question is fine, and the model then uses
  its best guess.
- **Never twice.** The reply lists what was asked and answered. The app stores that
  (`questions`), and every later prompt includes it as "Questions already asked". The
  user can delete one in Memory to let it be asked again.

The format's sample question is a neutral placeholder, so it can't be mistaken for a
real question that was already answered.

## D19 · 2026-10-21 · Meals stay open for helpings; each photo keeps its own time

The user's goal is to fill a plate once and skip seconds, and until then to document
every helping. So a meal stays open while it's eaten, gaining a photo per helping. Two
gaps showed up:

- **Every photo had the meal's time.** The prompt listed "photos: A-1, A-2, A-3", which a
  model could read as three angles of one plate and undercount. Each photo now stores its
  own time (`photos.taken_at`, migration 0009), from its EXIF or else the moment it was
  captured. `prompt/5` names each file by its time, shows the gap from the first photo
  ("+16 min"), and says to count photos minutes apart as separate helpings and photos
  about a minute apart as one plate.
- **iPhone camera photos carry no EXIF at all.** Checking all seven real originals in R2
  (every SHA-256 still matched) showed no date, no offset, not even the camera make: iOS
  strips metadata from photos taken through a web page. So the capture moment is the
  time used on iPhone, and no location ever reaches storage. The backfill therefore used
  each photo's ULID, which is minted when the photo is processed, a second or so after
  the shutter. It moved one photo, the second helping of the 2026-10-20 dinner, from
  19:39 to 19:48:25. One-second differences were left alone.
- **A forgotten Save.** The draft is stored on the phone from its first photo, and now
  stored *before* it's shown, so a visible photo is a stored photo. The only real losses
  are a lost or broken phone, or deleting the home-screen app; a dead battery or a
  reload loses nothing. A web app can't run in the background, so a draft idle for 90
  minutes after its last photo is saved the next time the app opens or comes back,
  with a note saying so. Times come from the photos, so saving late changes nothing.

A push reminder for a forgotten draft was considered and rejected for now: it needs the
draft on the server, notification keys and a frequent job, and it asks the user to act,
while auto-save asks nothing.

## D20 · 2026-10-21 · Plan changes: logging reminders in, corrections parked

- **Added: logging reminders.** If nothing is logged for a day or two, a push
  notification nudges the user. This guards against forgetting the app altogether, which
  auto-save can't. It follows the `pwa-cloudflare` skill's Web Push notes and uses
  `webpush-edge`.
- **Added: uploading draft photos as they're taken.** Kept as a later step: the risk it
  covers is small (D19), and it needs a cleanup job for discarded drafts.
- **Parked: corrections** (editing an analysis by hand). Questions asked in the chat (D18)
  cover most of what they were for.

## D21 · 2026-10-21 · Voice notes, transcribed on the server

iOS dictation is poor with the way the user describes meals, especially mixed English
and Hindi food names. So a meal can carry one spoken note, recorded in the app and at
most 60 seconds long, typically describing each helping just before saving.

- **Text reaches the model, not audio.** Not every chat app accepts audio attachments,
  and text fits the prompt, the digest and model comparisons. The Worker transcribes
  with Whisper large-v3-turbo on Workers AI (`src/worker/transcribe.ts`) right after the
  meal is saved, and again when a batch is created if that failed. Remembered food
  names are passed as Whisper's initial prompt to help with spelling. The cost is 46.63
  neurons per audio minute against a free allowance of 10,000 a day (about 214
  minutes), so a few notes a day use a few percent of it.
- **The transcript isn't editable.** Editing it would be the kind of chore principle 10
  rules out. If transcription is often poor, the answer is another model, or dropping
  the feature.
- **Both are stored.** The transcript, with the model that made it, is what prompts use.
  The audio is kept only so transcription models can be compared later. A new
  transcript never rewrites past nutrition data.
- **Like photos:** the note lives in the draft on the phone, uploads before the meal
  commit with a SHA-256 check, and is purged with its meal.

Open risks, for the iPhone: home-screen web apps may ask for the microphone on every
launch, and leaving the app ends a recording early (what was said is kept).

## D22 · 2026-10-23 · Fiber

The user wants a fiber count. Every estimate now includes `fiber_g` (grams), per meal and
per remembered food (`prompt/7`, migration 0011). It's an optional field in
`bitebook.reply/1`, not a new reply version: a reply without it still imports, and its
fiber counts as unknown. That keeps older replies, and models that ignore the field,
valid.

- Older analyses aren't backfilled, since there's no re-analysis (D18). The digest shows
  fiber only where an estimate has it.
- The 7-day trend averages fiber only over days whose meals all have it, so a day that
  was half before `prompt/7` can't drag the average down.

## D23 · 2026-10-23 · Upload diagnostics, logged on the phone

Uploads on 2026-10-22 took 19 to 50 minutes with the app open, though each file the server
received took about a second. The server can't see attempts that never reach it, so it
couldn't say whether the network was slow, requests timed out, or the app was paused.

- **The phone keeps a log** (`src/app/lib/diag.ts`): every upload attempt with its size,
  duration and outcome (status, `timeout`, `abandoned` on return to the app, or the
  network error), retries scheduled, the app going to the background and back, and the
  network going offline and online. It lives in its own IndexedDB database, capped at
  2,000 events.
- **It's sent to the server on its own,** after each successful upload pass and at app
  start, into `diag_events` (migration 0012). Kept 30 days, cleared by the nightly
  purge. The phone deletes only what the server has confirmed.
- **The app never shows it.** It's for reading with SQL when something goes wrong, so
  the user doesn't have to describe what happened.

## D24 · 2026-10-23 · Meals added afterwards, without a photo

Changes Core (§1, §3). Until now every meal was a photo. The user asked for a nightly
check, "did you log everything?", with a way to say what was missed. A forgotten meal
can't be photographed afterwards, so it's described instead.

- **From Timeline, "Add a meal I missed"** opens a draft without a photo. The user picks
  the day (today or yesterday) and the meal type, then records a voice note (or types a
  note). A photo can still be added if there is one.
- **Its time is the meal type's usual hour** (breakfast 8:30, lunch 13:00, snack 16:30,
  dinner 19:30), so it sorts and digests in the right place. No time picker: an exact
  time wouldn't change the estimate, and picking one is the kind of chore principle 10
  rules out. The app shows it as "about 13:00", the prompt as "~13:00".
- **The server accepts no photos only with a voice note or a note.** A meal with nothing
  to estimate from is refused.
- **`prompt/8`** marks such a meal as "no photo (added afterwards from my description)"
  and tells the model to estimate from the words alone, assume typical portions, and
  lower its confidence to match.

## D25 · 2026-10-23 · Reminders: nightly at 10:30 pm, and a morning nudge

Supersedes the reminder plan of 2026-10-21 (spec §11 step 6), which had only the
morning reminder. The user asked for both:

- **Nightly, at 10:30 pm local, every night**, however many meals were logged ("3 meals
  logged today. Missed anything?", or "Nothing logged today"). 10:30, not 9:30, because
  dinner can be late. Tapping it opens Timeline, where "Add a meal I missed" is (D24).
- **Morning, at 8:00 local, after more than 24 hours with no meal.** Once per gap: if
  nothing is logged the next day either, the nightly one covers it, so the morning one
  doesn't repeat. That answers the open question in §12.

How:
- **Web Push through `webpush-edge`** (the pwa-cloudflare skill's choice), pinned to a
  commit since it isn't on npm. The VAPID public key is in `wrangler.jsonc`; the private
  key is the secret `VAPID_PRIVATE_JWK`. Rotating them makes every device subscribe
  again.
- **"Local" is the device's zone,** sent with the subscription on every app open, so it
  follows travel. Subscriptions are in `push_subscriptions` (migration 0013).
- **A cron every 15 minutes** checks who is due, so 10:30 lands on time in any zone. A
  run can send up to two hours late if earlier runs were missed. `reminders_sent` makes
  each reminder go out at most once per local day; a row is claimed before sending, so
  overlapping runs can't double-send.
- **Turning them on:** a card on Today until they're on or dismissed, and a Reminders
  section on Memory with "Send a test", which reports the push service's status codes.
  On iPhone it works only from the home-screen app, and the permission prompt only
  appears after a tap.

## D26 · 2026-10-23 · A readable copy of the reply, before the JSON

The user checks each reply in the chat and asks for corrections there, and the JSON block
is hard to read on a phone: the Claude app doesn't wrap code blocks, so long values need
sideways scrolling. Hard-wrapping inside the JSON was considered and dropped (strings
can't hold line breaks without a forgiving parser, and it's still JSON to read).

`prompt/9` asks for two parts: first a readable copy in plain Markdown with short lines,
then the JSON block. The copy is **everything in the JSON, not a summary**, so what the
user checks is what gets imported. Corrections must change both parts. The JSON stays in
its own code block, so the app's copy button still takes just the JSON.

The importer now reads the last ```` ```json ```` block when there is one, so braces in
the readable part can't confuse it, and a corrected block pasted after the first one wins.

## D27 · 2026-10-24 · The API path goes through OpenRouter, and stays provider-neutral

Supersedes the provider part of D6 and §9a ("Anthropic is the first"). The user has an
OpenRouter key and wants to switch models without new accounts, payment methods and keys.
More importantly, the API path should not be shaped around one vendor's features: if it
were, switching vendors would mean redesigning features, not changing a setting.

So the API path relies only on what any vision model through OpenRouter offers: text and
images in, text out, a token count and a cost per call. Concretely:
- **JSON is asked for in the prompt**, and `response_format` carries the reply's JSON
  Schema (`REPLY_JSON_SCHEMA`) for models that support it. The validator stays the real
  check, as on the chat path.
- **Questions and corrections live in Bitebook** (D28), not in a provider's conversation
  state. A revision is a fresh single request carrying the earlier estimate.
- **Photos go as short-lived signed links** (`/img/…`, 30 minutes, HMAC with a key
  derived from `SESSION_SECRET`) rather than inline, which keeps the Worker's CPU time
  and request size down.
- **Cost is OpenRouter's own figure** (`usage.cost`), stored on each run's batch.

The model is a per-user setting (any OpenRouter id), so one person can try another model
without affecting anyone else. The key is the secret `OPENROUTER_API_KEY`.

## D28 · 2026-10-24 · Automatic analysis per meal, with questions and corrections in the app

Changes Core (principles 4 and 7, §3) and reverses parts of D18 and D20. The user wants
to use the API path as the main method for a week or two, to judge whether it matches the
chat (or beats it), what it costs per person per day, and whether family members could
use Bitebook without the copy-and-paste steps.

- **Every new meal is analyzed automatically** when automatic analysis is on (Memory):
  saving queues it, and a cron run every minute takes it (after 30 seconds if it has a
  voice note, so the transcript is ready). Each meal is its own batch, with the API
  variant of the prompt (`prompt/10`). There's no confirmation tap or cost estimate before
  a run (which principle 7 used to require); instead every run's cost is recorded and
  shown on Memory, per day.
- **Questions:** with no chat to ask in, the model gives its best estimate now and may
  add up to two questions to the reply. They show on the meal; the answer (typed or
  spoken) triggers a revision. Skipped questions stay unanswered, and like answered ones
  are never asked again. This reverses D18's "no re-analysis" for the API path.
- **Corrections:** "Correct this" on any analyzed meal takes a typed or spoken correction
  and triggers a revision. This un-parks corrections (D20), but as words for the model,
  not hand-edited numbers.
- **A revision adds an analysis; it never replaces one** (principle 5). The meal shows the
  newest, and every later prompt's digest uses it.
- **Failures** are retried twice (after 2 and 4 minutes), then shown on the meal with a
  "Try again". A reply that fails validation is kept on its batch for debugging, with
  what it cost.
- **The chat handoff stays.** Meals queued or analyzed by the API aren't offered for a
  chat batch, and API runs never appear as open batches on Analyze.

## D29 · 2026-10-24 · A Settings screen, reached from a gear in the header

Settings had collected on Memory (automatic analysis, reminders) and Sign out sat in the
header. Memory is what the prompts know about the user; Settings is how the app behaves.
So there's a Settings screen (`#/settings`) with automatic analysis, reminders and the
account (email, Sign out), reached from a ⚙︎ in the header rather than a fifth tab, which
wouldn't fit on a phone. No avatar for now.

The API path's "Analyze waiting meals" stays (it caught the user's backlog on the first
day): in Settings it shows only when meals are waiting, with the count, and on Analyze the
picked meals can go to the API instead of a chat batch.

## D30 · 2026-10-25 · Today's running total, a Trends tab, and Analyze as a screen

With automatic analysis on, the Analyze tab had no job (it still showed the last chat
batch). The user found a running total useful for deciding on dinner, and wants trends
over weeks and months (Apple Health would also chart them, but they're cheap to have
here).

- **Today shows a running total:** kcal, protein, carbs, fat and fiber from each of
  today's meals' newest estimate, how many are analyzed or still analyzing, and "a usual
  day": the average of the last 7 days before today whose meals are all analyzed. No
  targets to set; that can come later.
- **Trends replaces the Analyze tab** (tabs: Today, Timeline, Trends, Memory). A bar chart
  of one nutrient per day over 7 or 30 days with the average as a line, the same numbers
  as a table, and the model's latest comment and suggestion from either path. Days with
  unanalyzed meals are drawn paler and left out of the average.
- **Analyze becomes a screen** (`#/analyze`), unchanged. In chat mode Today shows "N meals
  waiting for analysis → Analyze in a chat" when there are any; Trends links to it in both
  modes. The tab bar is the same in both modes.
- **The model's questions are hard to miss:** a push notification when a run asks one
  ("A question about your lunch at 13:38"), which opens the meal, and a "Waiting for your
  answer" card at the top of Today until it's answered or skipped. Only questions notify;
  a notification per finished estimate would be four or more a day.

The analysis itself runs between the Worker and OpenRouter, so the app can be closed once
the meal has uploaded; only the upload needs the app open (iOS pauses it otherwise).

## D31 · 2026-10-25 · No polling: each user's clock is a Durable Object alarm

Supersedes the cron parts of D25 (reminders every 15 minutes) and D28 (the analysis queue
every minute). The every-minute cron made about 5,500 of the day's 6,600 D1 queries, nearly
all finding nothing to do. Harmless on cost, wasteful in principle, and it buried the logs.

Following Cadence (github.com/mishra69/cadence, `worker/do/daily-push.js`):
- **One Durable Object per user** (`UserClock`, `src/worker/clock.ts`), holding one alarm set
  for the next thing that user needs: an analysis run that's due, or a reminder (10:30 pm,
  or 8 am after more than a day without a meal). Alarms fire at the exact minute.
- **It keeps no plan of its own.** Each time it fires it does what's due, then works out the
  next wake-up from D1 again (`nextJob`, `nextReminder`), so it can't drift from the data.
  Whether a reminder is still wanted is decided when it fires, against current data (as in
  Cadence: an armed alarm is a prediction).
- **Woken by events:** every queued run (saving a meal, an answer, a correction, a retry),
  and every push subscription, which the app re-sends on each open, so a change of zone
  re-plans the next reminder.
- **One cron remains, daily:** the purge, plus a re-plan of every user's clock as a safety
  net for an alarm lost to a bad deploy. Cadence keeps a 30-minute safety net because it
  also plans each day at its 4 am rollover; Bitebook has nothing to plan ahead.

Free plan: Durable Objects are unlimited in number (up to 100 classes per account), with
100,000 requests a day (alarms count) and 13,000 GB-seconds a day. A few alarms a day per
person uses a sliver of that.

The Trends chart also takes Cadence's reading pattern: drag across it and a pill pinned to
the top tracks the finger and stays after it lifts. The drag is taken on a `<div>` with
`touch-action: none`, because WebKit ignores `touch-action` on SVG and the page would
otherwise scroll mid-read.

## D32 · 2026-10-27 · Uploads: catch a hang in seconds, and don't call it "offline"

The upload log (D23) settled the slow uploads. Every request either finished in 1 to 2.6
seconds or hung completely until its timeout (23 to 45 seconds), and the retry then went
straight through. The app treated each timeout as being offline: it said "Offline" and
waited 5, then 15, then 60 seconds before retrying. Two meals on 2026-10-26 took about 2
and 3½ minutes. Relaunching helped because it dropped the hung request for a fresh one.
The likely cause is iOS reusing a connection that has silently died; the app can't see or
choose connections, but it can stop waiting on them.

- **File uploads go through XHR**, for its upload progress events. If no bytes move for 8
  seconds (or no answer comes 15 seconds after the last byte), the request is dropped and
  retried. The size-based timeout stays as a backstop.
- **A hang, timeout or abandoned request while the phone reports being online is
  "stalled", not "offline":** retried after 1, 3, 10, then 30 seconds, and the status line
  says the meal is waiting and will retry, not that the phone is offline. A real network
  failure is still reported as offline, with the slower backoff.
- The log records each stall, with how many bytes had gone out, to confirm the cause.

## D33 · 2026-10-27 · Each API batch records how the request was made

For the corpus, a batch must say everything the model was given and how it was asked. The
prompt text and the photos (immutable display copies) were already stored. The request
settings were only in the code at whatever version was deployed. Now `batches.request_params`
(migration 0015) records them as sent: provider, model id, reasoning effort, output format
(schema by name and version), token cap, and how the photos went (count, signed links,
which copy, labelled by file name). Chat batches leave it null: the chat app's settings
aren't visible to Bitebook. Batches before this have none either; their settings were the
ones in this change.

## D34 · 2026-10-27 · Apple Health through an iOS Shortcut, once a night, settled meals only

A web app can't write to HealthKit. An iOS Shortcut can, with "Log Health Sample".

- **A key for the Shortcut.** It can't do Google sign-in, so Settings → Apple Health makes a
  key (shown once; only its SHA-256 is stored, migration 0016). It's sent as a bearer
  header to `/shortcut/*`, which has no session. A new key replaces the old one, and
  "Turn off" revokes it. Each family member makes their own.
- **The Shortcut** asks `GET /shortcut/meals` for meals not yet sent. For each it logs
  Dietary Energy, Protein, Carbohydrates, Total Fat and (when known) Fiber, dated at the
  meal's time. Then it posts to the run's `done_url`. Meals are recorded as sent only on
  that confirmation, so a run that fails midway hands them out again. The cost is a
  possible duplicate if only the confirmation fails.
- **Only settled estimates go**, because a Shortcut can add samples but never change or
  delete them: analyzed, no question waiting, nothing queued, unchanged for an hour. A meal
  re-estimated after being sent keeps its old numbers in Health, and Settings counts these.
- **Once a night**, at 11:45 pm, from a personal automation that runs without asking (the
  user's choice). A meal finished later goes the next night, still at its own time.
- **The first run sends every past meal** (up to 200 per run), so Health's history starts
  when Bitebook's did.
- Unknown fiber is left out, not sent as zero.

## D35 · 2026-10-27 · Apple Health: written-out dates; the first run's lessons

The first real run (31 meals) put every sample on the right day but at 12:00: Shortcuts'
"Get Dates from Input" read only the day from ISO 8601. `date` is now written out with a
12-hour time in the meal's local time ("October 26, 2026 at 9:47 PM"), and `date_iso` keeps
the exact instant. Two other errors were in the hand-built Shortcut, not Bitebook: Total Fat
had no Date (so all fat landed at the time of the run), and Protein's value was tied to the
carbs step (each meal got the previous meal's carbs). Both are easy to make, because
Shortcuts labels every variable "Dictionary Value"; the Settings guide now warns about it.

## D36 · 2026-10-28 · The outbox keeps files as bytes, not Blobs

D32's watchdog caught the hung uploads, but on the phone the retries hung too: every
attempt for a file sent 0 bytes in 8 seconds, for as long as an hour, while right after a
relaunch the same file went up in about a second. Meals waiting on the phone also showed a
broken-image "?" instead of their thumbnail. Both fit a known WebKit weakness: a Blob read
back from IndexedDB can become unreadable while the page lives on, and only a fresh page
reads it again.

So the outbox now stores photos and voice notes as ArrayBuffers and makes in-memory Blobs
from them when it reads a meal back (`src/app/lib/outbox.ts`). Meals saved before this are
copied into memory as they're read; if that read fails, the phone logs `blob_unreadable`.
The watchdog stays, in case the hangs have a second cause.

## D37 · 2026-10-28 · One Meals tab; Trends and Settings behind the avatar

With meals in Apple Health (D34), Health's own charts cover long-term trends for anyone
with the Shortcut, and Bitebook's Trends became the less-used screen. It stays, for anyone
without the Shortcut, or on Android, and it costs nothing to keep. But it leaves the tab
bar.

- **Today and Timeline are one tab, Meals:** capture, questions waiting, the running total
  and today's meals on top, then earlier days, paging back as Timeline did. "Add a meal I
  missed" sits under today's meals. Old `#/timeline` links (and notifications already
  delivered) open Meals.
- **Tabs: Meals and Memory.** An avatar (the email's initial) replaces the ⚙︎ of D29 and
  opens a menu with Trends and Settings.
- A missed meal for yesterday now appears under yesterday as soon as it uploads.
- The Apple Health Shortcut keeps its "if fiber" check: an estimate may still leave fiber
  unknown, and a sample without a value would stop the night's run before it confirms.

## D38 · 2026-10-28 · Missed meal sits next to New meal

D37 put "Add a meal I missed" under today's meals: hard to find, and its form opened at the
top of the page, out of sight. It's now "＋ Missed meal" in the bottom bar beside New meal,
and whichever form opens is scrolled into view.
