/**
 * The Money page headline: this month's revenue against last month's.
 * Pure. "Last month" is the entry before this one in array order, so January
 * compares against December without any calendar math. Amount formatting
 * stays in the page.
 */
export interface MoneyHeadline {
  thisMonthCents: number;
  lastMonthCents: number | null;
  deltaPct: number | null;
  line: string;
}

export function moneyHeadline(
  revenueByMonth: { month: string; cents: number }[],
  monthKey: string,
): MoneyHeadline {
  const idx = revenueByMonth.findIndex((m) => m.month === monthKey);
  const thisMonthCents = revenueByMonth[idx]?.cents ?? 0;
  const lastMonthCents = revenueByMonth[idx - 1]?.cents ?? null;
  if (lastMonthCents === null || lastMonthCents <= 0) {
    return { thisMonthCents, lastMonthCents, deltaPct: null, line: "Nothing booked last month" };
  }
  const deltaPct = Math.round(((thisMonthCents - lastMonthCents) / lastMonthCents) * 100);
  const line = deltaPct > 0 ? `Up ${deltaPct}% on last month`
    : deltaPct < 0 ? `Down ${Math.abs(deltaPct)}% on last month`
    : "Level with last month";
  return { thisMonthCents, lastMonthCents, deltaPct, line };
}
