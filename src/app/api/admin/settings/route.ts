import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseJsonBody } from "@/lib/http/validate";
import { read, mutate } from "@/lib/admin/guard";
import { getSettings, patchSettings, SettingsPatchSchema } from "@/lib/admin/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withRoute(async (req) => json(await read(req, getSettings), req));

export const PATCH = withRoute(async (req) => {
  const patch = await parseJsonBody(req, SettingsPatchSchema);
  const updated = await mutate(req, "admin.settings_updated", async () => {
    const before = await getSettings();
    const after = await patchSettings(patch);
    return { result: after, entity: "settings", entityId: "1", before, after };
  });
  return json(updated, req);
});
