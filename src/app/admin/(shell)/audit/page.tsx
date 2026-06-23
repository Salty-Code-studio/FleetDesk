"use client";

import { useEffect, useState } from "react";
import { apiGet } from "../../client";

interface AuditRow {
  id: string; actor: string; action: string; entity: string;
  entityId: string | null; ip: string | null; createdAt: string;
}

export default function AuditPage() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiGet<AuditRow[]>("/api/admin/audit?limit=100").then(setRows).finally(() => setLoading(false));
  }, []);

  return (
    <>
      <h1>Audit log</h1>
      <p className="sub">Every admin action, newest first. Read-only.</p>
      <div className="panel">
        <table className="grid">
          <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th></tr></thead>
          <tbody>
            {loading && <tr><td colSpan={4} className="muted">Loading…</td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan={4} className="muted">No entries yet.</td></tr>}
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{new Date(r.createdAt).toLocaleString()}</td>
                <td>{r.actor === "anonymous" || r.actor === "system" ? r.actor : r.actor.slice(0, 8)}</td>
                <td>{r.action}</td>
                <td>{r.entity}{r.entityId ? ` · ${r.entityId.slice(0, 12)}` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
