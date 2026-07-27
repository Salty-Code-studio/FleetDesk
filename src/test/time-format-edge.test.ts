import { describe, it, expect } from "vitest";
import { parseTs, formatDate, formatDateTime, formatTime, arubaDateOf } from "@/lib/time/format";

describe("time/format edge cases", () => {
  it("parseTs passes a bare calendar date through untouched (no offset padding)", () => {
    // The "-01" tail looks like a ±HH offset, but with no time component it must
    // not be padded; the value should parse exactly like a raw bare-date parse.
    expect(parseTs("2026-08-01")).toBe(Date.parse("2026-08-01"));
    expect(Number.isNaN(parseTs("2026-08-01"))).toBe(false);
  });

  it("parseTs still normalizes a Postgres two-digit +00 offset", () => {
    expect(parseTs("2026-08-01 13:00:00+00")).toBe(Date.parse("2026-08-01T13:00:00Z"));
  });

  it("parseTs normalizes a bare negative offset with a time component", () => {
    expect(parseTs("2026-08-01T09:00:00-04")).toBe(Date.parse("2026-08-01T09:00:00-04:00"));
  });

  it("formatters still work on a fully-specified offset ISO timestamp", () => {
    expect(formatDate("2026-08-01T13:00:00-04:00")).toBe("Aug 1, 2026");
    expect(formatTime("2026-08-01T13:00:00-04:00")).toBe("13:00");
    expect(formatDateTime("2026-08-01T13:00:00-04:00")).toBe("Aug 1, 2026 at 13:00");
  });

  it("arubaDateOf recovers the wall date from a Postgres string", () => {
    expect(arubaDateOf("2026-08-01 13:00:00+00")).toBe("2026-08-01");
  });
});
