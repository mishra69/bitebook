import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

// The cloud sandbox ships Chromium here; elsewhere Playwright uses its own download.
const sandboxChromium = "/opt/pw-browsers/chromium";

export default defineConfig({
  testDir: "tests/e2e",
  workers: 1, // one shared local database
  timeout: 60_000,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:4310",
    timezoneId: "America/Chicago",
    viewport: { width: 390, height: 844 },
    launchOptions: existsSync(sandboxChromium) ? { executablePath: sandboxChromium } : {},
  },
  webServer: {
    command: "scripts/e2e-server.sh",
    url: "http://localhost:4310/version.json",
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: process.env.E2E_SERVER_LOG ? "pipe" : "ignore",
  },
});
