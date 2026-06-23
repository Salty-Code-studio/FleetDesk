import { describe, it, expect } from "vitest";
import { encryptField, decryptField } from "@/lib/crypto/fields";

const AAD = "driver_licenses:test-booking-id:license_number";

describe("field encryption (AES-256-GCM with AAD binding)", () => {
  it("roundtrips a license number", () => {
    const stored = encryptField("AUA-1234567", AAD);
    expect(decryptField(stored, AAD)).toBe("AUA-1234567");
  });

  it("roundtrips unicode and empty strings", () => {
    expect(decryptField(encryptField("", AAD), AAD)).toBe("");
    expect(decryptField(encryptField("Børge Ñandú 1990-05-17", AAD), AAD)).toBe("Børge Ñandú 1990-05-17");
  });

  it("produces a different ciphertext every time (random IV)", () => {
    const a = encryptField("same-plaintext", AAD);
    const b = encryptField("same-plaintext", AAD);
    expect(a.equals(b)).toBe(false);
  });

  it("rejects decryption under a different row/column context (swap protection)", () => {
    const stored = encryptField("AUA-1234567", AAD);
    expect(() => decryptField(stored, "driver_licenses:other-booking:license_number")).toThrow();
    expect(() => decryptField(stored, "driver_licenses:test-booking-id:dob")).toThrow();
  });

  it("requires a non-empty AAD context", () => {
    expect(() => encryptField("x", "")).toThrow(/aad/i);
    expect(() => decryptField(encryptField("x", AAD), "")).toThrow(/aad/i);
  });

  it("rejects a tampered ciphertext byte", () => {
    const stored = encryptField("AUA-1234567", AAD);
    stored[stored.length - 1] = stored[stored.length - 1]! ^ 0xff;
    expect(() => decryptField(stored, AAD)).toThrow();
  });

  it("rejects a tampered auth tag", () => {
    const stored = encryptField("AUA-1234567", AAD);
    stored[1 + 12] = stored[1 + 12]! ^ 0xff; // first tag byte
    expect(() => decryptField(stored, AAD)).toThrow();
  });

  it("rejects an unknown version", () => {
    const stored = encryptField("AUA-1234567", AAD);
    stored[0] = 9;
    expect(() => decryptField(stored, AAD)).toThrow(/version/i);
  });
});
