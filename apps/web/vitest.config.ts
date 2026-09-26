import { defineConfig } from "vitest/config";

/** Web unit tests (pure glue: message conversion, replay timing). Run: npx vitest run --config apps/web/vitest.config.ts */
export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
