# Bitebook

A personal meal-photo log. Snap a photo when you sit down to eat, and every day or two
export the unanalyzed meals to a chatbot. Then paste its JSON reply back in. Photos stay
out of your camera roll and build up into a dataset you can reuse.

Built on Cloudflare (Workers, D1, R2), within the free tier.

- [`docs/SPEC.md`](docs/SPEC.md): what we're building. Each section is marked with how long it can be trusted.
- [`docs/decisions.md`](docs/decisions.md): why it's built this way.
- [`CLAUDE.md`](CLAUDE.md): rules for keeping the docs honest as the app evolves.
