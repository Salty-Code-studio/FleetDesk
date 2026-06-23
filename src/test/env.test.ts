import { describe, it, expect } from "vitest";

describe("env", () => {
  it("loads a validated environment", async () => {
    const { env } = await import("@/env");
    expect(env.NODE_ENV).toBe("test");
    expect(env.DATABASE_URL).toBe("pglite://memory");
    expect(env.DATA_ENCRYPTION_KEY.length).toBe(32); // decoded bytes, not base64 chars
  });
});
