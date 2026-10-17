# Bitebook

A personal meal-photo log. Snap a photo when you sit down to eat, and every day or two
export the unanalyzed meals to a chatbot. Then paste its JSON reply back in. Photos stay
out of your camera roll and build up into a dataset you can reuse.

Built on Cloudflare (Workers, D1, R2), within the free tier.

- [`docs/SPEC.md`](docs/SPEC.md): what we're building. Each section is marked with how long it can be trusted.
- [`docs/decisions.md`](docs/decisions.md): why it's built this way.
- [`CLAUDE.md`](CLAUDE.md): rules for keeping the docs honest as the app evolves.

## Layout

```
src/app/      PWA frontend (Preact)
src/worker/   Cloudflare Worker: /api/* routes, sign-in (Access or Google)
public/       manifest, service worker, icons
wrangler.jsonc  Worker config: D1 (bitebook-db), R2 (bitebook-photos)
```

## Develop

```sh
npm install
cp .dev.vars.example .dev.vars   # disables the Access check locally only
npm run dev                      # local D1/R2 emulation, no cloud data touched
npm run typecheck
```

## Deploy

Two sign-in modes are on trial (see `docs/decisions.md`, D7). The same code deploys twice
and both copies share the database and photo bucket:

| URL | Sign-in | Deploy |
|---|---|---|
| https://bitebook.mishabhi.workers.dev | Cloudflare Access | `npm run deploy` |
| https://bitebook-google.mishabhi.workers.dev | Google, handled by the Worker | `npm run deploy:google` |

Both need `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Until a mode is set up,
every `/api` request returns `503 auth_not_configured`. That's deliberate, so the API is
never exposed without sign-in.

## Cloudflare Access setup (for `bitebook`)

1. Cloudflare dashboard → **Zero Trust**. If asked, pick a team name and the **Free** plan.
2. **Workers & Pages → bitebook → Settings → Domains & Routes → workers.dev**, then turn on
   **Cloudflare Access**. This creates an Access application for the URL.
3. Optionally, add **Google** as a login method (Zero Trust → Settings → Authentication),
   so Access signs you in with Google instead of emailing you a code.
4. Open that application's policy and make sure it allows **only your email**. Set the
   session duration to something long (e.g. 1 month) so the home-screen app rarely
   asks you to sign in.
5. Copy the **Audience (AUD) tag** and your **team domain** (`<team>.cloudflareaccess.com`)
   into `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN` in `wrangler.jsonc`, then redeploy.

## Google sign-in setup (for `bitebook-google`)

1. In [Google Cloud Console](https://console.cloud.google.com/), create or pick a project,
   then go to **APIs & Services → OAuth consent screen**. Choose **External**, leave it
   in **Testing**, and add your Gmail address as a **test user**. That way only you can sign in.
2. **APIs & Services → Credentials → Create credentials → OAuth client ID**, type **Web
   application**. Add this as an **authorized redirect URI**:
   `https://bitebook-google.mishabhi.workers.dev/auth/callback`
3. Put the **client ID** in `env.google.vars.GOOGLE_CLIENT_ID` in `wrangler.jsonc`, and store
   the **client secret** with `npx wrangler secret put GOOGLE_CLIENT_SECRET --env google`.
   `SESSION_SECRET` is already set.
4. `npm run deploy:google`.

Sign-in only asks for `openid email`. The Worker keeps no Google tokens. It issues its own
90-day session cookie, and only emails in `ALLOWED_EMAILS` get one.
