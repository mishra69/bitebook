# Bitebook spec

Before trusting any section, read the header rules in [`CLAUDE.md`](../CLAUDE.md). In short,
**Core** sections are long-lived, **Contract** sections give way to the code once it's
built, and **Plan** sections expire.

---

## 1. Purpose and principles

> **Tier:** Core · **Verified:** 2026-10-24

Bitebook logs a photo of every meal with as little friction as possible, so that the
logging actually happens. A meal that wasn't photographed can be described afterwards
instead (D24). It also builds a durable, reusable corpus of meal photos with
model analyses and the user's corrections.

1. **Capture is a few taps and needs no thinking.** Opening the app, taking a photo and saving
   it must work with one hand, offline, in a few seconds. A note is optional.
2. **Photos never touch the camera roll.** They live only in Bitebook's storage.
3. **Nothing is lost.** A photo is "saved" only once the server has stored it. Until then
   it stays queued on the device and is shown as pending.
4. **Two ways to analyze, one contract.** The chat handoff (the human is the API) exports
   batches for a chatbot and imports the replies. The API path analyzes each new meal
   automatically through OpenRouter (D27, D28). Both share one batch, prompt and reply
   contract, and go through the same validator. The API path relies only on what any
   vision model offers, so changing models is a setting.
5. **Within a meal, history is append-only.** Analyses and corrections are never edited
   or removed. Each analysis records the model, the prompt version and the date (see D5).
   A whole meal can be deleted deliberately. It is restorable for 30 days, then purged
   with its photos and analyses (see D12).
6. **The corpus stays portable.** Everything can be exported as plain files (JPEG and JSON)
   without Bitebook running.
7. **It runs on the free tier.** It stays within Cloudflare's free limits for one user.
   The API path is the only thing that costs money. It is off until the user turns it
   on, and every run's cost is recorded and shown per day (D28).
8. **Built for one user, ready for more.** Today only allowlisted emails can sign in.
   Every row and every stored photo belongs to a user, and every query is scoped to the
   signed-in user, so opening it up later is a config change, not a migration (see D9).
   There are no sharing features. The operator can see all stored data. That is stated
   to users, not engineered around.
9. **The app holds the memory, not the chat.** Every prompt carries the context the model
   needs: the user's notes, the remembered foods, a text digest of the last 30 days and a
   trend the app computes. So any model, in a fresh chat or through the API, sees the
   same memory, and each batch's stored prompt records exactly what context an analysis
   was based on (see D13, D15).
10. **Approximate and consistent beats precise and abandoned.** Logging must never become
   a chore. Estimates are rough (a description, calories and macros per meal, with a
   confidence), and nothing asks the user to weigh, look up or confirm anything. Memory
   maintains itself; the user can look at it and remove things, but never has to (D15).

## 2. Architecture

> **Tier:** Core · **Verified:** 2026-10-25

```
iPhone (PWA, home-screen app)
  ├─ IndexedDB: upload queue only (not the source of truth)
  └─ HTTPS ──> Cloudflare Worker (serves static PWA + JSON API)
                 ├─ D1: meals, photos, batches, analyses, questions, jobs
                 ├─ R2: originals/, display/ images and voice/ notes
                 ├─ Durable Objects: one clock per user (analysis runs, reminders)
                 ├─ Workers AI: Whisper, for voice notes
                 └─ OpenRouter (any vision model), for the API path
Laptop
  └─ roll-off script (rclone + Worker admin API) ──> local disk
```

## 3. Core flows

> **Tier:** Core · **Verified:** 2026-10-31

**Capture.** Tap "Snap it" to open the camera, then take one or more photos. An
optional note and meal type can be added. The device makes a display copy
and queues both copies. The upload sends the original and the display copy. The meal is
"pending analysis". A photo of a package or nutrition label can be part of any meal; the
model uses whatever it can read.

A meal stays open while it's eaten: photograph every helping as you take it. Each photo
keeps its own time, and the prompt shows the gaps ("+16 min"), so the model counts
helpings instead of mistaking them for angles of one plate. The draft is stored on the
phone from its first photo. If it's left open for 90 minutes after its last photo, the
app saves it the next time it opens; the meal's times come from its photos, so a late save
changes nothing (D19).

A meal can have one **voice note** of up to a minute, recorded in the draft, for example to
describe each helping before saving. The server transcribes it with Whisper (Workers
AI), and the prompt carries the transcript. The transcript isn't editable: if it's often
wrong, the fix is a better transcriber, not hand-editing (D21).

**A meal by voice, or one missed.** "Say it", next to Snap it, opens a draft without a
photo and starts recording at once. It's for routine meals not worth a photo, and for meals
logged afterwards: the time starts at now and steps back by the hour, to today or
yesterday. A typed note works too. The meal type is optional and suggested from the
time. The prompt marks the time as approximate and tells the model it's a description
only (D24, D39, D40).

**Export.** Choose the meals to export (by default, every pending meal). The app creates
a **batch** that gives each meal a short key (`A`, `B`, `C`, …), renders the prompt, and
hands the images and the prompt to the chatbot. The batch is stored as "open".

**Automatic analysis (the API path).** When it's on, each saved meal is analyzed a minute
or so later through OpenRouter, as a one-meal batch with the API variant of the prompt,
and imported through the same validator. If the model needs to know something, its
questions wait on the meal; answering them re-estimates it (D28).

**Import.** Paste the reply and select which model produced it. The app validates the reply against
the batch (section 6) and, if it is valid, stores one analysis per meal and marks the batch as
"imported". If it is invalid, nothing is stored and the errors are shown. The reply's changes to
remembered foods are applied at the same time, with no confirmation step. If the model needed to ask something (at most two questions, only when it
matters), it asked in the chat before replying, so the answers are already in its
estimates. The app records the questions so they're never asked again.

**Memory.** Every prompt starts with a context block built by the app:
- **notes**: optional free text the user writes once (goals, household recipes, usual
  portions);
- **remembered foods**: foods the model asked to remember (from a label it read, or a dish
  it saw recurring), each with a stable code (`F1`, `F2`, …) and rough values per serving;
- **digest**: one text line per analyzed meal from the last 30 days, which is what lets
  a model spot recurring dishes and stay consistent across batches;
- **trend**: averages the app computes from stored analyses.

The user can view remembered foods and retire one that's wrong, but never has to.

**Correct.** On an analyzed meal, "Correct this" takes a typed or spoken correction ("it
was paneer", "I ate half"), and the model re-estimates the meal with it. The new estimate
is added; the earlier one is kept (D28).

**Re-analyze.** Answers and corrections add analyses and never replace them. Comparing
models on the same meals works the same way, later.

**Delete.** A meal that hasn't uploaded yet is removed from the phone, after a
confirmation. A saved meal disappears from the app and from exports at once, with an
Undo, and stays in "Recently deleted" for 30 days. After that a daily job removes its
rows and files for good.

**Roll-off.** See section 8.

## 4. Data model (D1)

> **Tier:** Contract · **Verified:** 2026-10-31 · **Expires:** 2027-04-30
>
> Once a table exists in `migrations/`, the migration is authoritative. Reduce its part
> of this section to the reasoning behind it. Implemented so far: `users` (0001, rebuilt in 0002), `meals` and `photos` (0003),
> `batches`, `analyses`, `foods` and `notes` (0006), `questions` (0008), `photos.taken_at` (0009),
> `voice_notes` (0010), `foods.fiber_g` (0011),
> `diag_events` (0012, the phone's upload log, D23), `push_subscriptions` and
> `reminders_sent` (0013, D25), the API path's `users.api_model`, batch cost columns,
> open questions and `analysis_jobs` (0014, D28), `batches.request_params` (0015, D33),
> `health_keys`, `health_runs` and `health_exports` (0016, D34); `users.picture_url` (0017, D41).
> (`meals.kind` came in 0004 and went in 0005, D15.)

**Ownership rule:** every table except `users` has `user_id TEXT NOT NULL REFERENCES
users(id)`, and every query filters on the signed-in user's id. That includes child
tables like `photos`, even though their parent `meal_id` already implies the owner.
Putting `user_id` directly on every table makes a forgotten join show up as an empty
result, not as someone else's data.

All IDs are ULIDs (sortable by time). All timestamps are ISO 8601 with a UTC offset, and
`tz` holds the IANA zone name, so the local meal time stays correct when traveling.

```sql
-- users: see migrations/0002_users_google_sub.sql (id, google_sub, email, ...).
-- Users are keyed on Google's immutable `sub`; email is refreshed on each sign-in.

-- meals, photos: see migrations/0003_meals_photos.sql. Not obvious from the SQL:
--  * Meal and photo ids are ULIDs made on the device, so a retried upload is the
--    same row, never a duplicate.
--  * taken_ms duplicates taken_at as epoch ms. ISO strings with different offsets
--    don't sort correctly as text, which matters once you travel.
--  * A meal row is written only after every file is confirmed in R2 with the
--    expected size and SHA-256, so a meal never points at a missing photo.
--  * deleted_at marks a deletion the user can still undo. 0003's comment says rows
--    are never hard-deleted. D12 replaced that: src/worker/purge.ts removes meals
--    deleted more than 30 days ago, with their photos (and, once they exist, their
--    analyses and corrections).

-- batches, analyses, foods, notes: see migrations/0006_batches_analyses_memory.sql.
--  * analyses.skipped is a column, not just a payload field, so "pending" is a plain
--    query: no non-skipped analysis, and not in an open batch's key_map.
--  * batches.active_codes records which remembered-food codes the prompt listed, so
--    import can reject a reply that cites a code the model was never shown.
--  * foods are updated in place (they're memory, not history); the reply that changed
--    one is kept verbatim in its batch.

CREATE TABLE corrections (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  meal_id      TEXT NOT NULL REFERENCES meals(id),
  analysis_id  TEXT REFERENCES analyses(id),  -- null if not tied to one analysis
  payload      TEXT NOT NULL,      -- JSON, same shape as a reply meal object
  note         TEXT,
  created_at   TEXT NOT NULL
);
```

A meal is **pending** when it has no analyses and is not in an open batch. "Analyzed"
is derived, not stored.

## 5. Storage layout (R2)

> **Tier:** Contract · **Verified:** 2026-10-24 · **Expires:** 2027-04-17
>
> Implemented in `photoKey()` in `src/shared/meals.ts`, which is authoritative.

Layout: `users/<user_id>/originals/YYYY/MM/<photo_id>.<ext>`,
`users/<user_id>/display/YYYY/MM/<photo_id>.jpg` and, for voice notes,
`users/<user_id>/voice/YYYY/MM/<meal_id>.<m4a|webm>` (`voiceKey()`). Spoken answers and
corrections on the API path are kept as `users/<user_id>/voice/replies/<id>.<ext>`. Everything a user owns sits under
their prefix, so one user's photos can be exported or deleted as a unit. The month
comes from the meal's local `taken_at`, so roll-off can select by prefix.

Originals are stored byte for byte, which makes them the corpus. On iPhone they carry no
EXIF at all, since iOS strips it from web-page camera captures, so no location is ever
stored (D19). Photos from other sources keep whatever metadata they came with. Display
copies are 1600 px on the long edge, JPEG at quality 0.8, with EXIF stripped (location
never reaches a chatbot). They're what gets exported for analysis. Vision models
downscale to about this size anyway, and the smaller files keep uploads cheap.

## 6. Prompt and reply contract

> **Tier:** Contract · **Verified:** 2026-10-24 · **Expires:** 2027-04-17
>
> Once implemented, the prompt template file and reply validator are authoritative. Any
> change bumps `prompt/N` or `bitebook.reply/N`. Old versions stay readable.

### Prompt (`prompt/10`)

Implemented in `src/shared/prompt.ts`, which is authoritative (template, digest line,
trend, batch keys, photo file names); `tests/unit/prompt.test.ts` pins its shape. What the
code can't say:

- Photos are attached separately and named `<key>-<n>_<YYYY-MM-DD>_<HHMM>.jpg`, so each one
  is self-describing even if a chat app reorders attachments.
- The prompt opens by asking for *rough, consistent* estimates (principle 10), and asks
  the model to stay consistent with how similar meals in the digest were estimated.
  That's what turns the digest into continuity.
- The digest holds the last 30 days, newest first, capped at 150 lines (about 4k tokens).
  The trend is computed by the app, never by the model.
- A batch is capped at 20 photos (`MAX_PHOTOS_PER_BATCH`), a common per-message
  attachment limit in chat apps.
- Each photo is listed with its own time and its gap from the meal's first photo, and the
  prompt explains helpings: several minutes apart means another serving to count, about a
  minute apart means another angle of the same plate (D19).
- A voice note's transcript follows the meal's note, labelled as the user's own words,
  and the prompt says to trust it over the photos but allow for slips in food names. A
  transcription that failed is retried when the batch is created; if it still fails, the
  prompt says a recording exists but couldn't be transcribed (D21).
- Questions happen in the chat, before the JSON (D18): at most 2, only when an answer would
  move an estimate by about 100 kcal or matter for future meals, and never one listed under
  "Questions already asked". The model folds the answers into its one reply; nothing is
  re-analyzed. The reply's `asked` list goes into the `questions` table (migration 0008),
  which feeds that block in every later prompt (newest 60).
- A meal without a photo (D24) is listed as "no photo (added afterwards from my
  description)" with its time as "~13:00", and the model is told to estimate from the
  words alone and lower its confidence.
- **The API variant** (`channel: "api"`, D28) differs only at the ends: questions go into
  the reply's `questions` list instead of the chat, the reply is the JSON alone, and a
  revision adds the earlier estimate and the user's answers or correction.
- The reply opens with a readable copy of the whole JSON (not a summary), in short
  Markdown lines a phone can show without sideways scrolling, then the JSON block (D26).
- Estimates include fiber since `prompt/7`: per meal, per remembered food, and as a daily
  average in the trend (D22).

### Reply (`bitebook.reply/1`) and import

Implemented in `src/shared/reply.ts` (parsing and validation) and the import route in
`src/worker/batches.ts`, which are authoritative. `tests/unit/reply.test.ts` runs them
against the first real reply (`tests/fixtures/replies/`). What the code can't say:

- Import is all-or-nothing: the analyses, the remembered-food changes and closing the
  batch go to D1 as one transaction. Any validation error stores nothing, and every error
  is shown at once, so one paste-and-fix round is enough.
- When the paste has a ```` ```json ```` block, the last one is what's imported, so the
  readable copy before it can't interfere (D26).
- Validation is strict about structure (exactly the batch's keys, codes the prompt
  actually listed) and forgiving about form: chatter or a ```` ```json ```` fence around
  the JSON, and numbers written as strings ("400").
- The reply names the model that wrote it, as far as it knows (`prompt/3`). Pasting fills
  the Model box from that, and the user confirms or corrects it. Both are stored: the
  confirmed name on every analysis (`batches.reply_model`, `analyses.model`), and the raw
  self-report in `batches.reply_model_reported`. Models misname themselves often enough
  that the self-report is never the record on its own (D17).
- A skipped meal gets an analysis row with `skipped = 1` and stays ready to analyze.
- `questions` (API path only): up to two questions for the user, stored unanswered on the
  meal. The JSON Schema in `reply.ts` is sent as `response_format` where a model supports
  it; the validator doesn't depend on that (D27).
- `fiber_g` is optional (D22): replies from before `prompt/7`, or from a model that leaves
  it out, still import, with fiber unknown.
- `asked` is history, not data the estimates depend on, so it never fails an import: a
  malformed list counts as no questions, and an echoed sample is ignored.

## 7. Capture: what still needs an iPhone

> **Tier:** Plan · **Verified:** 2026-10-31 · **Expires:** 2026-12-17

Capture is built (`src/app/Capture.tsx`, `src/app/lib/`, `src/worker/meals.ts`). Checked on
the iPhone by 2026-10-23: reload behind the camera, offline save then upload on
reconnect, several 12 MP photos in one meal, helpings counted by the model, voice notes
(auto-stop at 1:00, transcripts good enough: "Nandes" for naans was still read right; Hindi
comes out in Devanagari, which models read fine). Known limitation: iOS asks for the
microphone again on later launches of the home-screen app; nothing in the app can change
that.

Still to check, then delete this section:

- **Apple Health:** checked 2026-10-27: 31 meals at their own times, with values matching
  Bitebook's. Still to see: does the 11:45 pm automation run on its own?

- **Question notifications:** when a run asks something, does the notification arrive, and
  does it open the meal? Is the "Waiting for your answer" card on Meals easy to spot?
- **The API path trial:** turn it on in avatar → Settings → Automatic analysis. Do estimates arrive
  a minute or so after saving? Are they as good as the chat's? Do questions and "Correct
  this" (typed and spoken) feel natural? What does Memory say it costs per day?

- **Reminders:** turn them on from the card on Meals (home-screen app only), then
  avatar → Settings → Reminders → "Send a test". Does it arrive, and does tapping it open
  Meals? Does the 10:30 pm one arrive on time?
- **A meal by voice:** "Say it" (next to Snap it), speak, stop, save. Does the
  reply estimate it sensibly from the words alone?

- **Auto-save:** leave a draft open, come back more than 90 minutes later, and the meal
  should be saved, with a note saying so.
- **Meals and the avatar (D37, D39):** is one Meals tab comfortable to scroll, with today
  on top and earlier days as rows below? Do the right days start open (yesterday, and any
  day still being analyzed)? Is the missed-meal time stepper quick enough? After signing
  out and in once, does the avatar show the Google photo? Is the avatar menu easy to find for Trends and Settings?
- **Slow uploads:** the watchdog (D32) caught the hangs but retries hung too, every one with
  0 bytes sent, until a relaunch; meals still on the phone showed "?" thumbnails. Both point
  at Blobs read back from IndexedDB going unreadable, so the outbox now keeps bytes (D36).
  Do uploads finish without a relaunch, and do waiting meals show their photos? The upload
  log (`diag_events`) shows each stall, its bytes sent, and any `blob_unreadable`.

## 8. Roll-off of originals

> **Tier:** Plan · **Verified:** 2026-10-17 · **Expires:** 2027-01-17

The roll-off is a script that runs on the laptop: `scripts/rolloff --older-than 12m --dest /path/to/archive`.

1. `GET /api/admin/rolloff-candidates?before=<date>` returns the photo IDs, R2 keys and
   SHA-256s where `original_status = 'r2'`, across all users. It is the operator's tool, not
   a user feature, and it is authenticated with an `ADMIN_TOKEN` secret, not a user session.
2. `rclone copy` copies those keys from R2 (through the S3-compatible API) to `<dest>/originals/…`,
   keeping the same layout.
3. Re-hash every local file and compare it with D1. **Stop on any mismatch.**
4. `POST /api/admin/mark-archived` with the verified IDs sets `original_status` and `archived_at`.
5. Only after step 4, delete those keys from R2.
6. Also write a D1 export (`wrangler d1 export`) and all display copies to `<dest>`, so
   the local archive is a complete corpus on its own.

Run it yearly, or whenever R2 approaches ~8 GB. The app shows the R2 usage on a settings screen.

## 9. Stack and hosting

> **Tier:** Plan · **Verified:** 2026-10-17 · **Expires:** 2027-01-17

- **Frontend:** TypeScript, Vite, Preact. The PWA parts (service worker, `_headers`,
  manifest, icons, iOS head tags, install prompt, versioned deploys) follow the
  `pwa-cloudflare` skill (D10). Files copied unmodified are listed in `.skill-assets`.
- **Backend:** a single Cloudflare Worker that serves the static assets and the `/api/*`
  routes (Hono), with D1 and R2 bindings. It is deployed with Wrangler.
- **Auth (D8, D10):** Google sign-in with the ID-token flow (Google Identity Services).
  The page gets a signed ID token from Google, and the Worker verifies it with the
  skill's `oidc.js` (signature, `aud`, `iss`, `exp`). No client secret is involved. On
  first sign-in it creates a `users` row keyed on `sub`, then it issues its own 90-day
  session cookie (signed with `SESSION_SECRET`) that carries the user id. Only emails in `ALLOWED_EMAILS` can sign in, and removing
  one revokes that user's sessions. Until it is configured, the API refuses every request.
- **Free-tier fit:** a few uploads a day is far below the R2 operation and Worker request limits.
  Storage is the only thing that grows, and roll-off controls it.

## 9a. API path

> **Tier:** Plan · **Verified:** 2026-10-25 · **Expires:** 2027-01-17

Built: `src/worker/analyze.ts` (queue, OpenRouter call, signed photo links, routes), run by
each user's clock (`src/worker/clock.ts`, a Durable Object alarm, D31),
`src/app/ApiPanel.tsx` and `src/app/AutoAnalysis.tsx`. Why it's shaped this way: D27
and D28. The trial (from 2026-10-24, a week or two) answers three questions: is it as
good as the chat, what does it cost per person per day (Settings shows it), and is it
easy enough for family members.

## 10. Screens

> **Tier:** Plan · **Verified:** 2026-10-31 · **Expires:** 2027-01-31

Built (`src/app/`): no tabs. The home screen is Meals (capture, questions waiting,
running total, chat-waiting card, today's meals, then earlier days as one row per day with
its totals, opening to its meals and loading older days on scroll; Say it and Snap it in
the bottom bar). The avatar in the header (the Google profile photo, else the email's
initial) opens Trends (daily charts, latest comment), Memory and Settings, each with
"← Meals"; tapping "Bitebook" also goes home. Other screens: Meal detail (analyses,
questions, corrections) and Analyze (the chat handoff, reached from Meals and Trends).
Signed out, the screen is just the icon, the name and the Google button, centered.
See D29, D30, D37, D39, D41. Ideas for later: storage usage in Settings, daily targets for
the running total.

## 11. Build order

> **Tier:** Plan · **Verified:** 2026-10-31 · **Expires:** 2027-01-31

*Steps 1–5 are built, plus questions (D18), per-photo times and draft auto-save (D19),
voice notes (D21), fiber (D22), missed meals without a photo (D24), reminders (D25), the
API path with questions and corrections (D27, D28), which moved ahead of the rest on
2026-10-24, and the running total, Trends and question notifications (D30), and per-user clocks in place
of polling (D31), and the Apple Health export (D34).
The remaining on-device checks for capture are in §7.*

7. **Upload draft photos as they're taken**, so Save is instant and photos survive a
   lost phone mid-meal. Needs a nightly cleanup of R2 files no saved meal refers to
   (discarded drafts). Demoted 2026-10-24: uploads were slow with the app open, so this
   wouldn't have helped; wait for the upload log (D23) to show why.
8. The roll-off script (demoted 2026-10-24).

Parked, to decide after the API trial (numbers from the first real runs, 2026-10-24:
Opus 5.5 cost 4.4¢ for a one-photo meal, 7.8¢ for three photos, 7.1¢ for a revision;
about 2,600 input tokens per photo):
- **Coaching: a daily tip** drawn from the history, to nudge habits slowly. Not
  time-critical, so it could use a provider's batch mode (about half price), but at one
  call a day that saves under a cent. The design questions matter more: what history it
  sees, how tips avoid repeating, where it shows (Today, or the morning reminder).
- **Cheaper revisions with prompt caching.** A revision re-sends the whole prompt and every
  photo at full price. To be cacheable it must repeat the first request exactly, then the
  model's reply, then the user's words (today it rebuilds the prompt). OpenAI and Gemini
  cache automatically for free; Claude needs a cache mark, costs 25% more to write and
  keeps it 5 minutes. That pays only if quick answers are common: check how often
  questions come and how fast they're answered during the trial.
- **Cleaning up remembered foods** (added 2026-10-26). Expected: a few foods cover most meals,
  and most are rarely repeated, so the list (one prompt line each) keeps growing. Memory
  shows each food's uses and last use (derived from each meal's newest estimate). After a
  month or two of use, look at the spread and decide whether stale foods should retire
  automatically, e.g. unused for 30 days, restorable. Until then the user isn't retiring
  anything by hand, so the data stays unbiased. First check that models cite codes
  reliably: by 2026-10-26 only 3 of 7 foods had ever been cited, so an automatic rule
  would retire foods that are still eaten.
- **Smaller photos for the model.** At about 1,000 px instead of 1,600, image tokens drop
  by about 60%. Test on a few meals before switching, since portions may suffer.
- **Model and photo-size experiment** (added 2026-10-31). Real runs average 5.2¢ a meal:
  the text prompt is ~48% of it, output ~31%, photos ~21%, so the model matters most and
  photo size least. Replay the same meals through Opus twice (the noise floor), Sonnet,
  Haiku and smaller photos, in chat mode on the user's Pro plan, with an experiment
  import that never touches real estimates. Also: send only relevant remembered foods.
- **"Again" chips for routine meals** (added 2026-10-31). Under "Say it", the meals usually
  eaten at this time ("coffee + cake"), logged in one tap. Open question: copy the last
  estimate without a model call, or still analyze; the user is unsure the first works.

Backlog (corpus only, no effect on nutrition data):
- **👎 on a bad transcript.** One tap on the meal detail flags a voice note's transcript
  as poor; nothing is edited. Later, re-run the flagged notes (and a sample of
  unflagged ones) through a newer transcription model and compare. The kept audio
  makes that possible. A better transcript is stored alongside, never fed back into
  past analyses (D21).


## 12. Open questions

> **Tier:** Plan · **Verified:** 2026-10-23 · **Expires:** 2026-12-17

- **Handoff to the Claude app.** Checked 2026-10-23: "Copy prompt" then "Share photos"
  works with the Claude app. Still unknown: whether 20 photos is its real limit.
