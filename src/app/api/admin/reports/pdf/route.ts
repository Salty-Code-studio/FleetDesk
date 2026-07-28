import { NextResponse } from "next/server";
import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { parseParams } from "@/lib/http/validate";
import { read } from "@/lib/admin/guard";
import { perCarRevenue } from "@/lib/admin/reports";
import { getSettings } from "@/lib/admin/settings";
import { arubaToday } from "@/lib/booking/public";
import { renderRevenueReportPdf, reportPdfFilename } from "@/lib/pdf/report";
import { siteConfig } from "@/lib/site-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12).optional(),
});

/** GET /api/admin/reports/pdf?year=YYYY[&month=M] — on-demand revenue report
 *  PDF: the yearly per-car matrix with the borg panel, or a single month.
 *  Rendered per request, streamed back, never stored. Owner-only. */
export const GET = withRoute(async (req) => {
  const url = new URL(req.url);
  const q = parseParams(Object.fromEntries(url.searchParams), QuerySchema);

  const bytes = await read(req, async () => {
    const report = await perCarRevenue(q.year);
    const settings = await getSettings();
    return renderRevenueReportPdf({
      kind: q.month ? "monthly" : "yearly",
      year: q.year,
      month: q.month,
      currency: settings.currency,
      generatedOn: arubaToday(),
      operatorName: siteConfig.siteName,
      rows: report.rows,
      grandTotalCents: report.grandTotalCents,
      borg: report.borg,
    });
  });

  return new NextResponse(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${reportPdfFilename(q.year, q.month)}"`,
      "Cache-Control": "no-store",
    },
  });
});
