import { describe, it, expect, vi } from "vitest";

/**
 * PAYMENT_MODE=desk must boot without any Stripe env (the whole point of desk
 * mode: clients whose country Stripe does not support). PAYMENT_MODE=online
 * (and the default) must still fail closed without Stripe keys.
 * env.ts freezes on first import, so each case re-imports after vi.resetModules().
 */
describe("env PAYMENT_MODE", () => {
  it("desk mode boots with no Stripe keys and exposes isDeskMode", async () => {
    vi.resetModules();
    process.env.PAYMENT_MODE = "desk";
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const mod = await import("@/env");
    expect(mod.env.PAYMENT_MODE).toBe("desk");
    expect(mod.isDeskMode).toBe(true);
    expect(mod.env.STRIPE_SECRET_KEY).toBe("");
  });

  it("online mode still fails closed without Stripe keys", async () => {
    vi.resetModules();
    process.env.PAYMENT_MODE = "online";
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    await expect(import("@/env")).rejects.toThrow(/Environment validation failed/);
  });

  it("default mode is online and accepts the test Stripe keys", async () => {
    vi.resetModules();
    delete process.env.PAYMENT_MODE;
    process.env.STRIPE_SECRET_KEY = "sk_test_0000000000000000000000000000";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_testtesttesttesttesttest00";
    const mod = await import("@/env");
    expect(mod.env.PAYMENT_MODE).toBe("online");
    expect(mod.isDeskMode).toBe(false);
  });
});
