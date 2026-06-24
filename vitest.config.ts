import { defineConfig } from "vitest/config";

/**
 * Scope the project test suite to our own `src/` modules. The vendored SDK
 * (`vendor/trading-sdk`) ships its own vitest suite; running it here would be
 * slow and is not this project's responsibility — it's pinned and verified
 * upstream. `npm run setup` builds it; we depend on its `dist/`.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["vendor/**", "node_modules/**"],
  },
});
