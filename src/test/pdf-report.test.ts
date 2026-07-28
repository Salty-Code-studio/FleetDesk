import { describe, it, expect } from "vitest";
import { renderRevenueReportPdf, reportPdfFilename, type RevenueReportData } from "@/lib/pdf/report";

const base: RevenueReportData = {
  kind: "yearly",
  year: 2026,
  currency: "USD",
  generatedOn: "2026-07-27",
  operatorName: "FleetDesk",
  rows: [
    { plate: "V-101", name: "Toyota Yaris", class: "Economy", monthCents: [0, 0, 40000, 30000, 0, 30000, 0, 0, 0, 0, 0, 0], totalCents: 100000 },
    { plate: "V-202", name: "Suzuki Jimny", class: "4x4", monthCents: [20000, 0, 501, 500, 0, 5000, 0, 0, 0, 0, 0, 0], totalCents: 26001 },
  ],
  grandTotalCents: 126001,
  borg: {
    heldCents: 100000, returnedCents: 30000, withheldCents: 20000, withheldCount: 1,
    withheldItems: [{ plate: "V-101", name: "Toyota Yaris", amountCents: 20000, reason: "Scratched rear bumper" }],
  },
};

const isPdf = (bytes: Uint8Array) => new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-";

describe("renderRevenueReportPdf", () => {
  it("renders a yearly report as a real PDF", async () => {
    const bytes = await renderRevenueReportPdf(base);
    expect(isPdf(bytes)).toBe(true);
    expect(bytes.length).toBeGreaterThan(1000);
  });

  it("renders a monthly report as a real PDF", async () => {
    const bytes = await renderRevenueReportPdf({ ...base, kind: "monthly", month: 3 });
    expect(isPdf(bytes)).toBe(true);
    expect(bytes.length).toBeGreaterThan(1000);
  });

  it("renders an empty fleet without throwing", async () => {
    const bytes = await renderRevenueReportPdf({
      ...base,
      rows: [],
      grandTotalCents: 0,
      borg: { heldCents: 0, returnedCents: 0, withheldCents: 0, withheldCount: 0, withheldItems: [] },
    });
    expect(isPdf(bytes)).toBe(true);
  });
});

describe("reportPdfFilename", () => {
  it("names the yearly report revenue-YYYY.pdf", () => {
    expect(reportPdfFilename(2026)).toBe("revenue-2026.pdf");
  });

  it("names the monthly report revenue-YYYY-MM.pdf with a padded month", () => {
    expect(reportPdfFilename(2026, 3)).toBe("revenue-2026-03.pdf");
    expect(reportPdfFilename(2026, 11)).toBe("revenue-2026-11.pdf");
  });
});
