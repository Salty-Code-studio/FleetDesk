import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseJsonBody } from "@/lib/http/validate";
import { read, mutate } from "@/lib/admin/guard";
import { listStaff, createStaff } from "@/lib/admin/staff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/staff — owner-only staff roster (default deny keeps staff out). */
export const GET = withRoute(async (req) =>
  json({ staff: await read(req, () => listStaff()) }, req),
);

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
}).strict();

/** POST /api/admin/staff — create a staff member. The 6-digit code is returned
 *  ONCE in this response and never stored in plaintext or audit-logged. */
export const POST = withRoute(async (req) => {
  const body = await parseJsonBody(req, CreateSchema);
  const created = await mutate(req, "admin.staff_created", async () => {
    const staff = await createStaff(body.name);
    return {
      result: staff, entity: "admin_user", entityId: staff.id,
      after: { name: staff.name, role: "staff" }, // NEVER the code
    };
  });
  return json(created, req, { status: 201 });
});
