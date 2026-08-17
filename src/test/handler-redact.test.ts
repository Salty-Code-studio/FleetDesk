import { describe, it, expect, beforeAll, vi } from "vitest";
import { logger } from "@/lib/logger";
import { runMigrations } from "@/lib/db/migrate";
import { issueApprovalToken } from "@/lib/approval/tokens";
import { GET as approvalGET } from "@/app/api/approval/[token]/route";
import { GET as bookingConfigGET } from "@/app/api/booking-config/route";

/**
 * withRoute (src/lib/http/handler.ts) logs `path: url.pathname` for every
 * request. GET /api/approval/:token carries a signed, bearer-style decision
 * token in the path itself (uuid.base64url), so an unredacted access log line
 * writes a live approve/decline credential straight into production logs
 * every time someone opens an email review link. The logger's own redaction
 * is key-name based and cannot see inside a path string, so the scrub has to
 * happen before the value reaches logger.* at all.
 *
 * These tests spy directly on the `logger` object's methods. `logger` is a
 * plain exported object literal (src/lib/logger.ts) whose methods are read
 * off the object at each call site (`logger.info(...)`, not a destructured
 * reference), and it is never frozen, so `vi.spyOn(logger, "info")` replaces
 * the live property and every caller that shares the import picks up the
 * spy. That is a more direct seam than spying on console, and it lets us
 * assert on the structured context object instead of parsing JSON lines.
 */

beforeAll(async () => {
  await runMigrations();
});

describe("withRoute path redaction", () => {
  it("never logs the raw approval token embedded in the request path", async () => {
    const token = issueApprovalToken("11111111-1111-1111-1111-111111111111");
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);

    try {
      const req = new Request(`http://localhost:3000/api/approval/${token}`, {
        headers: { "user-agent": "handler-redact-test" },
      });
      // No approval row was seeded for this token, so the route 404s (a
      // format-valid but unknown token is treated the same as garbage) -
      // the point of this test is the access log line withRoute always
      // writes, not the response body.
      const res = await approvalGET(req, { params: Promise.resolve({ token }) });
      expect(res.status).toBe(404);

      const allCalls = [...infoSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls];
      const serialized = JSON.stringify(allCalls);
      expect(serialized).not.toContain(token);

      const requestLog = infoSpy.mock.calls.find(([msg]) => msg === "request");
      expect(requestLog).toBeDefined();
      const loggedPath = (requestLog?.[1] as { path?: string } | undefined)?.path;
      expect(loggedPath).toContain(":token");
    } finally {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("leaves a normal path like /api/booking-config unchanged (no false redaction)", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined);

    try {
      const req = new Request("http://localhost:3000/api/booking-config", {
        headers: { "user-agent": "handler-redact-test" },
      });
      await bookingConfigGET(req, { params: Promise.resolve({}) });

      const requestLog = infoSpy.mock.calls.find(([msg]) => msg === "request");
      expect(requestLog).toBeDefined();
      const loggedPath = (requestLog?.[1] as { path?: string } | undefined)?.path;
      expect(loggedPath).toBe("/api/booking-config");
    } finally {
      infoSpy.mockRestore();
    }
  });
});
