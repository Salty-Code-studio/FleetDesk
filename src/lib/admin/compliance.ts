/**
 * Compliance alerts (wave 03): insurance + inspection expiry tracking.
 *
 * Each vehicle carries two document dates (insuranceExpiresOn, inspectionDueOn)
 * and a per-document alert stage used as a dedup marker:
 *   0 = nothing fired, 1 = first warning fired (settings.complianceAlertDays
 *   before the date), 2 = one-week warning fired, 3 = overdue fired.
 * The daily cron computes the TARGET stage purely from the date and fires only
 * when target > recorded, so each stage alerts exactly once. Entering a new
 * future date resets the recorded stage (updateVehicle does that); the cron
 * also lowers a stale stage quietly, so any write path self-heals.
 *
 * Firing is best-effort by construction: notifyAdmin() and alertOwner() never
 * throw, so a notification failure cannot break the cron run.
 */
import { eq, ne } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { vehicles } from "@/lib/db/schema";
import { getSettings } from "@/lib/admin/settings";
import { notifyAdmin, alertOwner } from "@/lib/notify";
import { adminDocumentExpiringEmail } from "@/lib/email/templates";

export type ComplianceKind = "insurance" | "inspection";

export interface ComplianceItem {
  vehicleId: string;
  name: string;
  plate: string;
  kind: ComplianceKind;
  dueOn: string;
  daysLeft: number;
}

const DAY_MS = 86_400_000;
/** The client's "one week before" stage. Fixed; only the first warning is a setting. */
const WEEK_STAGE_DAYS = 7;

/** Calendar date (YYYY-MM-DD) of `now` in the operator's timezone (America/Aruba). */
function arubaDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Aruba" }).format(now);
}

/** Whole days from `today` until `dueOn` (both YYYY-MM-DD). Negative = overdue. */
export function daysUntil(today: string, dueOn: string): number {
  return Math.round((Date.parse(`${dueOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
}

/**
 * 0 = no alert yet, 1 = first warning, 2 = one week, 3 = overdue.
 * Checked most-urgent-first, so a firstWarningDays below 7 simply collapses
 * stage 1 into stage 2 instead of breaking the ladder.
 */
export function targetStage(daysLeft: number, firstWarningDays: number): number {
  if (daysLeft < 0) return 3;
  if (daysLeft <= WEEK_STAGE_DAYS) return 2;
  if (daysLeft <= firstWarningDays) return 1;
  return 0;
}

/**
 * Daily staged alert run. For every non-retired vehicle and each tracked
 * document, fire bell + owner email + WhatsApp when the date has entered a new
 * alert stage since the last run. Returns how many alerts fired.
 */
export async function runComplianceAlerts(now = new Date()): Promise<{ fired: number }> {
  const db = await getDb();
  const settings = await getSettings();
  const today = arubaDate(now);
  const fleet = await db.select().from(vehicles).where(ne(vehicles.status, "retired"));
  let fired = 0;

  for (const v of fleet) {
    const docs = [
      { kind: "insurance" as const, dueOn: v.insuranceExpiresOn, recorded: v.insuranceAlertStage },
      { kind: "inspection" as const, dueOn: v.inspectionDueOn, recorded: v.inspectionAlertStage },
    ];
    for (const doc of docs) {
      if (!doc.dueOn) continue;
      const daysLeft = daysUntil(today, doc.dueOn);
      const target = targetStage(daysLeft, settings.complianceAlertDays);
      if (target === doc.recorded) continue;

      const stagePatch = doc.kind === "insurance"
        ? { insuranceAlertStage: target }
        : { inspectionAlertStage: target };

      if (target < doc.recorded) {
        // The date moved into the future through some path that skipped the
        // form reset. Lower the marker quietly so the next cycle can fire.
        await db.update(vehicles).set({ ...stagePatch, updatedAt: now }).where(eq(vehicles.id, v.id));
        continue;
      }

      const overdue = target === 3;
      const docName = doc.kind === "insurance" ? "Insurance" : "Inspection";
      const title = overdue
        ? `${docName} overdue: ${v.name} (${v.plate})`
        : `${docName} due soon: ${v.name} (${v.plate})`;
      const body = overdue
        ? `Was due on ${doc.dueOn}.`
        : `Due on ${doc.dueOn} (${daysLeft} ${daysLeft === 1 ? "day" : "days"} left).`;

      await notifyAdmin({ level: overdue ? "critical" : "warning", type: "vehicle.document_expiring", title, body });
      const email = adminDocumentExpiringEmail({ vehicleName: v.name, plate: v.plate, kind: doc.kind, dueOn: doc.dueOn, daysLeft });
      await alertOwner({ type: "vehicle.document_expiring", subject: email.subject, html: email.html, whatsappText: `${title}. ${body}` });
      await db.update(vehicles).set({ ...stagePatch, updatedAt: now }).where(eq(vehicles.id, v.id));
      fired++;
    }
  }
  return { fired };
}

/**
 * Dashboard feed: every non-retired vehicle document due within the
 * first-warning window or overdue, most urgent first.
 */
export async function complianceOverview(now = new Date()): Promise<{ items: ComplianceItem[] }> {
  const db = await getDb();
  const settings = await getSettings();
  const today = arubaDate(now);
  const fleet = await db.select().from(vehicles).where(ne(vehicles.status, "retired"));
  const items: ComplianceItem[] = [];
  for (const v of fleet) {
    const docs = [
      { kind: "insurance" as const, dueOn: v.insuranceExpiresOn },
      { kind: "inspection" as const, dueOn: v.inspectionDueOn },
    ];
    for (const doc of docs) {
      if (!doc.dueOn) continue;
      const daysLeft = daysUntil(today, doc.dueOn);
      if (daysLeft > settings.complianceAlertDays) continue;
      items.push({ vehicleId: v.id, name: v.name, plate: v.plate, kind: doc.kind, dueOn: doc.dueOn, daysLeft });
    }
  }
  items.sort((a, b) => a.daysLeft - b.daysLeft);
  return { items };
}
