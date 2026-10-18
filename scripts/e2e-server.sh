#!/usr/bin/env bash
# Starts a fresh local Bitebook for the end-to-end tests (playwright.config.ts): its own
# empty database in .wrangler/e2e-state, sign-in disabled (localhost only), port 4310.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf .wrangler/e2e-state
npx wrangler d1 migrations apply bitebook-db --local --persist-to .wrangler/e2e-state > /dev/null
BITEBOOK_E2E=1 npx vite build > /dev/null
exec env BITEBOOK_E2E=1 npx vite preview --port 4310 --strictPort
