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
src/worker/   Cloudflare Worker: /api/* routes, Access JWT check
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

```sh
npm run deploy   # needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
```

Live at https://bitebook.mishabhi.workers.dev.

## Cloudflare Access (one-time setup)

Until this is done, every `/api` request returns `503 access_not_configured`. That's
deliberate, so the API is never exposed without sign-in.

1. Cloudflare dashboard → **Zero Trust**. If asked, pick a team name and the **Free** plan.
2. **Workers & Pages → bitebook → Settings → Domains & Routes → workers.dev**, then turn on
   **Cloudflare Access**. This creates an Access application for the URL.
3. Open that application's policy and make sure it allows **only your email**. Set the
   session duration to something long (e.g. 1 month) so the home-screen app rarely
   asks you to sign in.
4. Copy the **Audience (AUD) tag** and your **team domain** (`<team>.cloudflareaccess.com`)
   into `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN` in `wrangler.jsonc`, then redeploy.
