# Bitebook spec

Before trusting any section, read the header rules in [`CLAUDE.md`](../CLAUDE.md). In short,
**Core** sections are long-lived, **Contract** sections give way to the code once it's
built, and **Plan** sections expire.

---

## 1. Purpose and principles

> **Tier:** Core · **Verified:** 2026-10-18

Bitebook logs a photo of every meal with as little friction as possible, so that the
logging actually happens. It also builds a durable, reusable corpus of meal photos with
model analyses and the user's corrections.

1. **Capture is a few taps and needs no thinking.** Opening the app, taking a photo and saving
   it must work with one hand, offline, in a few seconds. A note is optional.
2. **Photos never touch the camera roll.** They live only in Bitebook's storage.
3. **Nothing is lost.** A photo is "saved" only once the server has stored it. Until then
   it stays queued on the device and is shown as pending.
4. **The human is the API by default.** The app exports batches for a chatbot and imports
   the replies. An optional API path can run the same batch directly (see D6). Both paths
   share one batch, prompt and reply contract, and go through the same validator. The
   API path is a different way to deliver the batch, not a separate feature.
5. **Within a meal, history is append-only.** Analyses and corrections are never edited
   or removed. Each analysis records the model, the prompt version and the date (see D5).
   A whole meal can be deleted deliberately. It is restorable for 30 days, then purged
   with its photos and analyses (see D12).
6. **The corpus stays portable.** Everything can be exported as plain files (JPEG and JSON)
   without Bitebook running.
7. **It runs on the free tier.** It stays within Cloudflare's free limits for one user.
   The API path is the only thing that can cost money. It is off until a key is
   configured, and every run shows its cost estimate before it is sent.
8. **Built for one user, ready for more.** Today only allowlisted emails can sign in.
   Every row and every stored photo belongs to a user, and every query is scoped to the
   signed-in user, so opening it up later is a config change, not a migration (see D9).
   There are no sharing features. The operator can see all stored data. That is stated
   to users, not engineered around.
9. **The app holds the memory, not the chat.** Every prompt carries the context the model
   needs: the pantry, the user's standing notes and the recent trend. So any model, in a
   fresh chat or through the API, sees the same memory, and each batch's stored prompt
   records exactly what context an analysis was based on. Models only *propose* changes
   to memory (a new pantry item from a label); the user confirms them (see D13).

## 2. Architecture

> **Tier:** Core · **Verified:** 2026-10-17

```
iPhone (PWA, home-screen app)
  ├─ IndexedDB: upload queue only (not the source of truth)
  └─ HTTPS ──> Cloudflare Worker (serves static PWA + JSON API)
                 ├─ D1: meals, photos, batches, analyses, corrections
                 ├─ R2: originals/ and display/ images
                 └─ (optional) LLM provider API, for the API path
Laptop
  └─ roll-off script (rclone + Worker admin API) ──> local disk
```

## 3. Core flows

> **Tier:** Core · **Verified:** 2026-10-18

**Capture.** Tap "New meal" to open the camera, then take one or more photos. An
optional note and meal type can be added. The device makes a display copy
and queues both copies. The upload sends the original and the display copy. The meal is
"pending analysis". A capture can instead be marked a **label**: a photo of a nutrition
label or package. It travels in the next batch like a meal, but asks the model to read the
label rather than estimate a plate.

**Export.** Choose the meals to export (by default, every pending meal). The app creates
a **batch** that gives each meal a short key (`A`, `B`, `C`, …), renders the prompt, and
hands the images and the prompt to the chatbot. The batch is stored as "open".
Alternatively, **Run via API** sends the same batch from the Worker. The reply goes straight
into Import, with the model filled in automatically.

**Import.** Paste the reply and select which model produced it. The app validates the reply against
the batch (section 6) and, if it is valid, stores one analysis per meal and marks the batch as
"imported". If it is invalid, nothing is stored and the errors are shown. Each label read
in the reply becomes a **proposed** pantry food, waiting for the user's confirmation.

**Pantry and notes.** The pantry lists foods in use, with nutrition per serving taken from
their labels. The user confirms or edits proposed foods, and marks a food finished when it
runs out; only active foods go into prompts, each with a short code (`F1`, `F2`, …) that the
model cites when it sees that food. Standing notes are free text the user writes once
(goals, household recipes, usual portions) and edits whenever. Both, plus a trend the app
computes from stored analyses, form the context block of every prompt.

**Correct.** On any meal, the user can fix items, portions or totals. Each correction is
stored as a new row that references the analysis it corrects.

**Re-analyze.** Meals that have already been analyzed can be exported again in a new batch,
for example to compare models. This adds analyses and never replaces them.

**Delete.** A meal that hasn't uploaded yet is removed from the phone, after a
confirmation. A saved meal disappears from the app and from exports at once, with an
Undo, and stays in "Recently deleted" for 30 days. After that a daily job removes its
rows and files for good.

**Roll-off.** See section 8.

## 4. Data model (D1)

> **Tier:** Contract · **Verified:** 2026-10-18 · **Expires:** 2027-04-17
>
> Once a table exists in `migrations/`, the migration is authoritative. Reduce its part
> of this section to the reasoning behind it. Implemented so far: `users` (0001, rebuilt in 0002), `meals` and `photos` (0003), `meals.kind` (0004).

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

CREATE TABLE foods (                 -- the pantry
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  code          TEXT NOT NULL,       -- 'F1', 'F2', … per user, never reused
  name          TEXT NOT NULL,       -- 'Mission whole wheat tortilla'
  serving_desc  TEXT NOT NULL,       -- '1 tortilla'
  serving_g     REAL,
  kcal          REAL, protein_g REAL, carbs_g REAL, fat_g REAL, fiber_g REAL,  -- per serving
  status        TEXT NOT NULL,       -- 'proposed' | 'active' | 'finished' | 'rejected'
  source_meal_id     TEXT REFERENCES meals(id),     -- the label capture it came from
  source_analysis_id TEXT REFERENCES analyses(id),
  created_at    TEXT NOT NULL,
  activated_at  TEXT,
  finished_at   TEXT,
  UNIQUE (user_id, code)
);

CREATE TABLE notes (                 -- standing notes; the prompt includes all of them
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE batches (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  created_at      TEXT NOT NULL,
  prompt_version  TEXT NOT NULL,     -- e.g. 'prompt/1'
  prompt_text     TEXT NOT NULL,     -- exactly what was sent
  key_map         TEXT NOT NULL,     -- JSON: {"A": "<meal_id>", ...}
  channel         TEXT NOT NULL DEFAULT 'chat',  -- 'chat' | 'api'
  status          TEXT NOT NULL,     -- 'open' | 'imported' | 'abandoned'
  reply_raw       TEXT,              -- exactly what was pasted back
  reply_model     TEXT,              -- user-selected, e.g. 'claude-opus-5-5'
  summary         TEXT,              -- JSON: reply.summary
  imported_at     TEXT
);

CREATE TABLE analyses (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  meal_id         TEXT NOT NULL REFERENCES meals(id),
  batch_id        TEXT NOT NULL REFERENCES batches(id),
  model           TEXT NOT NULL,
  prompt_version  TEXT NOT NULL,
  schema_version  TEXT NOT NULL,     -- e.g. 'bitebook.reply/1'
  payload         TEXT NOT NULL,     -- JSON: that meal's object from the reply
  created_at      TEXT NOT NULL
);

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

> **Tier:** Contract · **Verified:** 2026-10-17 · **Expires:** 2027-04-17
>
> Implemented in `photoKey()` in `src/shared/meals.ts`, which is authoritative.

Layout: `users/<user_id>/originals/YYYY/MM/<photo_id>.<ext>` and
`users/<user_id>/display/YYYY/MM/<photo_id>.jpg`. Everything a user owns sits under
their prefix, so one user's photos can be exported or deleted as a unit. The month
comes from the meal's local `taken_at`, so roll-off can select by prefix.

Originals are stored byte for byte, EXIF included, which makes them the corpus. Display
copies are 1600 px on the long edge, JPEG at quality 0.8, with EXIF stripped (location
never reaches a chatbot). They're what gets exported for analysis. Vision models
downscale to about this size anyway, and the smaller files keep uploads cheap.

## 6. Prompt and reply contract

> **Tier:** Contract · **Verified:** 2026-10-18 · **Expires:** 2027-04-17
>
> Once implemented, the prompt template file and reply validator are authoritative. Any
> change bumps `prompt/N` or `bitebook.reply/N`. Old versions stay readable.

### Prompt (`prompt/1`)

The app renders the prompt as plain text. The images are attached alongside it and named
`<key>-<n>_<YYYY-MM-DD>_<HHMM>.jpg` (for example `B-2_2026-10-16_1932.jpg`), so each one is
self-describing even if the attachment order gets shuffled.

```
You are analyzing my meal log. Batch: {batch_id}

Each meal below has a key, and its photos are attached with filenames starting
with that key. Times are my local time.

## Context (from my app; treat it as reliable)
Standing notes:
{each note, or "—"}
Pantry — foods I'm currently using, with values from their labels. When you see one,
use these values and cite its code:
[F1] Mission whole wheat tortilla — 1 tortilla (45 g): 130 kcal · P 4 g · C 22 g · F 3.5 g · fiber 4 g
{… or "—"}
Recent trend (computed by the app from past analyses): last 7 days, {n} meals,
avg {kcal} kcal/day · protein {p} g/day. Last batch summary: {text or "—"}

## Entries
{for each entry}
[{key}] {weekday} {YYYY-MM-DD} {HH:MM} · {meal_type or "meal" | "LABEL"} · photos: {filenames}
Note: {note or "—"}
{end}

For each meal, identify the foods, estimate portions, and estimate nutrition. Use pantry
values for pantry foods and set food_code. Use my notes when they clarify something the
photo can't show (e.g. "half eaten", "oil-free"). If a photo is unusable, mark that entry
skipped and say why.

For each LABEL entry, read the nutrition label instead: name, serving and per-serving
values exactly as printed. Don't estimate a plate for it.

Then write a short summary across the whole batch: patterns, anything notable,
and one or two practical suggestions.

Reply with ONLY one JSON code block matching this schema, with no other text:
{reply schema, inlined with an example}
```

### Reply (`bitebook.reply/1`)

```json
{
  "schema": "bitebook.reply/1",
  "batch_id": "01JA...",
  "meals": [
    {
      "key": "A",
      "skipped": false,
      "skip_reason": null,
      "items": [
        { "name": "dal tadka", "portion": "1 bowl", "grams": 250, "food_code": null,
          "kcal": 280, "protein_g": 14, "carbs_g": 36, "fat_g": 9, "fiber_g": 8 },
        { "name": "tortilla", "portion": "2 tortillas", "grams": 90, "food_code": "F1",
          "kcal": 260, "protein_g": 8, "carbs_g": 44, "fat_g": 7, "fiber_g": 8 }
      ],
      "totals": { "kcal": 280, "protein_g": 14, "carbs_g": 36, "fat_g": 9, "fiber_g": 8 },
      "confidence": "medium",
      "observations": "Looks like ~1 tsp ghee on top.",
      "questions": ["Was the rice white or brown?"]
    },
    {
      "key": "B",
      "skipped": false,
      "skip_reason": null,
      "label": {
        "name": "Mission whole wheat tortilla", "serving_desc": "1 tortilla", "serving_g": 45,
        "kcal": 130, "protein_g": 4, "carbs_g": 22, "fat_g": 3.5, "fiber_g": 4
      },
      "confidence": "high",
      "observations": "Values per tortilla, as printed.",
      "questions": []
    }
  ],
  "summary": {
    "text": "…",
    "patterns": ["…"],
    "suggestions": ["…"]
  }
}
```

### Import validation

This applies to both paths. An API reply is treated exactly like a pasted one.

The import is all-or-nothing. If any check fails, nothing is stored.

- The pasted text may be wrapped in a ```` ```json ```` fence or have extra text around it. Extract
  the first JSON object.
- `schema` must be a version the app knows. `batch_id` must match an **open** batch.
- The set of `meals[].key` values must be **exactly** the batch's keys: none missing, none
  extra, no duplicates.
- Numbers must be ≥ 0 or null. `confidence` must be one of low, medium or high.
- A meal entry has `items` and `totals`. A LABEL entry has `label` instead. Each label
  becomes a `proposed` food, and nothing enters prompts until the user confirms it.
- `food_code`, when set, must be one of the active codes listed in this batch's prompt.
- Totals that differ from the sum of the items by more than 10% produce a warning, not an error.
- Skipped meals are stored as analyses with `skipped: true` but **remain pending**, so
  they show up in the next export.

## 7. Capture: what still needs an iPhone

> **Tier:** Plan · **Verified:** 2026-10-18 · **Expires:** 2026-12-17

Capture is built (`src/app/Capture.tsx`, `src/app/lib/`, `src/worker/meals.ts`). It was
tested in Chromium: EXIF time, drafts surviving a reload, offline save, the queue
draining on reconnect, and originals byte-identical in R2. These are only knowable on the
phone. Delete this section once they're checked:

- **Display size on iOS:** the next photo's display copy should be about 250 KB, with
  quality 0.8. Safari ignored the quality setting of both `toBlob` and `toDataURL`, so
  display copies are now encoded in JS (`src/app/lib/jpeg.ts`). That costs ~0.3 s per
  12 MP photo on a laptop; check that it still feels quick on the phone.
- **Reload behind the camera:** if iOS reloads the app while the camera is open, the
  draft should come back.
- **Offline:** capture in airplane mode, then reconnect. The meal should upload by
  itself.
- **Memory:** several 12 MP photos in one meal should not crash the app.

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

> **Tier:** Plan · **Verified:** 2026-10-17 · **Expires:** 2027-01-17

- `POST /api/batches/:id/run` with `{ model }`. The Worker loads the display copies from R2,
  sends the stored `prompt_text` and the images in a single request, and passes the
  response text to the same import validator. It sets `channel = 'api'`, and
  `reply_model` comes from the provider's response, not from user input.
- The provider key is stored as a Worker secret, never on the device. Providers sit behind a
  small adapter (`buildRequest`, `extractText`) so another vendor can be added for model
  comparisons. Anthropic is the first.
- Before sending, the app shows an estimated cost (images and prompt tokens) and needs a
  confirmation tap. There is no automatic or scheduled run.
- If the request fails or the reply is invalid, the batch stays open and the raw response is kept
  for debugging. The user can retry or fall back to the chat handoff.
- Large batches may need splitting to stay within provider request limits. Measure this
  before designing around it.

## 10. Screens

> **Tier:** Plan · **Verified:** 2026-10-18 · **Expires:** 2027-01-17

Built: Today (capture), Timeline and Meal detail (`src/app/`). Still to come: badges for
in-batch or analyzed on timeline rows, and analyses and corrections on the detail screen.

4. **Pantry and notes:** proposed foods to confirm or edit, active foods (mark finished),
   finished ones; the standing notes.
5. **Export:** select meals, then share or copy, or use "Run via API" when a key is
   configured. The batch is created at this step.
6. **Import:** pick the open batch, paste the reply, pick the model, then validate and save.
7. **Settings:** storage usage, the default model name, and abandoning stale open batches.

## 11. Build order

> **Tier:** Plan · **Verified:** 2026-10-18 · **Expires:** 2027-01-17

*Steps 1–3 are built. The remaining on-device checks for capture are in §7.*

4. Export: batch creation, the prompt with its context block, and the share/copy handoff.
5. Import: validation and storage, including proposed foods; the pantry and notes screen.
6. Corrections.
7. The roll-off script.
8. The API path (optional; it reuses everything from steps 4–5).

## 12. Open questions

> **Tier:** Plan · **Verified:** 2026-10-17 · **Expires:** 2026-12-17

- **Handoff mechanics.** The browser clipboard can't hold several images plus text at
  once. The leading option is the Web Share API (`navigator.share({ files, text })`),
  which sends the images and prompt to the Claude app through the iOS share sheet, with
  "copy prompt" as a separate button in case the share target drops the text. Fallbacks
  are a downloadable zip, or a contact-sheet image with the keys drawn on it. We need to
  test which one the Claude app accepts, and how many images fit in one message.
- **Meal grouping.** Should photos taken within N minutes of each other merge into one
  meal automatically, or is it always manual?
