/**
 * Boot-time guard: validate environment BEFORE `next dev`/`next build` start.
 *
 * Importing `@/env` triggers the zod validation; if anything is missing/weak it
 * throws and this script exits non-zero, so a misconfigured deployment FAILS the
 * pipeline rather than starting in an insecure state (fail-closed).
 *
 * Run automatically via the `predev`/`prebuild` npm scripts.
 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

async function main(): Promise<void> {
  // Resolve "@/env" manually since this runs outside the Next build's path alias.
  const envModuleUrl = pathToFileURL(resolve(process.cwd(), "src/env.ts")).href;
  await import(envModuleUrl);
  // eslint-disable-next-line no-console
  console.log("[check-env] Environment validation passed.");
}

main().catch((err: unknown) => {
  // The detailed errors are already printed by src/env.ts. Just exit non-zero.
  if (err instanceof Error) {
    // eslint-disable-next-line no-console
    console.error(`[check-env] ${err.message}`);
  }
  process.exit(1);
});
