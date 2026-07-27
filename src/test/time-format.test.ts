import { describe, it, expect } from "vitest";
import {
  atAruba, parseTs, arubaDateOf, arubaTimeOf, addHoursIso, formatDateTime, formatDate, formatTime,
} from "@/lib/time/format";
import { isoDateTime } from "@/lib/validation/iso-date";

describe("time/format", () => {
  it("atAruba builds a fixed-offset ISO timestamp", () => {
    expect(atAruba("2026-08-01", "09:00")).toBe("2026-08-01T09:00:00-04:00");
  });

  it("parseTs handles ISO and Postgres string forms identically", () => {
    const iso = parseTs("2026-08-01T09:00:00-04:00");
    const pg = parseTs("2026-08-01 13:00:00+00");
    expect(iso).toBe(pg);
    expect(iso).toBe(Date.parse("2026-08-01T13:00:00Z"));
  });

  it("arubaDateOf / arubaTimeOf recover the Aruba wall date and time", () => {
    expect(arubaDateOf("2026-08-01 13:00:00+00")).toBe("2026-08-01");
    expect(arubaTimeOf("2026-08-01 13:00:00+00")).toBe("09:00");
    expect(arubaDateOf("2026-08-01T01:30:00Z")).toBe("2026-07-31"); // 21:30 previous day in Aruba
    expect(arubaTimeOf("2026-08-01T01:30:00Z")).toBe("21:30");
  });

  it("addHoursIso shifts by whole hours and returns fixed-offset ISO", () => {
    expect(addHoursIso("2026-08-01T09:00:00-04:00", 24)).toBe("2026-08-02T09:00:00-04:00");
    expect(addHoursIso("2026-08-01T22:00:00-04:00", 3)).toBe("2026-08-02T01:00:00-04:00");
  });

  it("formatters render Aruba wall time, dash free", () => {
    expect(formatDateTime("2026-08-01T09:00:00-04:00")).toBe("Aug 1, 2026 at 09:00");
    expect(formatDate("2026-08-01T09:00:00-04:00")).toBe("Aug 1, 2026");
    expect(formatTime("2026-08-01T13:30:00-04:00")).toBe("13:30");
  });
});

describe("isoDateTime", () => {
  it("accepts offset ISO timestamps", () => {
    expect(isoDateTime.safeParse("2026-08-01T09:00:00-04:00").success).toBe(true);
    expect(isoDateTime.safeParse("2026-08-01T13:00:00Z").success).toBe(true);
  });
  it("rejects date-only, naive, and impossible values", () => {
    expect(isoDateTime.safeParse("2026-08-01").success).toBe(false);
    expect(isoDateTime.safeParse("2026-08-01T09:00:00").success).toBe(false); // no offset
    expect(isoDateTime.safeParse("2026-02-30T09:00:00Z").success).toBe(false);
  });
});
