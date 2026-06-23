"use client";

import { useEffect, useState } from "react";
import { apiGet, type ApiError } from "../../client";

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

  useEffect(() => {
    apiGet<Reports>("/api/admin/reports").then(setData).catch((e) => setErr((e as ApiError).message));
  }, []);

  if (err) return (<><h1>Reports</h1><p className="sub" style={{ color: "#c81e1e" }}>{err}</p></>);
  if (!data) return (<><h1>Reports</h1><p className="muted">Crunching the numbers…</p></>);

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
            <p className="muted">No revenue recorded yet.</p>
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
          {data.revenueByClass.length === 0 ? <p className="muted">No revenue recorded yet.</p> : (
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
        {data.topVehicles.length === 0 ? <p className="muted">No revenue recorded yet.</p> : (
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
