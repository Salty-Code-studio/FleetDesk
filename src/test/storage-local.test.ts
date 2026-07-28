import { describe, it, expect, afterAll } from "vitest";
import { rm } from "node:fs/promises";
import path from "node:path";
import { putObject, getObject, deleteObject, getSignedUrl, assertSafeKey, contentTypeForKey } from "@/lib/storage";
import { signLocalUrl, verifyLocalSignature } from "@/lib/storage/local";

afterAll(async () => {
  await rm(path.resolve(process.cwd(), ".dev-storage"), { recursive: true, force: true });
});

describe("local storage driver", () => {
  it("round-trips putObject -> getObject with the right content type", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await putObject("inspections/test-booking/pickup/a.jpg", bytes, "image/jpeg");
    const got = await getObject("inspections/test-booking/pickup/a.jpg");
    expect(Array.from(got.data)).toEqual([1, 2, 3, 4]);
    expect(got.contentType).toBe("image/jpeg");
  });

  it("deleteObject removes the file and a re-read rejects", async () => {
    await putObject("contracts/gone.pdf", new Uint8Array([9]), "application/pdf");
    await deleteObject("contracts/gone.pdf");
    await expect(getObject("contracts/gone.pdf")).rejects.toThrow();
  });

  it("rejects traversal and malformed keys before any filesystem access", () => {
    expect(() => assertSafeKey("../etc/passwd")).toThrow();
    expect(() => assertSafeKey("a/../b.jpg")).toThrow();
    expect(() => assertSafeKey("/absolute.jpg")).toThrow();
    expect(() => assertSafeKey("a//b.jpg")).toThrow();
    expect(() => assertSafeKey("ok folder/x.jpg")).toThrow(); // no spaces
    expect(() => assertSafeKey("inspections/b1/pickup/x.jpg")).not.toThrow();
  });

  it("maps content types from extensions", () => {
    expect(contentTypeForKey("a/b.jpg")).toBe("image/jpeg");
    expect(contentTypeForKey("a/b.png")).toBe("image/png");
    expect(contentTypeForKey("a/b.webp")).toBe("image/webp");
    expect(contentTypeForKey("a/b.pdf")).toBe("application/pdf");
    expect(contentTypeForKey("a/b.bin")).toBe("application/octet-stream");
  });

  it("signed local URLs verify, bind to the key, and expire", () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const sig = signLocalUrl("k.jpg", exp);
    expect(verifyLocalSignature("k.jpg", exp, sig)).toBe(true);
    expect(verifyLocalSignature("other.jpg", exp, sig)).toBe(false);
    const past = Math.floor(Date.now() / 1000) - 120;
    expect(verifyLocalSignature("k.jpg", past, signLocalUrl("k.jpg", past))).toBe(false);
  });

  it("getSignedUrl points at the dev route with exp and sig params", async () => {
    const url = await getSignedUrl("contracts/x.pdf", 60);
    const u = new URL(url);
    expect(u.pathname).toBe("/api/dev/storage/contracts/x.pdf");
    expect(Number(u.searchParams.get("exp"))).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(u.searchParams.get("sig")).toMatch(/^[0-9a-f]{64}$/);
  });
});
