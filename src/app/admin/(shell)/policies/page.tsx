"use client";

import { useEffect, useState } from "react";
import { apiGet, api, type ApiError } from "../../client";

type PolicyType = "rental_terms" | "cancellation" | "privacy";
interface Overview {
  type: PolicyType;
  latest: { version: number; body: string; publishedAt: string | null } | null;
  versionCount: number;
}

const LABELS: Record<PolicyType, string> = {
  rental_terms: "Rental terms",
  cancellation: "Cancellation & refund",
  privacy: "Privacy policy",
};

export default function PoliciesPage() {
  const [items, setItems] = useState<Overview[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<Record<string, string>>({});

  async function load() {
    const data = await apiGet<Overview[]>("/api/admin/policies");
    setItems(data);
    setDrafts(Object.fromEntries(data.map((d) => [d.type, d.latest?.body ?? ""])));
  }
  useEffect(() => { void load(); }, []);

  async function publish(type: PolicyType) {
    setMsg((m) => ({ ...m, [type]: "" }));
    try {
      await api("/api/admin/policies", { type, body: drafts[type] ?? "" });
      setMsg((m) => ({ ...m, [type]: "Published a new version." }));
      await load();
    } catch (err) {
      setMsg((m) => ({ ...m, [type]: (err as ApiError).message }));
    }
  }

  return (
    <>
      <h1>Policies</h1>
      <p className="sub">Each save publishes a new immutable version. Older versions are kept; bookings record the version the customer accepted.</p>
      {items.map((p) => (
        <div className="panel" key={p.type}>
          <h2>
            {LABELS[p.type]}
            <span className="v">
              {p.latest ? `v${p.latest.version}` : "not published"}
              {p.versionCount > 0 ? ` · ${p.versionCount} version${p.versionCount > 1 ? "s" : ""}` : ""}
            </span>
          </h2>
          <div className="form-grid">
            <label className="full">Body (Markdown)
              <textarea value={drafts[p.type] ?? ""} onChange={(e) => setDrafts((d) => ({ ...d, [p.type]: e.target.value }))} />
            </label>
          </div>
          <div className="actions">
            <button className="btn" onClick={() => publish(p.type)}>Publish new version</button>
            <span className="muted">{msg[p.type]}</span>
          </div>
        </div>
      ))}
    </>
  );
}
