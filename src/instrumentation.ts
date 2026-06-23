/**
 * Next.js instrumentation hook (runs once at server startup, Node runtime).
 *
 * Used here for:
 *   1. Validating the environment at process start (defense-in-depth: the
 *      predev/prebuild scripts also do this, but importing `@/env` here ensures
 *      the running server has validated config even if started directly).
 *   2. GRACEFUL SHUTDOWN: on SIGTERM/SIGINT we stop accepting work and exit
 *      cleanly, giving in-flight requests a bounded window to finish. This is
 *      what a container orchestrator (Docker/K8s) sends on stop/scale-down.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Validate config at boot (throws -> process exits non-zero, fail-closed).
  await import("@/env");
  const { logger } = await import("@/lib/logger");

  logger.info("server_starting", { pid: process.pid });

  let shuttingDown = false;
  const SHUTDOWN_TIMEOUT_MS = 10_000;

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("server_shutdown_initiated", { signal });

    // Force-exit if cleanup hangs, so we never block the orchestrator forever.
    const force = setTimeout(() => {
      logger.warn("server_shutdown_forced");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    // Don't let the timer itself keep the event loop alive.
    force.unref();

    // Release the database pool before exiting (postgres-js holds idle sockets).
    // The closer is published on globalThis by src/lib/db/client.ts because
    // importing that module here would pull the db drivers into the
    // instrumentation bundle (where node built-ins like `net` don't resolve).
    const closeDb = (globalThis as Record<string, unknown>).__texCloseDb as
      | (() => Promise<void>)
      | undefined;
    void Promise.resolve(closeDb?.())
      .catch(() => undefined)
      .then(() => {
        logger.info("server_shutdown_complete", { signal });
        clearTimeout(force);
        process.exit(0);
      });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Never crash silently; log unexpected failures (then let the platform restart).
  process.on("unhandledRejection", (reason) => {
    logger.error("unhandled_rejection", { error: reason });
  });
  process.on("uncaughtException", (err) => {
    logger.error("uncaught_exception", { error: err });
    // An uncaught exception leaves the process in an unknown state — exit so the
    // orchestrator can replace it with a clean instance (fail fast/closed).
    process.exit(1);
  });
}
