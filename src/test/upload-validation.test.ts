import { describe, it, expect } from "vitest";
import { validateUploadFile, buildUploadKey, MAX_UPLOAD_BYTES, UploadFieldsSchema } from "@/lib/storage/uploads";

const BOOKING = "0b6f37cc-9db1-4a10-a1d8-6f8f6f0f2a11";

describe("upload validation", () => {
  it("accepts a normal jpeg", () => {
    expect(() => validateUploadFile({ size: 500_000, type: "image/jpeg" })).not.toThrow();
  });

  it("rejects empty, oversized, and wrong-type files", () => {
    expect(() => validateUploadFile({ size: 0, type: "image/jpeg" })).toThrow(/empty/i);
    expect(() => validateUploadFile({ size: MAX_UPLOAD_BYTES + 1, type: "image/jpeg" })).toThrow(/10 MB/);
    expect(() => validateUploadFile({ size: 1000, type: "application/pdf" })).toThrow(/JPEG, PNG, or WebP/);
    expect(() => validateUploadFile({ size: 1000, type: "image/gif" })).toThrow(/JPEG, PNG, or WebP/);
  });

  it("builds seams-format keys per category", () => {
    const insp = buildUploadKey({ category: "inspection", bookingId: BOOKING, kind: "pickup", label: "" });
    expect(insp).toMatch(new RegExp(`^inspections/${BOOKING}/pickup/[0-9a-f-]{36}\\.jpg$`));
    const lic = buildUploadKey({ category: "license", bookingId: BOOKING, label: "" });
    expect(lic).toMatch(new RegExp(`^licenses/${BOOKING}/[0-9a-f-]{36}\\.jpg$`));
    const sig = buildUploadKey({ category: "signature", bookingId: BOOKING, label: "" });
    expect(sig).toBe(`signatures/${BOOKING}.png`);
  });

  it("requires kind for inspection photos", () => {
    expect(() => buildUploadKey({ category: "inspection", bookingId: BOOKING, label: "" })).toThrow(/kind/);
  });

  it("schema rejects a non-uuid bookingId and an unknown category", () => {
    expect(UploadFieldsSchema.safeParse({ category: "inspection", bookingId: "nope", kind: "pickup" }).success).toBe(false);
    expect(UploadFieldsSchema.safeParse({ category: "weird", bookingId: BOOKING }).success).toBe(false);
    expect(UploadFieldsSchema.safeParse({ category: "license", bookingId: BOOKING }).success).toBe(true);
  });
});
