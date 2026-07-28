import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  // tsconfig sets jsx: "preserve" for Next's own SWC transform; vite's oxc
  // transformer under vitest reads that tsconfig setting and leaves JSX
  // untransformed, so import-analysis fails on the first .tsx module a test
  // imports (src/lib/pdf/contract.tsx, @react-pdf/renderer JSX). Override
  // explicitly to the automatic runtime for the test run only.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    environment: "node",
    setupFiles: ["src/test/setup.ts"],
    pool: "forks", // PGlite is single-connection; isolate db state per test file
  },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
});
