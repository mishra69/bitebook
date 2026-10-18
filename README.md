# Bitebook

A personal meal-photo log. Snap a photo when you sit down to eat, and every day or two
export the unanalyzed meals to a chatbot. Then paste its JSON reply back in. Photos stay
out of your camera roll and build up into a dataset you can reuse.

Built on Cloudflare (Workers, D1, R2), within the free tier. Live at
https://bitebook.mishabhi.workers.dev.

- [`docs/SPEC.md`](docs/SPEC.md): what we're building. Each section is marked with how long it can be trusted.
- [`docs/decisions.md`](docs/decisions.md): why it's built this way.
- [`CLAUDE.md`](CLAUDE.md): rules for keeping the docs honest as the app evolves.

## Layout

```
src/app/        PWA frontend (Preact); lib/ has image processing, EXIF, the upload outbox
src/worker/     Cloudflare Worker: /api/* routes (meals.ts), Google sign-in under /auth/*
src/shared/     types and helpers used by both (ULIDs, meal shapes, R2 key layout)
src/sw/sw.js    service worker template (the build stamps the version and file list)
migrations/     D1 schema migrations
public/         manifest, _headers, icons, install prompt
scripts/        icon generator, spec freshness check, e2e server
tests/          unit (Vitest) and e2e (Playwright) tests, with photo fixtures
deploy.sh       stamp-deploy-verify (from the pwa-cloudflare skill), set up in deploy.conf
wrangler.jsonc  Worker config: D1 (bitebook-db), R2 (bitebook-photos)
```

## Develop

```sh
npm install
cp .dev.vars.example .dev.vars   # disables sign-in locally only (you are "dev-user")
npm run migrate:local            # create the schema in the local D1
npm run dev                      # local D1/R2 emulation, no cloud data touched
npm run typecheck
```

## Test

```sh
npm test            # unit tests (Vitest): EXIF, time, storage keys, prompt building
npm run test:e2e    # end-to-end (Playwright) against a fresh local server on :4310
```

The end-to-end run starts its own server (`scripts/e2e-server.sh`), with an empty database
in `.wrangler/e2e-state` and sign-in disabled. The Worker honours that only on localhost.
Set `E2E_SERVER_LOG=1` to see the server's log.

## Deploy

```sh
npm run migrate   # apply new migrations to the real D1 first
npm run deploy    # needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
```

`npm run deploy` picks a version (`YYYYMMDD_HHMM`) and builds with it, which stamps
`sw.js` and writes `/version.json`. It then deploys and waits until that version is
actually being served. The app shows its build at the bottom of the screen and notes
when a newer one is available. After a deploy, the installed app needs **two
relaunches**: the first installs the new service worker, the second runs it.

Until Google sign-in is configured, every `/api` request returns `503 auth_not_configured`.
That's deliberate, so the API is never exposed without sign-in.

## Google sign-in setup (one-time)

Sign-in uses Google's ID-token flow, which needs only a **client ID**, with no secret.

1. In [Google Cloud Console](https://console.cloud.google.com/), in the `bitebook` project,
   go to **APIs & Services → OAuth consent screen**. Choose **External**, leave it in
   **Testing**, and add your Gmail address as a **test user**.
2. **Credentials → OAuth client ID**, type **Web application**. Add these **Authorized
   JavaScript origins**: `https://bitebook.mishabhi.workers.dev`, and for local
   development, `http://localhost` and `http://localhost:5173`. No redirect URI is needed.
3. Put the client ID in `vars.GOOGLE_CLIENT_ID` in `wrangler.jsonc`, and deploy.
   `SESSION_SECRET` is the only secret, and it is already set.

The Worker verifies Google's token, creates a user record (keyed on Google's `sub`) on
first sign-in, and issues its own 90-day session cookie. Only emails in `ALLOWED_EMAILS`
(in `wrangler.jsonc`) can sign in. To let someone else in, add their email there and,
while the consent screen is in Testing, as a test user too.

## Data ownership

Every D1 row has a `user_id`, and every photo lives under `users/<user_id>/` in R2. Every
query must filter on the signed-in user's id (`c.get("user").id`). Whoever owns the
Cloudflare account can see all stored data.
