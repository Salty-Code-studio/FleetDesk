import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Negative-path coverage for the fail-closed env validator. Each case sets ONE
 * bad variable, resets the module registry, and asserts that importing @/env
 * throws. (The happy path is covered by env.test.ts.)
 */

const ORIGINAL = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL);
}

beforeEach(() => vi.resetModules());
afterEach(restoreEnv);

async function expectBootFailure(name: string) {
  // env.ts logs the issues then throws a generic error; assert it throws and
  // keep the console quiet for the expected failure.
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(import("@/env")).rejects.toThrow(/environment validation failed/i);
    const printed = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(printed).toContain(name); // names only, never values
  } finally {
    spy.mockRestore();
  }
}

describe("env validation fails closed", () => {
  it("rejects a placeholder SESSION_SECRET", async () => {
    process.env.SESSION_SECRET = "CHANGE_ME_generate_with_openssl_rand_base64_48________________";
    await expectBootFailure("SESSION_SECRET");
  });

  it("rejects a too-short SESSION_SECRET", async () => {
    process.env.SESSION_SECRET = "short";
    await expectBootFailure("SESSION_SECRET");
  });

  it("rejects a DATA_ENCRYPTION_KEY that does not decode to 32 bytes", async () => {
    process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(16, 7).toString("base64");
    await expectBootFailure("DATA_ENCRYPTION_KEY");
  });

  it("rejects a DATABASE_URL with an unsupported scheme", async () => {
    process.env.DATABASE_URL = "mysql://user:pass@host/db";
    await expectBootFailure("DATABASE_URL");
  });

  it("rejects CORS origins that carry a path", async () => {
    process.env.CORS_ALLOWED_ORIGINS = "http://localhost:3000/app";
    await expectBootFailure("CORS_ALLOWED_ORIGINS");
  });
});
