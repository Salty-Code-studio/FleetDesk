"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, api } from "../client";

interface Notif {
  id: string; level: "info" | "success" | "warning" | "critical";
  type: string; title: string; body: string; bookingId: string | null;
  readAt: string | null; createdAt: string;
}
interface Feed { notifications: Notif[]; unread: number }

export function NotificationBell() {
  const [feed, setFeed] = useState<Feed>({ notifications: [], unread: 0 });
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try { setFeed(await apiGet<Feed>("/api/admin/notifications")); } catch { /* transient — keep last */ }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000); // light poll; no realtime infra yet
    return () => clearInterval(t);
  }, [load]);

  async function markAll() {
    try { await api("/api/admin/notifications/read", {}); await load(); } catch { /* ignore */ }
  }

  return (
    <div className="nbell">
      <button className="nbell__btn" onClick={() => setOpen((o) => !o)} aria-label="Notifications" aria-expanded={open}>
        <span aria-hidden>🔔</span>
        {feed.unread > 0 && <span className="nbell__badge">{feed.unread > 99 ? "99+" : feed.unread}</span>}
      </button>
      {open && (
        <div className="nbell__panel" role="dialog" aria-label="Notifications">
          <div className="nbell__head">
            <strong>Notifications</strong>
            {feed.unread > 0 && <button className="nbell__mark" onClick={markAll}>Mark all read</button>}
          </div>
          {feed.notifications.length === 0 && <div className="nbell__empty">Nothing yet.</div>}
          {feed.notifications.map((n) => (
            <div key={n.id} className={`nbell__item nbell__item--${n.level}${n.readAt ? "" : " is-unread"}`}>
              <div className="nbell__title">{n.title}</div>
              {n.body && <div className="nbell__body">{n.body}</div>}
              <div className="nbell__time">{new Date(n.createdAt).toLocaleString()}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
