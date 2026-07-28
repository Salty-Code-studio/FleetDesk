/**
 * Revenue report PDFs (monthly + yearly), rendered server-side with
 * @react-pdf/renderer (dependency shared with the rental contract PDF).
 * Sand & Surf styled to match the admin: sand paper, deep teal ink, one coral
 * accent on the grand total. Revenue is rental income only; the borg panel is
 * informational and never mixes into the revenue figures. Built-in Helvetica
 * only, so nothing external is ever fetched. Copy is dash-free.
 */
import { Document, Page, Text, View, StyleSheet, renderToBuffer } from "@react-pdf/renderer";

export interface RevenueReportRow {
  plate: string;
  name: string;
  class: string;
  monthCents: number[]; // 12 entries, January first
  totalCents: number;
}

export interface RevenueReportBorg {
  heldCents: number;
  returnedCents: number;
  withheldCents: number;
  withheldCount: number;
  withheldItems: { plate: string; name: string; amountCents: number; reason: string }[];
}

export interface RevenueReportData {
  kind: "monthly" | "yearly";
  year: number;
  /** 1..12; required when kind is "monthly", ignored otherwise. */
  month?: number;
  currency: string;
  /** YYYY-MM-DD, Aruba local. */
  generatedOn: string;
  operatorName: string;
  rows: RevenueReportRow[];
  grandTotalCents: number;
  borg: RevenueReportBorg;
}

export function reportPdfFilename(year: number, month?: number): string {
  return month ? `revenue-${year}-${String(month).padStart(2, "0")}.pdf` : `revenue-${year}.pdf`;
}

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// Sand & Surf (mirrors src/app/admin/admin.css custom properties).
const SAND = "#F2EBDD";
const TEAL = "#0E3A40";
const CORAL = "#FF6F59";
const INK = "#1C2B2E";
const INK_SOFT = "#586A6D";
const INK_MUTE = "#8B9B9D";
const LINE = "#E3DAC8";
const FILL = "#F4EEE1";

const S = StyleSheet.create({
  page: { backgroundColor: SAND, color: INK, padding: 36, fontSize: 8, fontFamily: "Helvetica" },
  brand: { fontSize: 13, color: TEAL, fontFamily: "Helvetica-Bold", marginBottom: 2 },
  title: { fontSize: 19, color: INK, fontFamily: "Helvetica-Bold", marginBottom: 3 },
  sub: { fontSize: 8, color: INK_SOFT, marginBottom: 14 },
  panel: { backgroundColor: "#FFFFFF", borderRadius: 8, borderWidth: 1, borderColor: LINE, padding: 12, marginBottom: 12 },
  h2: { fontSize: 11, color: TEAL, fontFamily: "Helvetica-Bold", marginBottom: 8 },
  headRow: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: LINE, paddingBottom: 4 },
  headCell: { fontSize: 6.5, color: INK_SOFT, textTransform: "uppercase" },
  row: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: FILL, paddingVertical: 3, alignItems: "center" },
  groupRow: { flexDirection: "row", backgroundColor: FILL, paddingVertical: 3, paddingHorizontal: 2, marginTop: 4 },
  groupLabel: { fontSize: 7, color: TEAL, fontFamily: "Helvetica-Bold", textTransform: "uppercase", letterSpacing: 0.6 },
  carCell: { flexBasis: 130, flexGrow: 0, flexShrink: 0, textAlign: "left", paddingRight: 4 },
  monthCell: { flexGrow: 1, flexBasis: 0, textAlign: "right" },
  totalCell: { flexBasis: 58, flexGrow: 0, flexShrink: 0, textAlign: "right" },
  amountCell: { flexGrow: 1, flexBasis: 0, textAlign: "right" },
  bold: { fontFamily: "Helvetica-Bold" },
  zero: { color: INK_MUTE },
  totalRow: { flexDirection: "row", borderTopWidth: 2, borderTopColor: TEAL, paddingTop: 5, marginTop: 2 },
  coral: { color: CORAL },
  borgTiles: { flexDirection: "row", marginBottom: 8 },
  borgTile: { flexGrow: 1, flexBasis: 0, backgroundColor: FILL, borderRadius: 6, padding: 8, marginRight: 8 },
  borgTileLast: { flexGrow: 1, flexBasis: 0, backgroundColor: FILL, borderRadius: 6, padding: 8 },
  borgLabel: { fontSize: 6.5, color: INK_SOFT, textTransform: "uppercase", marginBottom: 3 },
  borgValue: { fontSize: 12, fontFamily: "Helvetica-Bold", color: INK },
  note: { fontSize: 7, color: INK_SOFT, marginTop: 6 },
});

const sym = (currency: string) => ({ AWG: "Afl.", USD: "$" } as Record<string, string>)[currency] ?? currency;
const units = (cents: number) => Math.round(cents / 100).toLocaleString("en-US");
const money = (cents: number, currency: string) => `${sym(currency)} ${units(cents)}`;

function groupRows(rows: RevenueReportRow[]): { class: string; rows: RevenueReportRow[] }[] {
  const out: { class: string; rows: RevenueReportRow[] }[] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last.class === r.class) last.rows.push(r);
    else out.push({ class: r.class, rows: [r] });
  }
  return out;
}

function Header({ d, title }: { d: RevenueReportData; title: string }) {
  return (
    <View>
      <Text style={S.brand}>{d.operatorName}</Text>
      <Text style={S.title}>{title}</Text>
      <Text style={S.sub}>
        Rental income per car. Security deposits are never counted as revenue. Generated on {d.generatedOn}.
      </Text>
    </View>
  );
}

function BorgPanel({ d }: { d: RevenueReportData }) {
  const b = d.borg;
  return (
    <View style={S.panel} wrap={false}>
      <Text style={S.h2}>Borg (security deposits) {d.year}</Text>
      <View style={S.borgTiles}>
        <View style={S.borgTile}>
          <Text style={S.borgLabel}>Held at pickup</Text>
          <Text style={S.borgValue}>{money(b.heldCents, d.currency)}</Text>
        </View>
        <View style={S.borgTile}>
          <Text style={S.borgLabel}>Returned</Text>
          <Text style={S.borgValue}>{money(b.returnedCents, d.currency)}</Text>
        </View>
        <View style={S.borgTileLast}>
          <Text style={S.borgLabel}>Withheld ({b.withheldCount})</Text>
          <Text style={S.borgValue}>{money(b.withheldCents, d.currency)}</Text>
        </View>
      </View>
      {b.withheldItems.map((w, i) => (
        <Text key={i} style={S.note}>
          {w.plate} {w.name}: {money(w.amountCents, d.currency)} withheld. {w.reason}
        </Text>
      ))}
      <Text style={S.note}>
        Borg is money you hold for the customer, not income. It stays out of every revenue figure above.
      </Text>
    </View>
  );
}

function YearlyPage({ d }: { d: RevenueReportData }) {
  const groups = groupRows(d.rows);
  const colTotals = MONTHS_SHORT.map((_, i) => d.rows.reduce((s, r) => s + (r.monthCents[i] ?? 0), 0));
  return (
    <Page size="A4" orientation="landscape" style={S.page}>
      <Header d={d} title={`Revenue ${d.year}`} />
      <View style={S.panel}>
        <View style={S.headRow}>
          <Text style={[S.headCell, S.carCell]}>Car</Text>
          {MONTHS_SHORT.map((m) => (
            <Text key={m} style={[S.headCell, S.monthCell]}>{m}</Text>
          ))}
          <Text style={[S.headCell, S.totalCell]}>Total</Text>
        </View>
        {groups.map((g) => (
          <View key={g.class}>
            <View style={S.groupRow}><Text style={S.groupLabel}>{g.class}</Text></View>
            {g.rows.map((r) => (
              <View key={r.plate} style={S.row} wrap={false}>
                <Text style={S.carCell}>
                  <Text style={S.bold}>{r.plate}</Text>  {r.name}
                </Text>
                {r.monthCents.map((c, i) => (
                  <Text key={i} style={c === 0 ? [S.monthCell, S.zero] : S.monthCell}>{units(c)}</Text>
                ))}
                <Text style={[S.totalCell, S.bold]}>{units(r.totalCents)}</Text>
              </View>
            ))}
          </View>
        ))}
        <View style={S.totalRow}>
          <Text style={[S.carCell, S.bold]}>Total ({d.currency})</Text>
          {colTotals.map((c, i) => (
            <Text key={i} style={[S.monthCell, S.bold]}>{units(c)}</Text>
          ))}
          <Text style={[S.totalCell, S.bold, S.coral]}>{units(d.grandTotalCents)}</Text>
        </View>
        <Text style={S.note}>All amounts in {d.currency}, whole units.</Text>
      </View>
      <BorgPanel d={d} />
    </Page>
  );
}

function MonthlyPage({ d }: { d: RevenueReportData }) {
  const mi = (d.month ?? 1) - 1;
  const groups = groupRows(d.rows);
  const monthTotal = d.rows.reduce((s, r) => s + (r.monthCents[mi] ?? 0), 0);
  return (
    <Page size="A4" style={S.page}>
      <Header d={d} title={`Revenue ${MONTHS_LONG[mi]} ${d.year}`} />
      <View style={S.panel}>
        <View style={S.headRow}>
          <Text style={[S.headCell, S.carCell]}>Car</Text>
          <Text style={[S.headCell, S.amountCell]}>Revenue</Text>
        </View>
        {groups.map((g) => (
          <View key={g.class}>
            <View style={S.groupRow}><Text style={S.groupLabel}>{g.class}</Text></View>
            {g.rows.map((r) => {
              const c = r.monthCents[mi] ?? 0;
              return (
                <View key={r.plate} style={S.row} wrap={false}>
                  <Text style={S.carCell}>
                    <Text style={S.bold}>{r.plate}</Text>  {r.name}
                  </Text>
                  <Text style={c === 0 ? [S.amountCell, S.zero] : S.amountCell}>{money(c, d.currency)}</Text>
                </View>
              );
            })}
          </View>
        ))}
        <View style={S.totalRow}>
          <Text style={[S.carCell, S.bold]}>Total</Text>
          <Text style={[S.amountCell, S.bold, S.coral]}>{money(monthTotal, d.currency)}</Text>
        </View>
        <Text style={S.note}>All amounts in {d.currency}, whole units.</Text>
      </View>
    </Page>
  );
}

export async function renderRevenueReportPdf(data: RevenueReportData): Promise<Uint8Array> {
  const title = data.kind === "yearly"
    ? `Revenue ${data.year}`
    : `Revenue ${MONTHS_LONG[(data.month ?? 1) - 1]} ${data.year}`;
  const doc = (
    <Document title={title} author={data.operatorName}>
      {data.kind === "yearly" ? <YearlyPage d={data} /> : <MonthlyPage d={data} />}
    </Document>
  );
  const buf = await renderToBuffer(doc);
  return new Uint8Array(buf);
}
