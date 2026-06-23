import { describe, it, expect } from "vitest";

describe("stripe env", () => {
  it("exposes validated stripe keys", async () => {
    const { env } = await import("@/env");
    expect(env.STRIPE_SECRET_KEY).toMatch(/^sk_test_/);
    expect(env.STRIPE_WEBHOOK_SECRET).toMatch(/^whsec_/);
  });
});
