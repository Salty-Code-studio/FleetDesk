import { describe, it, expect, beforeAll } from "vitest";
import { runMigrations } from "@/lib/db/migrate";
import { notifyAdmin } from "@/lib/notify";
import { listNotifications, markNotificationsRead } from "@/lib/admin/notifications-feed";

describe("in-app notification feed", () => {
  beforeAll(async () => { await runMigrations(); });

  it("records, counts unread newest-first, and marks read", async () => {
    await notifyAdmin({ level: "success", type: "test.a", title: "Test A", body: "a" });
    await notifyAdmin({ level: "warning", type: "test.b", title: "Test B" });

    // Clear the slate (no other suite writes notifications, but stay robust).
    await markNotificationsRead();
    expect((await listNotifications(50)).unread).toBe(0);

    await notifyAdmin({ level: "info", type: "test.c", title: "Test C", body: "fresh" });
    const feed = await listNotifications(50);
    expect(feed.unread).toBe(1);
    expect(feed.notifications[0]!.title).toBe("Test C"); // newest first
    expect(feed.notifications[0]!.readAt).toBeNull();

    const r = await markNotificationsRead([feed.notifications[0]!.id]);
    expect(r.marked).toBe(1);
    expect((await listNotifications(50)).unread).toBe(0);
  });

  it("notifyAdmin is best-effort (resolves void, never throws)", async () => {
    await expect(notifyAdmin({ type: "test.void", title: "Void" })).resolves.toBeUndefined();
  });
});
