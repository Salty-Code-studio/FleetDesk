import { describe, it, expect } from "vitest";
import { ageOn, validateLicense, encryptLicense, LicenseSchema, driverAgeBand } from "@/lib/booking/license";
import { decryptField } from "@/lib/crypto/fields";

const valid = {
  nameOnLicense: "Jane Driver",
  licenseNumber: "AUA-1234567",
  issuingCountry: "Aruba",
  issueDate: "2020-01-01",
  expiryDate: "2030-01-01",
  dob: "2000-05-17",
};
const ctx = { minDriverAge: 21, rentalStart: "2026-07-01", rentalEnd: "2026-07-08" };

describe("ageOn", () => {
  it("computes whole years, accounting for birthday not yet reached", () => {
    expect(ageOn("2000-05-17", "2026-07-01")).toBe(26);
    expect(ageOn("2000-05-17", "2026-05-16")).toBe(25); // day before 26th birthday
    expect(ageOn("2000-05-17", "2026-05-17")).toBe(26); // on the birthday
  });
});

describe("validateLicense", () => {
  it("accepts a valid licence", () => {
    expect(() => validateLicense(valid, ctx)).not.toThrow();
  });
  it("rejects an under-age driver at pick-up", () => {
    expect(() => validateLicense({ ...valid, dob: "2010-01-01" }, ctx)).toThrow(/at least 21/i);
  });
  it("passes exactly at the minimum age", () => {
    // turns 21 the day before pick-up
    expect(() => validateLicense({ ...valid, dob: "2005-06-30" }, ctx)).not.toThrow();
  });
  it("rejects a licence that expires on or before the return date", () => {
    expect(() => validateLicense({ ...valid, expiryDate: "2026-07-08" }, ctx)).toThrow(/valid through/i);
    expect(() => validateLicense({ ...valid, expiryDate: "2026-07-05" }, ctx)).toThrow(/valid through/i);
  });
  it("rejects issue date not before expiry", () => {
    expect(() => validateLicense({ ...valid, issueDate: "2030-01-01", expiryDate: "2030-01-01" }, ctx)).toThrow(/before its expiry/i);
  });
  it("schema rejects malformed dates and empty fields", () => {
    expect(LicenseSchema.safeParse({ ...valid, dob: "17-05-2000" }).success).toBe(false);
    expect(LicenseSchema.safeParse({ ...valid, licenseNumber: "" }).success).toBe(false);
  });
});

describe("encryptLicense", () => {
  it("encrypts number and DOB, leaves them decryptable with the bound context", () => {
    const cols = encryptLicense("booking-xyz", valid);
    expect(cols.nameOnLicense).toBe("Jane Driver");
    expect(Buffer.isBuffer(cols.licenseNumberEnc)).toBe(true);
    expect(decryptField(cols.licenseNumberEnc, "driver_licenses:booking-xyz:license_number")).toBe("AUA-1234567");
    expect(decryptField(cols.dobEnc, "driver_licenses:booking-xyz:dob")).toBe("2000-05-17");
    // wrong context fails (swap protection)
    expect(() => decryptField(cols.licenseNumberEnc, "driver_licenses:other:license_number")).toThrow();
  });
});

describe("driverAgeBand", () => {
  const s = { minDriverAge: 18, youngDriverAge: 21 };
  it("classifies under the minimum age", () => {
    expect(driverAgeBand("2010-01-01", "2026-07-01", s)).toBe("under_min");
    expect(driverAgeBand("2008-07-02", "2026-07-01", s)).toBe("under_min"); // 18th birthday one day after pick-up
  });
  it("classifies the young band, boundaries included", () => {
    expect(driverAgeBand("2008-07-01", "2026-07-01", s)).toBe("young"); // turns 18 on pick-up day
    expect(driverAgeBand("2005-07-02", "2026-07-01", s)).toBe("young"); // 20, turns 21 one day after pick-up
  });
  it("classifies standard at and above youngDriverAge", () => {
    expect(driverAgeBand("2005-07-01", "2026-07-01", s)).toBe("standard"); // turns 21 on pick-up day
    expect(driverAgeBand("1990-01-01", "2026-07-01", s)).toBe("standard");
  });
  it("an empty young band (youngDriverAge at or below minDriverAge) never returns young", () => {
    const flat = { minDriverAge: 21, youngDriverAge: 21 };
    expect(driverAgeBand("2007-01-01", "2026-07-01", flat)).toBe("under_min");
    expect(driverAgeBand("2000-01-01", "2026-07-01", flat)).toBe("standard");
  });
});
