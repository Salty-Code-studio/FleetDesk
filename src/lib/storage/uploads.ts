/**
 * Upload policy for POST /api/admin/uploads: what may be uploaded, how big,
 * and where it lives in the key space. Key formats are canonical (seams doc):
 *   inspections/{bookingId}/{kind}/{uuid}.jpg
 *   licenses/{bookingId}/{uuid}.jpg
 *   signatures/{bookingId}.png       (deterministic — re-signing overwrites)
 * Contract PDFs are server-generated (never uploaded) at contracts/{bookingId}.pdf.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Errors } from "@/lib/http/errors";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // ~10MB cap (spec W4)

const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export const UploadFieldsSchema = z.object({
  category: z.enum(["inspection", "license", "signature"]),
  bookingId: z.string().uuid(),
  kind: z.enum(["pickup", "return"]).optional(),
  label: z.string().trim().max(120).optional().default(""),
}).strict();

export type UploadFields = z.infer<typeof UploadFieldsSchema>;

export function validateUploadFile(file: { size: number; type: string }): void {
  if (file.size === 0) throw Errors.badRequest("The uploaded file is empty");
  if (file.size > MAX_UPLOAD_BYTES) throw Errors.badRequest("Photos must be under 10 MB");
  if (!ALLOWED_TYPES.has(file.type)) throw Errors.badRequest("Only JPEG, PNG, or WebP images are accepted");
}

export function buildUploadKey(fields: UploadFields): string {
  switch (fields.category) {
    case "inspection":
      if (!fields.kind) throw Errors.badRequest("kind is required for inspection photos");
      return `inspections/${fields.bookingId}/${fields.kind}/${randomUUID()}.jpg`;
    case "license":
      return `licenses/${fields.bookingId}/${randomUUID()}.jpg`;
    case "signature":
      return `signatures/${fields.bookingId}.png`;
  }
}
