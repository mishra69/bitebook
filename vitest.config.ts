import { defineConfig } from "vitest/config";

// Unit tests for pure logic. No Cloudflare plugin here: these run in plain Node.
export default defineConfig({
  test: { include: ["tests/unit/**/*.test.ts"], environment: "node" },
});
