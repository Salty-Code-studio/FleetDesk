import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["src/test/setup.ts"],
    pool: "forks", // PGlite is single-connection; isolate db state per test file
  },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
});
