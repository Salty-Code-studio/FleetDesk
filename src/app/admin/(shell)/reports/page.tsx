"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, type ApiError } from "../../client";
import {
  Skeleton,
  EmptyState,
  useToast,
  registerPaletteAction,
} from "@/app/admin/_ui";
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

export default function ReportsPage() {
  const [data, setData] = useState<Reports | null>(null);
  const [err, setErr] = useState("");

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

  useEffect(() => { load(); }, [load]);

  // Page-scoped command-palette action: refresh the numbers without a reload.
  useEffect(
    () =>
      registerPaletteAction({
        id: "reports-refresh",
        label: "Refresh reports",
        hint: "Reports",
        keywords: "reports revenue refresh reload numbers kpi",
        run: () => { setErr(""); setData(null); load(); },
      }),
    [load],
  );

  if (err) {
    return (
      <>
        <h1>Reports</h1>
        <p className="sub">Revenue is the rental subtotal on every confirmed and completed booking. Cancelled rentals never count.</p>
        <div className="panel">
          <EmptyState
            title="Could not load reports"
            hint={err}
            action={
              <button type="button" className="btn btn--accent" onClick={() => { setErr(""); setData(null); load(); }}>
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
        <h1>Reports</h1>
        <p className="sub">Revenue is the rental subtotal on every confirmed and completed booking. Cancelled rentals never count.</p>

        <div className="rp-kpis" aria-busy="true">
          {Array.from({ length: 6 }).map((_, i) => (
            <div className={`rp-kpi${i === 0 ? " rp-kpi--accent" : ""}`} key={i}>
              <span><Skeleton width="70%" height={9} /></span>
              <b><Skeleton width="55%" height={26} radius={8} /></b>
            </div>
          ))}
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

        <div className="panel">
          <h2>Top earning cars</h2>
          <div className="rp-hbars" aria-busy="true">
            {Array.from({ length: 5 }).map((_, i) => (
              <div className="rp-hbar" key={i}>
                <span className="rp-hbar__label"><Skeleton width="75%" height={11} /></span>
                <span className="rp-hbar__track"><Skeleton width={`${85 - i * 13}%`} height={13} radius={7} style={{ display: "block" }} /></span>
                <span className="rp-hbar__val"><Skeleton width={56} height={11} /></span>
              </div>
            ))}
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
  const maxVeh = Math.max(1, ...data.topVehicles.map((v) => v.cents));

  return (
    <>
      <h1>Reports</h1>
      <p className="sub">Revenue is the rental subtotal on every confirmed and completed booking. Cancelled rentals never count.</p>

      <div className="rp-kpis">
        <div className="rp-kpi rp-kpi--accent"><span>Revenue this month</span><b>{fmt(data.kpis.revenueMonthCents)}</b></div>
        <div className="rp-kpi"><span>Revenue all time</span><b>{fmt(data.kpis.revenueAllCents)}</b></div>
        <div className="rp-kpi"><span>Out on rental now</span><b>{data.kpis.activeRentals}</b></div>
        <div className="rp-kpi"><span>Fleet booked, next 30 days</span><b>{data.kpis.utilizationPct}%</b></div>
        <div className="rp-kpi"><span>Rentals starting this month</span><b>{data.kpis.rentalsThisMonth}</b></div>
        <div className="rp-kpi"><span>Idle cars, next 30 days</span><b>{data.kpis.idleCars}</b></div>
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

      <div className="panel">
        <h2>Top earning cars</h2>
        {data.topVehicles.length === 0 ? (
          <EmptyState title="No revenue yet" hint="Your best earning cars will be ranked here as bookings come in." />
        ) : (
          <div className="rp-hbars">
            {data.topVehicles.map((v) => (
              <div className="rp-hbar" key={v.plate}>
                <span className="rp-hbar__label"><b>{v.plate}</b> <small className="muted">{v.name}</small></span>
                <span className="rp-hbar__track"><span className="rp-hbar__fill" style={{ width: `${(v.cents / maxVeh) * 100}%` }} /></span>
                <span className="rp-hbar__val">{fmt(v.cents)} <small className="muted">· {v.rentals}</small></span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
