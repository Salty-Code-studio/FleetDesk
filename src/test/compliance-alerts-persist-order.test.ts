/**
 * Regression: runComplianceAlerts must PERSIST the new alert stage marker
 * before dispatching notifyAdmin/alertOwner, not after.
 *
 * The old order (notify, then persist) leaves a window where the alert has
 * already gone out but the DB stage still shows the stale value. A crash in
 * that window (process kill, serverless timeout, transient DB error on the
 * write) means the marker never advances, so the very next cron run sees
 * `target > recorded` again and fires (and sends) the SAME stage a second
 * time -- the operator gets duplicate "insurance overdue" pings for one
 * event. Persist-then-notify closes that window: once the write commits, a
 * crash can only ever skip the notification, never duplicate it.
 *
 * This is proven here by inspecting the DB row from WITHIN a mocked
 * notifyAdmin/alertOwner call: by the time either dispatch fires, the stage
 * column must already equal the new target stage, not the value it replaced.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles } from "@/lib/db/schema";

const notifyAdmin = vi.fn(async (...args: unknown[]) => { void args; });
const alertOwner = vi.fn(async (...args: unknown[]) => { void args; });
vi.mock("@/lib/notify", () => ({
  notifyAdmin: (...args: unknown[]) => notifyAdmin(...args),
  alertOwner: (...args: unknown[]) => alertOwner(...args),
  sendOwnerWhatsApp: vi.fn(async () => {}),
}));

import { runComplianceAlerts } from "@/lib/admin/compliance";

let db: Awaited<ReturnType<typeof getDb>>;

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
});

describe("runComplianceAlerts persists the stage marker before dispatching", () => {
  it("the DB stage already reflects the new (target) value when notifyAdmin/alertOwner run", async () => {
    const NOW = new Date("2027-06-01T12:00:00-04:00"); // 20 days before 2027-06-21 -> target stage 1
    const [v] = await db.insert(vehicles).values({
      slug: "comp-order-car", plate: "PL-ORDER-1", class: "SUV", name: "Order Car", seats: 5,
      transmission: "Automatic", doors: 5, priceDayCents: 1, priceWeekCents: 1, priceMonthCents: 1,
      insuranceExpiresOn: "2027-06-21",
    }).returning();

    const readStage = async () => {
      const [row] = await db.select().from(vehicles).where(eq(vehicles.id, v!.id));
      return row!.insuranceAlertStage;
    };

    let stageAtNotifyTime: number | null = null;
    let stageAtAlertTime: number | null = null;
    notifyAdmin.mockImplementationOnce(async () => { stageAtNotifyTime = await readStage(); });
    alertOwner.mockImplementationOnce(async () => { stageAtAlertTime = await readStage(); });

    const before = await readStage();
    expect(before).toBe(0);

    const r = await runComplianceAlerts(NOW);
    expect(r.fired).toBeGreaterThanOrEqual(1);
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    expect(alertOwner).toHaveBeenCalledTimes(1);

    // The bug: these would still read 0 (the stale stage) because the old
    // code dispatched BEFORE writing the new stage.
    expect(stageAtNotifyTime).toBe(1);
    expect(stageAtAlertTime).toBe(1);

    // And the persisted value sticks regardless of dispatch outcome.
    expect(await readStage()).toBe(1);
  });

  it("a rerun after dispatch never re-fires the same stage, even if dispatch itself failed", async () => {
    const NOW = new Date("2027-06-01T12:00:00-04:00");
    const [v] = await db.insert(vehicles).values({
      slug: "comp-order-crash", plate: "PL-ORDER-2", class: "SUV", name: "Crash Car", seats: 5,
      transmission: "Automatic", doors: 5, priceDayCents: 1, priceWeekCents: 1, priceMonthCents: 1,
      insuranceExpiresOn: "2027-06-21",
    }).returning();

    // Simulate a transient failure in the dispatch step itself (e.g. Resend
    // or the WhatsApp API erroring out). Because dispatch is meant to be
    // best-effort, this must not stop the stage from having already been
    // recorded, and must not cause a rerun to fire (and re-dispatch) again.
    notifyAdmin.mockImplementationOnce(async () => { throw new Error("simulated notify failure"); });

    await expect(runComplianceAlerts(NOW)).rejects.toThrow("simulated notify failure");

    const [row] = await db.select().from(vehicles).where(eq(vehicles.id, v!.id));
    expect(row!.insuranceAlertStage).toBe(1); // already persisted despite the dispatch throwing

    notifyAdmin.mockClear();
    alertOwner.mockClear();
    const rerun = await runComplianceAlerts(NOW);
    expect(rerun.fired).toBe(0); // stage 1 already recorded: no re-fire, no re-dispatch
    expect(notifyAdmin).not.toHaveBeenCalled();
    expect(alertOwner).not.toHaveBeenCalled();
  });
});
