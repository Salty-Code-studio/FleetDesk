"use client";

import { useEffect, useMemo, useState } from "react";
import { apiGet } from "../../client";
import { Skeleton, EmptyState } from "@/app/admin/_ui";
import { Select } from "@/components/ui";
import "./audit.css";

interface AuditRow {
  id: string; actor: string; actorLabel: string; action: string; entity: string;
  entityId: string | null; ip: string | null; createdAt: string;
}

export default function AuditPage() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [actionFilter, setActionFilter] = useState("");

  useEffect(() => {
    apiGet<AuditRow[]>("/api/admin/audit?limit=100").then(setRows).finally(() => setLoading(false));
  }, []);

  const actor = (r: AuditRow) =>
    r.actorLabel !== r.actor ? r.actorLabel :
    r.actor === "anonymous" || r.actor === "system" ? r.actor : r.actor.slice(0, 8);

  // Distinct actions in the loaded set, for the filter dropdown. Purely a view
  // of the data already fetched; no extra API call.
  const actions = useMemo(
    () => Array.from(new Set(rows.map((r) => r.action))).sort(),
    [rows],
  );

  // Client-side filtering over the already-loaded rows. The API call is
  // unchanged; this only narrows what is shown.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (actionFilter && r.action !== actionFilter) return false;
      if (!q) return true;
      return (
        r.actor.toLowerCase().includes(q) ||
        r.actorLabel.toLowerCase().includes(q) ||
        r.action.toLowerCase().includes(q) ||
        r.entity.toLowerCase().includes(q) ||
        (r.entityId ?? "").toLowerCase().includes(q) ||
        (r.ip ?? "").toLowerCase().includes(q)
      );
    });
  }, [rows, query, actionFilter]);

  const filtering = query.trim() !== "" || actionFilter !== "";

  return (
    <>
      <header className="audit-head">
        <div className="audit-head__lead">
          <h1>Audit log</h1>
          <p className="sub">Every admin action, newest first. Read-only.</p>
        </div>
      </header>

      <div className="panel">
        <div className="audit-panel-head">
          <h2>Activity</h2>
          <div className="audit-panel-head__right">
            {!loading && rows.length > 0 && (
              <span className="audit-count">
                {filtering ? `${visible.length} of ${rows.length}` : `${rows.length} entries`}
              </span>
            )}
            <div className="audit-filters">
              <input
                type="search"
                className="audit-search"
                placeholder="Search actor, action, entity"
                aria-label="Search audit entries"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                disabled={loading || rows.length === 0}
              />
              <Select
                ariaLabel="Filter by action"
                value={actionFilter}
                onChange={setActionFilter}
                options={actions.map((a) => ({ value: a, label: a }))}
                placeholder="All actions"
                disabled={loading || rows.length === 0}
              />
            </div>
          </div>
        </div>

        {loading ? (
          <table className="grid audit-grid" aria-busy="true">
            <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th></tr></thead>
            <tbody>
              {Array.from({ length: 6 }).map((_, r) => (
                <tr key={r}>
                  <td><Skeleton width="78%" /></td>
                  <td><Skeleton width="55%" /></td>
                  <td><Skeleton width={88} radius={6} /></td>
                  <td><Skeleton width="70%" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : rows.length === 0 ? (
          <EmptyState
            title="No entries yet"
            hint="Admin actions show up here as they happen. There is nothing to log so far."
          />
        ) : visible.length === 0 ? (
          <EmptyState
            title="No matching entries"
            hint="No audit entries match your search and filter. Try a different term."
            action={
              <button
                type="button"
                className="btn btn--accent"
                onClick={() => { setQuery(""); setActionFilter(""); }}
              >
                Clear filters
              </button>
            }
          />
        ) : (
          <table className="grid audit-grid">
            <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th></tr></thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.id}>
                  <td className="audit-when">{new Date(r.createdAt).toLocaleString()}</td>
                  <td>
                    <span className="audit-actor">{actor(r)}</span>
                  </td>
                  <td><span className="tag audit-action">{r.action}</span></td>
                  <td>
                    {r.entity}
                    {r.entityId ? <span className="audit-entity-id"> · {r.entityId.slice(0, 12)}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
