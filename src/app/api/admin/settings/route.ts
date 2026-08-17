import { env } from "@/env";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseJsonBody } from "@/lib/http/validate";
import { read, mutate } from "@/lib/admin/guard";
import { getSettings, patchSettings, SettingsPatchSchema } from "@/lib/admin/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The settings page's "Booking approvals" card needs to build each manager's
// Telegram invite link (t.me/<bot>?start=<code>) and show whether the bot is
// even configured, so the flat settings row is extended with two read-only,
// env-derived fields here rather than stored in the table itself.
export const GET = withRoute(async (req) =>
  json(
    await read(req, async () => {
      const current = await getSettings();
      return {
        ...current,
        telegramBotUsername: env.TELEGRAM_BOT_USERNAME,
        telegramConfigured: Boolean(env.TELEGRAM_BOT_TOKEN),
      };
    }),
    req,
  ),
);

export const PATCH = withRoute(async (req) => {
  const patch = await parseJsonBody(req, SettingsPatchSchema);
  const updated = await mutate(req, "admin.settings_updated", async () => {
    const before = await getSettings();
    const after = await patchSettings(patch);
    return { result: after, entity: "settings", entityId: "1", before, after };
  });
  return json(updated, req);
});
