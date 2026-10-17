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
