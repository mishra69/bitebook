# Bitebook spec

Before trusting any section, read the header rules in [`CLAUDE.md`](../CLAUDE.md). In short,
**Core** sections are long-lived, **Contract** sections give way to the code once it's
built, and **Plan** sections expire.

---

## 1. Purpose and principles

> **Tier:** Core · **Verified:** 2026-10-17

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
5. **History is append-only.** Analyses and corrections are never overwritten. Each
   analysis records the model, the prompt version and the date (see D5).
6. **The corpus stays portable.** Everything can be exported as plain files (JPEG and JSON)
   without Bitebook running.
7. **It runs on the free tier.** It stays within Cloudflare's free limits for one user.
   The API path is the only thing that can cost money. It is off until a key is
   configured, and every run shows its cost estimate before it is sent.
8. **There is a single user.** There are no accounts or sharing features.

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

> **Tier:** Core · **Verified:** 2026-10-17

**Capture.** Tap "New meal" to open the camera, then take one or more photos. An
optional note and meal type can be added. The device makes a display copy
and queues both copies. The upload sends the original and the display copy. The meal is
"pending analysis".

**Export.** Choose the meals to export (by default, every pending meal). The app creates
a **batch** that gives each meal a short key (`A`, `B`, `C`, …), renders the prompt, and
hands the images and the prompt to the chatbot. The batch is stored as "open".
Alternatively, **Run via API** sends the same batch from the Worker. The reply goes straight
into Import, with the model filled in automatically.

**Import.** Paste the reply and select which model produced it. The app validates the reply against
the batch (section 6) and, if it is valid, stores one analysis per meal and marks the batch as
"imported". If it is invalid, nothing is stored and the errors are shown.

**Correct.** On any meal, the user can fix items, portions or totals. Each correction is
stored as a new row that references the analysis it corrects.

**Re-analyze.** Meals that have already been analyzed can be exported again in a new batch,
for example to compare models. This adds analyses and never replaces them.

**Roll-off.** See section 8.

## 4. Data model (D1)

> **Tier:** Contract · **Verified:** 2026-10-17 · **Expires:** 2027-04-17
>
> Once `migrations/` exists, the migrations are authoritative. Reduce this section to the
> reasoning behind them.

All IDs are ULIDs (sortable by time). All timestamps are ISO 8601 with a UTC offset, and
`tz` holds the IANA zone name, so the local meal time stays correct when traveling.

```sql
CREATE TABLE meals (
  id          TEXT PRIMARY KEY,
  taken_at    TEXT NOT NULL,       -- first photo's EXIF time, else capture time
  tz          TEXT NOT NULL,       -- e.g. 'America/Chicago'
  meal_type   TEXT,                -- breakfast|lunch|dinner|snack|null
  note        TEXT,
  created_at  TEXT NOT NULL,
  deleted_at  TEXT                 -- soft delete; corpus rows are never hard-deleted
);

CREATE TABLE photos (
  id               TEXT PRIMARY KEY,
  meal_id          TEXT NOT NULL REFERENCES meals(id),
  position         INTEGER NOT NULL,  -- order within the meal
  original_key     TEXT NOT NULL,     -- R2 key; kept after roll-off for reference
  original_mime    TEXT NOT NULL,
  original_bytes   INTEGER NOT NULL,
  original_sha256  TEXT NOT NULL,     -- computed on device, verified by Worker
  original_status  TEXT NOT NULL DEFAULT 'r2',  -- 'r2' | 'archived_local'
  archived_at      TEXT,
  display_key      TEXT NOT NULL,
  display_bytes    INTEGER NOT NULL,
  width            INTEGER,
  height           INTEGER
);

CREATE TABLE batches (
  id              TEXT PRIMARY KEY,
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

```
originals/YYYY/MM/<photo_id>.<ext>   # bytes exactly as captured, EXIF intact
display/YYYY/MM/<photo_id>.jpg       # long edge 1600 px, JPEG q≈0.8, EXIF stripped
```

The year and month come from `taken_at`, so roll-off can select by prefix. Original bytes are
never re-encoded. The display copy is what gets exported to the chatbot. Vision models
downscale large images to roughly this size anyway, and it keeps uploads small.

## 6. Prompt and reply contract

> **Tier:** Contract · **Verified:** 2026-10-17 · **Expires:** 2027-04-17
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

{for each meal}
[{key}] {weekday} {YYYY-MM-DD} {HH:MM} · {meal_type or "meal"} · photos: {filenames}
Note: {note or "—"}
{end}

For each meal, identify the foods, estimate portions, and estimate nutrition.
Use my notes when they clarify something the photo can't show (e.g. "half eaten",
"oil-free"). If a photo is unusable, mark that meal skipped and say why.

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
        { "name": "dal tadka", "portion": "1 bowl", "grams": 250,
          "kcal": 280, "protein_g": 14, "carbs_g": 36, "fat_g": 9, "fiber_g": 8 }
      ],
      "totals": { "kcal": 280, "protein_g": 14, "carbs_g": 36, "fat_g": 9, "fiber_g": 8 },
      "confidence": "medium",
      "observations": "Looks like ~1 tsp ghee on top.",
      "questions": ["Was the rice white or brown?"]
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
- Totals that differ from the sum of the items by more than 10% produce a warning, not an error.
- Skipped meals are stored as analyses with `skipped: true` but **remain pending**, so
  they show up in the next export.

## 7. Capture and upload details

> **Tier:** Plan · **Verified:** 2026-10-17 · **Expires:** 2027-01-17

- Use `<input type="file" accept="image/*" capture="environment" multiple>`. iOS may give
  JPEG or HEIC depending on its settings. Store whatever arrives, and record its MIME type.
- On the device: read the EXIF `DateTimeOriginal`, compute the SHA-256 of the original,
  and render the display copy on a canvas. A HEIC original that the canvas can't decode
  needs a fallback (for example, also accepting the camera's JPEG output). **Test this on a
  real iPhone first.**
- Queue the meal and its blobs in IndexedDB. Upload when online and retry with backoff.
  The Worker re-hashes the original and rejects a mismatch. Only after the server
  acknowledges the upload is the local copy cleared.
- iOS can evict PWA storage, which is why the queue is only temporary and R2 is the source of truth.

## 8. Roll-off of originals

> **Tier:** Plan · **Verified:** 2026-10-17 · **Expires:** 2027-01-17

The roll-off is a script that runs on the laptop: `scripts/rolloff --older-than 12m --dest /path/to/archive`.

1. `GET /api/admin/rolloff-candidates?before=<date>` returns the photo IDs, R2 keys and
   SHA-256s where `original_status = 'r2'`.
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

- **Frontend:** TypeScript, Vite, Preact, with a service worker for the app shell and an
  installable manifest.
- **Backend:** a single Cloudflare Worker that serves the static assets and the `/api/*`
  routes (Hono), with D1 and R2 bindings. It is deployed with Wrangler.
- **Auth:** Cloudflare Access (free Zero Trust plan) protects the whole hostname, with an
  email one-time PIN and a long session. The Worker also verifies the
  `Cf-Access-Jwt-Assertion` header. The admin API uses an Access service token for the
  laptop script.
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

> **Tier:** Plan · **Verified:** 2026-10-17 · **Expires:** 2027-01-17

1. **Capture** (the home screen): a big camera button, the queue status, and today's meals.
2. **Timeline:** meals by day, with thumbnails and a badge for pending, in-batch or analyzed.
3. **Meal detail:** the photos, note, every analysis (by model and date), and corrections.
4. **Export:** select meals, then share or copy, or use "Run via API" when a key is
   configured. The batch is created at this step.
5. **Import:** pick the open batch, paste the reply, pick the model, then validate and save.
6. **Settings:** storage usage, the default model name, and abandoning stale open batches.

## 11. Build order

> **Tier:** Plan · **Verified:** 2026-10-17 · **Expires:** 2027-01-17

1. A Worker with D1 and R2 that serves a "hello" PWA behind Access, deployed. *Deployed at
   bitebook.mishabhi.workers.dev; waiting on the Access setup (README).*
2. Capture → queue → upload, verified on the iPhone (HEIC, offline, eviction).
3. Timeline and meal detail.
4. Export: batch creation, the prompt, and the share/copy handoff.
5. Import: validation and storage.
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
- **Cloudflare Access in a home-screen PWA.** We need to check that the Access login
  works inside the standalone PWA on iOS, and decide how long a session should last.
- **Meal grouping.** Should photos taken within N minutes of each other merge into one
  meal automatically, or is it always manual?
