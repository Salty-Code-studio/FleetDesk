/**
 * Telegram account linking. Adding a manager in settings generates an invite
 * code; the manager taps t.me/<bot>?start=<code> and the /start handler here
 * binds their chat id. Managers with a chatId are BOTH the ping recipients and
 * the inbound allowlist.
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { settings, type ApprovalManager } from "@/lib/db/schema";
import { getSettings } from "@/lib/admin/settings";

export async function linkManagerChat(code: string, chatId: string): Promise<ApprovalManager | null> {
  if (!code) return null;
  const db = await getDb();
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(settings).where(eq(settings.id, 1)).for("update");
    if (!row) return null;
    const managers = row.approvalManagers;
    const idx = managers.findIndex((m) => m.inviteCode === code);
    if (idx === -1) return null;
    const next = managers.map((m, i) => (i === idx ? { ...m, chatId } : m));
    await tx.update(settings).set({ approvalManagers: next, updatedAt: new Date() }).where(eq(settings.id, 1));
    return next[idx]!;
  });
}

export async function managerByChatId(chatId: string): Promise<ApprovalManager | null> {
  const s = await getSettings();
  return s.approvalManagers.find((m) => m.chatId === chatId) ?? null;
}
