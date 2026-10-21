"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { apiGet, type ApiError } from "../../client";
import {
  Skeleton,
  EmptyState,
  useToast,
  registerPaletteAction,
} from "@/app/admin/_ui";
import { Select } from "@/components/ui";
import { moneyHeadline } from "@/lib/admin/money-headline";
import "./reports.css";

interface Reports {
  currency: string;
  month: string;
  kpis: {
    revenueAllCents: number; revenueMonthCents: number; rentalsThisMonth: number;
    activeRentals: number; utilizationPct: number; idleCars: number;
  };
  revenueByMonth: { month: string; cents: number }[];
  revenueByClass: { class: string; cents: number }[];
  topVehicles: { plate: string; name: string; cents: number; rentals: number }[];
}

interface PerCarRow {
  vehicleId: string; name: string; plate: string; class: string;
  monthCents: number[]; totalCents: number;
}

interface PerCarRevenue {
  year: number;
  months: string[];
  rows: PerCarRow[];
  grandTotalCents: number;
  borg: {
    heldCents: number; returnedCents: number; withheldCents: number; withheldCount: number;
    withheldItems: { plate: string; name: string; amountCents: number; reason: string }[];
  };
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const SUB_COPY = "Revenue is the rental subtotal on every confirmed, picked up and completed booking. Cancelled rentals never count, and security deposits are never revenue.";

export default function ReportsPage() {
  const [data, setData] = useState<Reports | null>(null);
  const [err, setErr] = useState("");
  const [perCar, setPerCar] = useState<PerCarRevenue | null>(null);
  const [perCarErr, setPerCarErr] = useState("");
  const nowYear = new Date().getFullYear();
  const [year, setYear] = useState(String(nowYear));
  const [month, setMonth] = useState(String(new Date().getMonth() + 1));

  const toast = useToast();

  const load = useCallback(() => {
    apiGet<Reports>("/api/admin/reports")
      .then(setData)
      .catch((e) => {
        const message = (e as ApiError).message;
        setErr(message);
        toast.show({ type: "error", message });
      });
  }, [toast]);

  const loadPerCar = useCallback((y: string) => {
    setPerCarErr("");
    setPerCar(null);
    apiGet<PerCarRevenue>(`/api/admin/reports/per-car?year=${y}`)
      .then(setPerCar)
      .catch((e) => {
        const message = (e as ApiError).message;
        setPerCarErr(message);
        toast.show({ type: "error", message });
      });
  }, [toast]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadPerCar(year); }, [loadPerCar, year]);

  // Page-scoped command-palette actions: refresh, and a one-keystroke PDF grab.
  useEffect(
    () =>
      registerPaletteAction({
        id: "reports-refresh",
        label: "Refresh reports",
        hint: "Reports",
        keywords: "reports revenue refresh reload numbers kpi",
        run: () => { setErr(""); setData(null); load(); loadPerCar(year); },
      }),
    [load, loadPerCar, year],
  );

  useEffect(
    () =>
      registerPaletteAction({
        id: "reports-year-pdf",
        label: `Download revenue PDF ${year}`,
        hint: "Reports",
        keywords: "reports revenue pdf download export year",
        run: () => { window.location.assign(`/api/admin/reports/pdf?year=${year}`); },
      }),
    [year],
  );

  if (err) {
    return (
      <>
        <h1>Money</h1>
        <p className="sub">{SUB_COPY}</p>
        <div className="panel">
          <EmptyState
            title="Could not load reports"
            hint={err}
            action={
              <button type="button" className="btn" onClick={() => { setErr(""); setData(null); load(); loadPerCar(year); }}>
                Try again
              </button>
            }
          />
        </div>
      </>
    );
  }

  if (!data) {
    return (
      <>
        <h1>Money</h1>
        <p className="sub">{SUB_COPY}</p>

        <div className="rp-hero rp-hero--skel" aria-busy="true">
          <Skeleton width="45%" height={64} radius={10} />
          <Skeleton width="30%" height={12} />
          <div className="rp-hero__stats">
            <Skeleton width={120} height={30} />
            <Skeleton width={120} height={30} />
          </div>
        </div>

        <div className="panel rp-percar" aria-busy="true">
          <h2>Revenue per car</h2>
          <div className="rp-hbars">
            {Array.from({ length: 5 }).map((_, i) => (
              <div className="rp-hbar" key={i}>
                <span className="rp-hbar__label"><Skeleton width="80%" height={11} /></span>
                <span className="rp-hbar__track"><Skeleton width={`${85 - i * 13}%`} height={13} radius={7} style={{ display: "block" }} /></span>
                <span className="rp-hbar__val"><Skeleton width={56} height={11} /></span>
              </div>
            ))}
          </div>
        </div>

        <div className="panel" aria-busy="true">
          <h2>Deposits held</h2>
          <Skeleton width="100%" height={48} />
        </div>

        <div className="rp-grid">
          <div className="panel">
            <h2>Revenue by month</h2>
            <div className="rp-bars" aria-busy="true">
              {Array.from({ length: 8 }).map((_, i) => (
                <div className="rp-bar rp-bar--skel" key={i}>
                  <div className="rp-bar__track">
                    <Skeleton width="100%" height={`${30 + ((i * 37) % 60)}%`} radius="7px 7px 0 0" style={{ display: "block" }} />
                  </div>
                  <div className="rp-bar__label"><Skeleton width="60%" height={9} /></div>
                </div>
              ))}
            </div>
          </div>

          <div className="panel">
            <h2>Revenue by class</h2>
            <div className="rp-hbars" aria-busy="true">
              {Array.from({ length: 5 }).map((_, i) => (
                <div className="rp-hbar" key={i}>
                  <span className="rp-hbar__label"><Skeleton width="80%" height={11} /></span>
                  <span className="rp-hbar__track"><Skeleton width={`${80 - i * 14}%`} height={13} radius={7} style={{ display: "block" }} /></span>
                  <span className="rp-hbar__val"><Skeleton width={48} height={11} /></span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </>
    );
  }

  const sym = ({ AWG: "Afl.", USD: "$" } as Record<string, string>)[data.currency] ?? data.currency;
  const fmt = (cents: number) => `${sym} ${Math.round(cents / 100).toLocaleString("en-US")}`;
  const monthLabel = (mk: string) => new Date(`${mk}-01T00:00:00Z`).toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const maxMonth = Math.max(1, ...data.revenueByMonth.map((m) => m.cents));
  const maxClass = Math.max(1, ...data.revenueByClass.map((c) => c.cents));

  const head = moneyHeadline(data.revenueByMonth, data.month);
  const carRows = perCar ? [...perCar.rows].sort((x, y) => y.totalCents - x.totalCents) : [];
  const maxCar = Math.max(1, ...carRows.map((r) => r.totalCents));
  const heroMonth = monthLabel(data.month);

  const yearOptions = Array.from({ length: 6 }, (_, i) => {
    const y = String(nowYear - i);
    return { value: y, label: y };
  });
  const monthOptions = MONTH_NAMES.map((m, i) => ({ value: String(i + 1), label: m }));

  return (
    <>
      <h1>Money</h1>
      <p className="sub">{SUB_COPY}</p>

      <section className="rp-hero" aria-label="Revenue this month">
        <span className="rp-hero__back" aria-hidden="true">{heroMonth}</span>
        <div className="rp-hero__mid">
          <p className="rp-hero__label">Revenue this month</p>
          <p className="rp-hero__big">{fmt(head.thisMonthCents)}</p>
          <p className="rp-hero__line">{head.line}</p>
        </div>
        <div className="rp-hero__top">
          <div className="rp-stat"><b>{data.kpis.activeRentals}</b><span>Out on rental now</span></div>
          <div className="rp-stat"><b>{data.kpis.utilizationPct}%</b><span>Fleet booked, next 30 days</span></div>
          <details className="rp-export">
            <summary>Export</summary>
            <div className="rp-export__body">
              <Select ariaLabel="Month for the monthly PDF" value={month} onChange={setMonth} options={monthOptions} />
              <a className="btn" href={`/api/admin/reports/pdf?year=${year}&month=${month}`}>Month PDF</a>
              <a className="btn" href={`/api/admin/reports/pdf?year=${year}`}>Year PDF</a>
            </div>
          </details>
        </div>
      </section>

      <div className="panel rp-percar">
        <div className="rp-percar__head">
          <h2>Revenue per car</h2>
          <Select ariaLabel="Report year" value={year} onChange={setYear} options={yearOptions} />
        </div>
        {perCarErr ? (
          <EmptyState
            title="Could not load the per car numbers"
            hint={perCarErr}
            action={
              <button type="button" className="btn" onClick={() => loadPerCar(year)}>Try again</button>
            }
          />
        ) : !perCar ? (
          <div aria-busy="true">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} style={{ padding: ".45rem 0" }}><Skeleton width="100%" height={14} /></div>
            ))}
          </div>
        ) : perCar.rows.length === 0 ? (
          <EmptyState title="No cars yet" hint="Add vehicles to the fleet and their monthly earnings will build up here." />
        ) : (
          <>
            <div className="rp-hbars">
              {carRows.map((r) => (
                <div className="rp-hbar" key={r.vehicleId}>
                  <span className="rp-hbar__label"><b>{r.plate}</b> <small className="muted">{r.name}</small></span>
                  <span className="rp-hbar__track"><span className="rp-hbar__fill" style={{ width: `${(r.totalCents / maxCar) * 100}%` }} /></span>
                  <span className="rp-hbar__val">{fmt(r.totalCents)}</span>
                </div>
              ))}
            </div>
            <details className="rp-months">
              <summary>Month by month</summary>
              <div className="rp-matrix-wrap">
                <table className="rp-matrix">
                  <thead>
                    <tr>
                      <th className="rp-matrix__car" scope="col">Car</th>
                      {perCar.months.map((mk) => <th key={mk} scope="col">{monthLabel(mk)}</th>)}
                      <th scope="col">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {perCar.rows.map((r, idx) => {
                      const prev = perCar.rows[idx - 1];
                      const showGroup = !prev || prev.class !== r.class;
                      return (
                        <Fragment key={r.vehicleId}>
                          {showGroup && (
                            <tr className="rp-matrix__group"><th colSpan={14} scope="colgroup">{r.class}</th></tr>
                          )}
                          <tr>
                            <th scope="row" className="rp-matrix__car"><b>{r.plate}</b> <small className="muted">{r.name}</small></th>
                            {r.monthCents.map((c, i) => (
                              <td key={i} className={c === 0 ? "rp-matrix__zero" : undefined}>{fmt(c)}</td>
                            ))}
                            <td className="rp-matrix__total">{fmt(r.totalCents)}</td>
                          </tr>
                        </Fragment>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row" className="rp-matrix__car">Total</th>
                      {perCar.months.map((mk, i) => (
                        <td key={mk}>{fmt(perCar.rows.reduce((s, r) => s + (r.monthCents[i] ?? 0), 0))}</td>
                      ))}
                      <td className="rp-matrix__total">{fmt(perCar.grandTotalCents)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </details>
          </>
        )}
      </div>

      <div className="panel">
        <h2>Deposits held <span className="v">security deposits, {year}</span></h2>
        {!perCar ? (
          <div aria-busy="true"><Skeleton width="100%" height={48} /></div>
        ) : (
          <>
            <div className="rp-borg">
              <div className="rp-kpi"><span>Held at pickup</span><b>{fmt(perCar.borg.heldCents)}</b></div>
              <div className="rp-kpi"><span>Returned</span><b>{fmt(perCar.borg.returnedCents)}</b></div>
              <div className="rp-kpi"><span>Withheld ({perCar.borg.withheldCount})</span><b>{fmt(perCar.borg.withheldCents)}</b></div>
            </div>
            {perCar.borg.withheldItems.length > 0 && (
              <ul className="rp-borg-items">
                {perCar.borg.withheldItems.map((w, i) => (
                  <li key={i}><b>{w.plate}</b> <small className="muted">{w.name}</small> {fmt(w.amountCents)} withheld. {w.reason}</li>
                ))}
              </ul>
            )}
            <p className="sub" style={{ margin: ".6rem 0 0" }}>Deposits are money you hold for the customer, not income. They never count toward revenue.</p>
          </>
        )}
      </div>

      <div className="rp-grid">
        <div className="panel">
          <h2>Revenue by month</h2>
          {data.revenueByMonth.every((m) => m.cents === 0) ? (
            <EmptyState title="No revenue yet" hint="Confirmed and completed rentals will chart here month by month." />
          ) : (
            <div className="rp-bars">
              {data.revenueByMonth.map((m) => (
                <div className="rp-bar" key={m.month}>
                  <div className="rp-bar__val">{m.cents > 0 ? fmt(m.cents) : ""}</div>
                  <div className="rp-bar__track"><div className="rp-bar__fill" style={{ height: `${(m.cents / maxMonth) * 100}%` }} /></div>
                  <div className="rp-bar__label">{monthLabel(m.month)}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="panel">
          <h2>Revenue by class</h2>
          {data.revenueByClass.length === 0 ? (
            <EmptyState title="No revenue yet" hint="Once cars start renting, earnings split by class will show here." />
          ) : (
            <div className="rp-hbars">
              {data.revenueByClass.map((c) => (
                <div className="rp-hbar" key={c.class}>
                  <span className="rp-hbar__label">{c.class}</span>
                  <span className="rp-hbar__track"><span className="rp-hbar__fill" style={{ width: `${(c.cents / maxClass) * 100}%` }} /></span>
                  <span className="rp-hbar__val">{fmt(c.cents)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
