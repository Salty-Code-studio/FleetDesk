/**
 * Setup checklist: what is still open before the desk runs on its own.
 *
 * Pure: counts in, checklist out. A car-based item is never done vacuously:
 * with zero active cars, "Cars and rates" and "Deposits" stay open.
 */
export interface SetupInput {
  alertRecipients: number; activeCars: number; carsWithDayRate: number; carsWithDeposit: number;
  activeTiers: number; activeAddOns: number; policiesPublished: number; // of 3 types
  paymentsReady: boolean; activeStaff: number; liveBookings: number;   // non-cancelled
}
export interface SetupItem { key: string; label: string; hint: string; href: string | null; done: boolean }
export interface SetupProgress { items: SetupItem[]; done: number; total: number; pct: number; next: SetupItem | null }

export function setupProgress(i: SetupInput): SetupProgress {
  const items: SetupItem[] = [
    { key: "hours", label: "Opening hours and booking alerts", hint: "Add an email that gets booking alerts.",
      href: "/admin/settings", done: i.alertRecipients > 0 },
    { key: "rates", label: "Cars and rates", hint: "Add your cars and give each a day rate.",
      href: "/admin/fleet", done: i.activeCars > 0 && i.carsWithDayRate === i.activeCars },
    { key: "deposits", label: "Deposits", hint: "Set a deposit on every car.",
      href: "/admin/fleet", done: i.activeCars > 0 && i.carsWithDeposit === i.activeCars },
    { key: "insurance", label: "Insurance tiers", hint: "Add at least one insurance tier.",
      href: "/admin/catalog", done: i.activeTiers > 0 },
    { key: "addons", label: "Add-ons", hint: "Add an extra guests can pick, like a child seat.",
      href: "/admin/catalog", done: i.activeAddOns > 0 },
    { key: "policies", label: "Policies", hint: "Publish rental terms, cancellation and privacy.",
      href: "/admin/policies", done: i.policiesPublished === 3 },
    { key: "payments", label: "Payments", hint: "Switched on with your account.",
      href: null, done: i.paymentsReady },
    { key: "team", label: "Your team", hint: "Add a staff member with their own code.",
      href: "/admin/staff", done: i.activeStaff > 0 },
    { key: "first", label: "First booking", hint: "Take your first booking on the board.",
      href: "/admin/board", done: i.liveBookings > 0 },
  ];
  const done = items.filter((x) => x.done).length;
  const total = items.length;
  return {
    items, done, total,
    pct: Math.round((done / total) * 100),
    next: items.find((x) => !x.done) ?? null,
  };
}
