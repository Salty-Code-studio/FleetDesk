import { eq } from "drizzle-orm";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseParams } from "@/lib/http/validate";
import { mutate } from "@/lib/admin/guard";
import { Errors } from "@/lib/http/errors";
import { getDb } from "@/lib/db/client";
import { bookings } from "@/lib/db/schema";
import { putObject } from "@/lib/storage";
import { UploadFieldsSchema, validateUploadFile, buildUploadKey } from "@/lib/storage/uploads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/uploads — multipart upload for check-in/out media.
 * Fields: file (jpeg/png/webp, <= 10MB), category, bookingId, kind?, label?.
 * The client downscales photos before upload (canvas, longest edge ~1600px),
 * so 10MB is a hard backstop, not the normal case. CSRF: the client sends the
 * X-CSRF-Token header alongside the multipart body (never set Content-Type
 * manually — the browser adds the multipart boundary).
 */
export const POST = withRoute(async (req) => {
  const result = await mutate(req, "admin.file_uploaded", async () => {
    const form = await req.formData().catch(() => {
      throw Errors.badRequest("Expected multipart form data");
    });
    const file = form.get("file");
    if (!(file instanceof File)) throw Errors.badRequest("file field is required");
    const fields = parseParams({
      category: form.get("category"),
      bookingId: form.get("bookingId"),
      kind: form.get("kind") ?? undefined,
      label: form.get("label") ?? undefined,
    }, UploadFieldsSchema);
    validateUploadFile(file);

    const db = await getDb();
    const [booking] = await db.select({ id: bookings.id }).from(bookings).where(eq(bookings.id, fields.bookingId));
    if (!booking) throw Errors.notFound("Booking not found");

    const key = buildUploadKey(fields);
    await putObject(key, new Uint8Array(await file.arrayBuffer()), file.type);
    return {
      result: { key },
      entity: "upload",
      entityId: fields.bookingId,
      after: { key, category: fields.category, label: fields.label, bytes: file.size },
    };
  });
  return json(result, req, { status: 201 });
});
