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
src/app/        PWA frontend (Preact)
src/worker/     Cloudflare Worker: /api/* routes, Google sign-in under /auth/*
migrations/     D1 schema migrations
public/         manifest, service worker, icons
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

## Deploy

```sh
npm run migrate   # apply new migrations to the real D1 first
npm run deploy    # needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
```

Until Google sign-in is configured, every `/api` request returns `503 auth_not_configured`.
That's deliberate, so the API is never exposed without sign-in.

## Google sign-in setup (one-time)

1. In [Google Cloud Console](https://console.cloud.google.com/), create or pick a project,
   then go to **APIs & Services → OAuth consent screen**. Choose **External**, leave it
   in **Testing**, and add your Gmail address as a **test user**.
2. **APIs & Services → Credentials → Create credentials → OAuth client ID**, type **Web
   application**. Add this as an **authorized redirect URI**:
   `https://bitebook.mishabhi.workers.dev/auth/callback`
3. Put the **client ID** in `vars.GOOGLE_CLIENT_ID` in `wrangler.jsonc`, and store the
   **client secret** with `npx wrangler secret put GOOGLE_CLIENT_SECRET`.
   `SESSION_SECRET` is already set.
4. `npm run deploy`.

Sign-in only asks for `openid email`. The Worker keeps no Google tokens. It creates a
user record on first sign-in and issues its own 90-day session cookie. Only emails in
`ALLOWED_EMAILS` (in `wrangler.jsonc`) can sign in. To let someone else in, add their
email there and, while the consent screen is in Testing, as a test user too.

## Data ownership

Every D1 row has a `user_id`, and every photo lives under `users/<user_id>/` in R2. Every
query must filter on the signed-in user's id (`c.get("user").id`). Whoever owns the
Cloudflare account can see all stored data.
