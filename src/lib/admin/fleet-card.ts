/**
 * Pure helpers for the fleet card list. No React, no DB: the page decides
 * what to show, these functions decide the labels, the rate line and the
 * order. "today" is an Aruba calendar date string (YYYY-MM-DD).
 */

export type ComplianceKey = "Insurance" | "Inspection";
export interface ComplianceBadge { key: ComplianceKey; label: string; overdue: boolean }

const DAY_MS = 86_400_000;

function daysBetween(fromDate: string, toDate: string): number {
  return Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / DAY_MS);
}

export function complianceBadges(
  v: { insuranceExpiresOn: string | null; inspectionDueOn: string | null },
  today: string,
  alertDays: number,
): ComplianceBadge[] {
  const out: ComplianceBadge[] = [];
  const checks: [ComplianceKey, string | null][] = [
    ["Insurance", v.insuranceExpiresOn],
    ["Inspection", v.inspectionDueOn],
  ];
  for (const [key, dueOn] of checks) {
    if (!dueOn) continue;
    const d = daysBetween(today, dueOn);
    if (d > alertDays) continue;
    out.push({ key, label: d < 0 ? `${key} overdue` : `${key} ${d}d`, overdue: d < 0 });
  }
  return out;
}

export function rateLine(
  v: { priceDayCents: number; priceWeekCents: number; priceMonthCents: number },
  sym: string,
): string {
  const money = (c: number) => `${sym}${(c / 100).toFixed(0)}`;
  return `${money(v.priceDayCents)} day · ${money(v.priceWeekCents)} week · ${money(v.priceMonthCents)} month`;
}

export function sortForCards<T extends { status: string; class: string; plate: string }>(
  vs: T[],
  classOrder: string[],
): T[] {
  const classRank = (c: string) => {
    const i = classOrder.indexOf(c);
    return i < 0 ? classOrder.length : i;
  };
  return [...vs].sort((a, b) => {
    const retiredA = a.status === "retired" ? 1 : 0;
    const retiredB = b.status === "retired" ? 1 : 0;
    if (retiredA !== retiredB) return retiredA - retiredB;
    const byClass = classRank(a.class) - classRank(b.class);
    if (byClass !== 0) return byClass;
    return a.plate < b.plate ? -1 : a.plate > b.plate ? 1 : 0;
  });
}
