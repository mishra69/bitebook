import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import preact from "@preact/preset-vite";
import { cloudflare } from "@cloudflare/vite-plugin";

// Set by scripts/deploy.sh; local builds are "dev".
const VERSION = process.env.BITEBOOK_VERSION || "dev";
// End-to-end tests (playwright.config.ts) get their own local database and no sign-in.
const E2E = process.env.BITEBOOK_E2E === "1";

const STATIC_SHELL = [
  "/",
  "/manifest.json",
  "/js/pwa-install.js",
  "/icons/apple-touch-icon.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

// Emits sw.js (version stamped, SHELL = static files + hashed bundle files) and
// version.json, which the app polls to notice it is running an old build.
function serviceWorker(): Plugin {
  return {
    name: "bitebook-sw",
    generateBundle(_, bundle) {
      if (this.environment.name !== "client") return;
      const built = Object.keys(bundle)
        .filter((f) => /\.(js|css)$/.test(f))
        .map((f) => "/" + f);
      const source = readFileSync("src/sw/sw.js", "utf8")
        .replace("const VERSION = 'dev';", `const VERSION = '${VERSION}';`)
        .replace("[/* SHELL */]", JSON.stringify([...STATIC_SHELL, ...built], null, 2));
      this.emitFile({ type: "asset", fileName: "sw.js", source });
      this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ version: VERSION }) });
    },
  };
}

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(VERSION) },
  plugins: [
    preact(),
    cloudflare(
      E2E
        ? { persistState: { path: ".wrangler/e2e-state" }, config: { vars: { AUTH_DISABLED: "1", TRANSCRIBE_STUB: "1", PUSH_STUB: "1", OPENROUTER_STUB: "1" } } }
        : {},
    ),
    serviceWorker(),
  ],
});
