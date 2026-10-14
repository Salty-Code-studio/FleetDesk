import { describe, it, expect } from "vitest";
import { LINKS, isActive } from "@/app/admin/(shell)/side-nav";

const by = (label: string) => LINKS.find((l) => l.label === label)!;

describe("verb nav active state", () => {
  it("Today is active only on /admin itself", () => {
    expect(isActive(by("Today"), "/admin")).toBe(true);
    expect(isActive(by("Today"), "/admin/board")).toBe(false);
  });
  it("Setup is active on every page folded under it", () => {
    for (const p of ["/admin/settings", "/admin/catalog", "/admin/policies", "/admin/staff", "/admin/audit"]) {
      expect(isActive(by("Setup"), p), p).toBe(true);
    }
    expect(isActive(by("Setup"), "/admin/fleet")).toBe(false);
  });
  it("staff see Today, Board and Fleet only", () => {
    expect(LINKS.filter((l) => l.staff).map((l) => l.label)).toEqual(["Today", "Board", "Fleet"]);
  });
});
