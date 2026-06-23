"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { apiGet, api, apiPatch, apiDelete, type ApiError } from "../client";

interface Bar { id: string; start: string; end: string; status: string; source: string; label: string; notes: string | null }
interface Block { id: string; start: string; end: string; type: string; reason: string }
interface Vehicle { id: string; name: string; slug: string; plate: string; class: string; bookings: Bar[]; blocks: Block[] }
interface Category { class: string; vehicles: Vehicle[] }
interface Planning {
  from: string; to: string; days: string[];
  categories: Category[];
  blackouts: { id: string; start: string; end: string; reason: string }[];
}

const DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const BLOCK_TYPES = ["maintenance", "carwash", "cleaning", "out_of_service", "other"];
const dayIdx = (from: string, d: string) => Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
const isWeekend = (d: string) => { const g = new Date(`${d}T00:00:00Z`).getUTCDay(); return g === 0 || g === 6; };
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const niceType = (t: string) => t.replace(/_/g, " ");

// In-flight pointer gesture. Kept in a ref so pointermove/up never depend on React state timing.
type Gesture =
  | { kind: "select"; vehicleId: string; plate: string; name: string; anchorDay: number; moved: boolean; startX: number; startY: number }
  | { kind: "move"; bookingId: string; originVehicleId: string; origStart: string; lenDays: number; grabDay: number; moved: boolean; startX: number; startY: number };

type Popover =
  | { kind: "create"; vehicleId: string; plate: string; name: string; startDate: string; endDate: string; x: number; y: number }
  | { kind: "booking"; bar: Bar; vehicleId: string; x: number; y: number }
  | { kind: "block"; block: Block; x: number; y: number };

export default function AdminDashboard() {
  const [data, setData] = useState<Planning | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");
  const [popover, setPopover] = useState<Popover | null>(null);
  const [showService, setShowService] = useState(false);
  // live drag previews (re-rendered): a selection rectangle, or a moving booking ghost
  const [sel, setSel] = useState<{ vehicleId: string; startDate: string; endDate: string } | null>(null);
  const [moveCand, setMoveCand] = useState<{ bookingId: string; vehicleId: string; startDate: string; endDate: string } | null>(null);

  const today = useMemo(() => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Aruba" }).format(new Date()), []);
  const gestureRef = useRef<Gesture | null>(null);
  const trackRectRef = useRef<DOMRect | null>(null);

  async function load(f?: string, t?: string) {
    setLoading(true);
    const qs = f && t ? `?from=${f}&to=${t}` : "";
    try {
      const d = await apiGet<Planning>(`/api/admin/planning${qs}`);
      setData(d); setFrom(d.from); setTo(d.to);
    } catch (e) { setMsg((e as ApiError).message); }
    setLoading(false);
  }
  useEffect(() => { void load(); }, []);

  const N = data?.days.length ?? 0;
  const flatVehicles = useMemo(() => data ? data.categories.flatMap((c) => c.vehicles) : [], [data]);

  // Place a [start,end) range into the track as % left/width. Returns null if fully outside view.
  const span = (start: string, end: string) => {
    if (!data) return null;
    const s = Math.max(0, dayIdx(data.from, start));
    const e = Math.min(N, dayIdx(data.from, end));
    if (e <= s) return null;
    return { left: `${(s / N) * 100}%`, width: `${((e - s) / N) * 100}%` };
  };

  function dayAt(clientX: number): number {
    const r = trackRectRef.current;
    if (!r || N === 0) return 0;
    return Math.max(0, Math.min(N - 1, Math.floor(((clientX - r.left) / r.width) * N)));
  }
  function vehicleAt(clientX: number, clientY: number): string | null {
    const el = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-vehicle]");
    return el?.dataset.vehicle ?? null;
  }

  // ----- pointer gesture wiring -----
  function beginGesture(e: ReactPointerEvent, trackEl: HTMLElement, g: Gesture) {
    trackRectRef.current = trackEl.getBoundingClientRect();
    gestureRef.current = g;
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
    const onMove = (ev: PointerEvent) => handleMove(ev);
    const onUp = (ev: PointerEvent) => { cleanup(); handleUp(ev); };
    // If the browser steals the gesture (scroll/pan takeover, multi-touch, app
    // switch) a pointercancel fires instead of pointerup. Without this the move
    // listener would leak and gestureRef would stay stuck-truthy, freezing clicks.
    const onCancel = () => { cleanup(); gestureRef.current = null; setSel(null); setMoveCand(null); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  }

  function handleMove(ev: PointerEvent) {
    const g = gestureRef.current;
    if (!g) return;
    if (!g.moved) {
      if (Math.abs(ev.clientX - g.startX) < 4 && Math.abs(ev.clientY - g.startY) < 4) return;
      g.moved = true;
    }
    const cur = dayAt(ev.clientX);
    if (g.kind === "select") {
      const s = Math.min(g.anchorDay, cur);
      const eDay = Math.max(g.anchorDay, cur) + 1;
      setSel({ vehicleId: g.vehicleId, startDate: addDays(from, s), endDate: addDays(from, eDay) });
    } else {
      const startIdx = dayIdx(from, g.origStart) + (cur - g.grabDay);
      const newStart = addDays(from, startIdx);
      const veh = vehicleAt(ev.clientX, ev.clientY) ?? g.originVehicleId;
      setMoveCand({ bookingId: g.bookingId, vehicleId: veh, startDate: newStart, endDate: addDays(newStart, g.lenDays) });
    }
  }

  async function handleUp(ev: PointerEvent) {
    const g = gestureRef.current;
    gestureRef.current = null;
    if (!g) return;
    if (g.kind === "select") {
      const anchor = g.anchorDay;
      const cur = g.moved ? dayAt(ev.clientX) : anchor;
      const s = Math.min(anchor, cur);
      const eDay = Math.max(anchor, cur) + 1;
      setSel(null);
      setPopover({ kind: "create", vehicleId: g.vehicleId, plate: g.plate, name: g.name, startDate: addDays(from, s), endDate: addDays(from, eDay), x: ev.clientX, y: ev.clientY });
    } else {
      setMoveCand(null);
      if (!g.moved) return; // a plain click is handled by the bar's onClick (detail popover)
      // Recompute the drop position from the gesture ref + this event — NOT from
      // the moveCand React state, which is stale-null inside the pointer-down
      // closure that registered this listener (the ghost state never reaches here).
      const cur = dayAt(ev.clientX);
      const newStart = addDays(from, dayIdx(from, g.origStart) + (cur - g.grabDay));
      const newEnd = addDays(newStart, g.lenDays);
      const veh = vehicleAt(ev.clientX, ev.clientY) ?? g.originVehicleId;
      if (veh === g.originVehicleId && newStart === g.origStart) return; // unchanged → no-op
      const body: Record<string, string> = { startDate: newStart, endDate: newEnd };
      if (veh !== g.originVehicleId) body.vehicleId = veh;
      try {
        await apiPatch(`/api/admin/bookings/${g.bookingId}/move`, body);
        setMsg("Moved.");
        await load(from, to);
      } catch (e) {
        setMsg((e as ApiError).message); // 409 → "Those dates overlap…"; board reloads to the true state
        await load(from, to);
      }
    }
  }

  function onBarPointerDown(e: ReactPointerEvent, v: Vehicle, b: Bar) {
    if (e.button !== 0 || b.status === "completed") return;
    e.stopPropagation();
    const track = (e.currentTarget as HTMLElement).closest<HTMLElement>(".pl-track");
    if (!track) return;
    trackRectRef.current = track.getBoundingClientRect();
    if (e.pointerType === "touch") return; // touch falls back to the click → detail/move form
    beginGesture(e, track, {
      kind: "move", bookingId: b.id, originVehicleId: v.id, origStart: b.start,
      lenDays: dayIdx(from, b.end) - dayIdx(from, b.start), grabDay: dayAt(e.clientX),
      moved: false, startX: e.clientX, startY: e.clientY,
    });
  }

  function onTrackPointerDown(e: ReactPointerEvent, v: Vehicle) {
    if (e.button !== 0) return;
    const track = e.currentTarget as HTMLElement;
    trackRectRef.current = track.getBoundingClientRect();
    beginGesture(e, track, {
      kind: "select", vehicleId: v.id, plate: v.plate, name: v.name,
      anchorDay: dayAt(e.clientX), moved: false, startX: e.clientX, startY: e.clientY,
    });
  }

  const stats = useMemo(() => {
    if (!data) return { vehicles: 0, bookings: 0, confirmed: 0, pending: 0 };
    let vehicles = 0, bookings = 0, confirmed = 0, pending = 0;
    for (const c of data.categories) for (const v of c.vehicles) {
      vehicles++;
      for (const b of v.bookings) { bookings++; if (b.status === "confirmed") confirmed++; if (b.status === "pending") pending++; }
    }
    return { vehicles, bookings, confirmed, pending };
  }, [data]);

  return (
    <>
      <h1>Planning board</h1>
      <p className="sub">Drag an empty stretch to add a rental or block. Drag a booking to move its dates or drop it on another car. Click a booking to see details or cancel.</p>

      <div className="stat-strip">
        <div className="s"><b>{stats.vehicles}</b><span>active vehicles</span></div>
        <div className="s"><b>{stats.bookings}</b><span>bookings in view</span></div>
        <div className="s"><b>{stats.confirmed}</b><span>confirmed</span></div>
        <div className="s"><b>{stats.pending}</b><span>awaiting payment</span></div>
      </div>

      <div className="pl-toolbar">
        <label>From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button className="btn" onClick={() => load(from, to)}>Apply</button>
        <button className="btn btn--quiet" onClick={() => load(today, addDays(today, 13))}>Next 2 weeks</button>
        <button className="btn btn--quiet" onClick={() => load(today, addDays(today, 29))}>Next month</button>
        <button className="btn btn--quiet" onClick={() => data && load(addDays(data.from, -7), addDays(data.to, -7))}>◀ back</button>
        <button className="btn btn--quiet" onClick={() => data && load(addDays(data.from, 7), addDays(data.to, 7))}>forward ▶</button>
        <button className="btn btn--service" onClick={() => setShowService(true)}>+ Schedule service</button>
        {msg && <span className="pl-msg" role="status">{msg}</span>}
        <div className="pl-legend">
          <span><i className="pl-swatch" style={{ background: "#2348c7" }} /> confirmed</span>
          <span><i className="pl-swatch" style={{ background: "#f6a609" }} /> pending</span>
          <span><i className="pl-swatch" style={{ background: "#0f7b4d" }} /> completed</span>
          <span><i className="pl-swatch" style={{ background: "#9aa2c0" }} /> blocked</span>
        </div>
      </div>

      {loading || !data ? <p className="muted">Loading the fleet…</p> : (
        <div className="pl-wrap">
          <div className="pl">
            <div className="pl-head">
              <div className="pl-corner">Vehicle</div>
              <div className="pl-days">
                {data.days.map((d) => (
                  <div key={d} className={`pl-day ${isWeekend(d) ? "weekend" : ""} ${d === today ? "today" : ""}`}>
                    <div className="dow">{DOW[new Date(`${d}T00:00:00Z`).getUTCDay()]}</div>
                    <div className="dnum">{Number(d.slice(8, 10))}</div>
                  </div>
                ))}
              </div>
            </div>

            {data.categories.length === 0 && <div className="pl-empty">No vehicles yet. Add some under Fleet &amp; pricing.</div>}
            {data.categories.map((cat) => (
              <div key={cat.class}>
                <div className="pl-cat">{cat.class}</div>
                {cat.vehicles.map((v) => (
                  <div className="pl-row" key={v.id}>
                    <div className="pl-label"><b>{v.plate}</b><small>{v.name}</small></div>
                    <div
                      className="pl-track"
                      data-vehicle={v.id}
                      onPointerDown={(e) => onTrackPointerDown(e, v)}
                    >
                      <div className="pl-cells">
                        {data.days.map((d) => <div key={d} className={`c ${isWeekend(d) ? "weekend" : ""} ${d === today ? "today" : ""}`} />)}
                      </div>
                      {data.blackouts.map((bo) => {
                        const s = span(bo.start, bo.end);
                        return s ? <div key={`bo-${v.id}-${bo.id}`} className="pl-blackout" style={s} title={bo.reason} /> : null;
                      })}
                      {v.blocks.map((bl) => {
                        const s = span(bl.start, bl.end);
                        return s ? (
                          <div key={bl.id} className={`pl-block pl-block--${bl.type}`} style={s} title={`${niceType(bl.type)}${bl.reason ? " · " + bl.reason : ""}`}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => setPopover({ kind: "block", block: bl, x: e.clientX, y: e.clientY })}>
                            {niceType(bl.type)}
                          </div>
                        ) : null;
                      })}
                      {v.bookings.map((b) => {
                        const dimmed = moveCand?.bookingId === b.id;
                        const s = span(b.start, b.end);
                        return s ? (
                          <div key={b.id} className={`pl-bar ${b.status} ${dimmed ? "dragging" : ""} ${b.source === "manual" ? "manual" : ""}`} style={s}
                            title={`${b.label} · ${b.start} to ${b.end} · ${b.status}${b.source === "manual" ? " · manual" : ""}`}
                            onPointerDown={(e) => onBarPointerDown(e, v, b)}
                            onClick={(e) => { if (!gestureRef.current) setPopover({ kind: "booking", bar: b, vehicleId: v.id, x: e.clientX, y: e.clientY }); }}>
                            {b.label}
                          </div>
                        ) : null;
                      })}
                      {/* live selection preview */}
                      {sel?.vehicleId === v.id && (() => { const s = span(sel.startDate, sel.endDate); return s ? <div className="pl-select" style={s} /> : null; })()}
                      {/* live move ghost */}
                      {moveCand?.vehicleId === v.id && (() => { const s = span(moveCand.startDate, moveCand.endDate); return s ? <div className="pl-ghost" style={s} /> : null; })()}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {popover && (
        <BoardPopover
          popover={popover}
          vehicles={flatVehicles}
          onClose={() => setPopover(null)}
          onDone={async (m) => { setPopover(null); if (m) setMsg(m); await load(from, to); }}
          onError={(m) => setMsg(m)}
        />
      )}

      {showService && (
        <ServiceModal
          vehicles={flatVehicles}
          defaultDate={today}
          onClose={() => setShowService(false)}
          onDone={async (m) => { setShowService(false); if (m) setMsg(m); await load(from, to); }}
          onError={(m) => setMsg(m)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function BoardPopover({ popover, vehicles, onClose, onDone, onError }: {
  popover: Popover;
  vehicles: Vehicle[];
  onClose: () => void;
  onDone: (msg?: string) => Promise<void> | void;
  onError: (msg: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Position the popover near the click, but keep it FULLY on screen: clamp
  // horizontally, and flip it above the anchor when it would run off the bottom
  // (the bug in the screenshot — the form's submit button was below the fold).
  // A ResizeObserver re-places it when the form grows (e.g. choosing "New
  // rental" reveals more fields), and the CSS caps height + scrolls if needed.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => {
      const m = 12;
      const r = el.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      const left = Math.max(m, Math.min(popover.x, vw - r.width - m));
      let top = popover.y + 8;
      if (top + r.height > vh - m) {
        const above = popover.y - r.height - 8;
        top = above >= m ? above : Math.max(m, vh - r.height - m);
      }
      setPos({ left, top });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [popover.x, popover.y, popover.kind]);

  const style: React.CSSProperties = pos
    ? { position: "fixed", left: pos.left, top: pos.top }
    : { position: "fixed", left: popover.x, top: popover.y + 8, visibility: "hidden" };
  return (
    <>
      <div className="pl-backdrop" onClick={onClose} />
      <div ref={ref} className="pl-pop" style={style} role="dialog">
        {popover.kind === "create" && <CreatePanel p={popover} onDone={onDone} onError={onError} onClose={onClose} />}
        {popover.kind === "booking" && <BookingPanel p={popover} vehicles={vehicles} onDone={onDone} onError={onError} onClose={onClose} />}
        {popover.kind === "block" && <BlockPanel p={popover} onDone={onDone} onError={onError} />}
      </div>
    </>
  );
}

function CreatePanel({ p, onDone, onError, onClose }: {
  p: Extract<Popover, { kind: "create" }>;
  onDone: (msg?: string) => Promise<void> | void;
  onError: (msg: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"choose" | "rental" | "block">("choose");
  const [busy, setBusy] = useState(false);
  const [r, setR] = useState({ name: "", phone: "", email: "", price: "", notes: "" });
  const [b, setB] = useState({ type: "maintenance", reason: "" });
  const range = `${p.startDate} → ${p.endDate} (return)`;

  async function submitRental(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    try {
      await api("/api/admin/bookings", {
        vehicleId: p.vehicleId, startDate: p.startDate, endDate: p.endDate,
        customerName: r.name, customerPhone: r.phone,
        ...(r.email ? { customerEmail: r.email } : {}),
        ...(r.price ? { priceCents: Math.round(Number(r.price) * 100) } : {}),
        ...(r.notes ? { notes: r.notes } : {}),
      });
      await onDone("Rental added.");
    } catch (err) { onError((err as ApiError).message); setBusy(false); }
  }
  async function submitBlock(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    try {
      await api(`/api/admin/vehicles/${p.vehicleId}/blocks`, { startDate: p.startDate, endDate: p.endDate, type: b.type, reason: b.reason });
      await onDone("Car blocked.");
    } catch (err) { onError((err as ApiError).message); setBusy(false); }
  }

  return (
    <div>
      <div className="pl-pop-head"><b>{p.plate}</b> <small>{p.name}</small><span className="pl-pop-range">{range}</span></div>
      {tab === "choose" && (
        <div className="pl-pop-actions">
          <button className="btn" onClick={() => setTab("rental")}>New rental</button>
          <button className="btn btn--quiet" onClick={() => setTab("block")}>Block car</button>
          <button className="btn btn--quiet" onClick={onClose}>Cancel</button>
        </div>
      )}
      {tab === "rental" && (
        <form className="pl-form" onSubmit={submitRental}>
          <label>Customer name<input required autoFocus value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} /></label>
          <label>Phone<input value={r.phone} onChange={(e) => setR({ ...r, phone: e.target.value })} placeholder="+297 …" /></label>
          <label>Email (optional)<input type="email" value={r.email} onChange={(e) => setR({ ...r, email: e.target.value })} /></label>
          <label>Price (USD, optional)<input type="number" step="0.01" min="0" value={r.price} onChange={(e) => setR({ ...r, price: e.target.value })} /></label>
          <label>Note (optional)<input value={r.notes} onChange={(e) => setR({ ...r, notes: e.target.value })} placeholder="paid cash at desk" /></label>
          <div className="pl-pop-actions">
            <button className="btn" disabled={busy}>{busy ? "Saving…" : "Add rental"}</button>
            <button type="button" className="btn btn--quiet" onClick={() => setTab("choose")}>Back</button>
          </div>
        </form>
      )}
      {tab === "block" && (
        <form className="pl-form" onSubmit={submitBlock}>
          <label>Type<select value={b.type} onChange={(e) => setB({ ...b, type: e.target.value })}>{BLOCK_TYPES.map((t) => <option key={t} value={t}>{niceType(t)}</option>)}</select></label>
          <label>Note (optional)<input value={b.reason} onChange={(e) => setB({ ...b, reason: e.target.value })} /></label>
          <div className="pl-pop-actions">
            <button className="btn" disabled={busy}>{busy ? "Saving…" : "Block car"}</button>
            <button type="button" className="btn btn--quiet" onClick={() => setTab("choose")}>Back</button>
          </div>
        </form>
      )}
    </div>
  );
}

function BookingPanel({ p, vehicles, onDone, onError, onClose }: {
  p: Extract<Popover, { kind: "booking" }>;
  vehicles: Vehicle[];
  onDone: (msg?: string) => Promise<void> | void;
  onError: (msg: string) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [mv, setMv] = useState({ vehicleId: p.vehicleId, startDate: p.bar.start, endDate: p.bar.end });
  const [showMove, setShowMove] = useState(false);

  async function cancel() {
    if (busy) return; setBusy(true);
    try { await api(`/api/admin/bookings/${p.bar.id}/cancel`, {}); await onDone("Booking cancelled."); }
    catch (err) { onError((err as ApiError).message); setBusy(false); }
  }
  async function move(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    try {
      await apiPatch(`/api/admin/bookings/${p.bar.id}/move`, { vehicleId: mv.vehicleId, startDate: mv.startDate, endDate: mv.endDate });
      await onDone("Moved.");
    } catch (err) { onError((err as ApiError).message); setBusy(false); }
  }

  return (
    <div>
      <div className="pl-pop-head"><b>{p.bar.label}</b><span className="pl-pop-range">{p.bar.start} → {p.bar.end} · {p.bar.status}{p.bar.source === "manual" ? " · manual" : ""}</span></div>
      {p.bar.notes && <p className="pl-pop-note">{p.bar.notes}</p>}
      {!showMove ? (
        <div className="pl-pop-actions">
          <button className="btn btn--quiet" onClick={() => setShowMove(true)}>Move…</button>
          {(p.bar.status === "pending" || p.bar.status === "confirmed") && <button className="btn danger" disabled={busy} onClick={cancel}>Cancel rental</button>}
          <button className="btn btn--quiet" onClick={onClose}>Close</button>
        </div>
      ) : (
        <form className="pl-form" onSubmit={move}>
          <label>Car<select value={mv.vehicleId} onChange={(e) => setMv({ ...mv, vehicleId: e.target.value })}>{vehicles.map((v) => <option key={v.id} value={v.id}>{v.plate} — {v.name}</option>)}</select></label>
          <label>Pick-up<input type="date" required value={mv.startDate} onChange={(e) => setMv({ ...mv, startDate: e.target.value })} /></label>
          <label>Return<input type="date" required value={mv.endDate} onChange={(e) => setMv({ ...mv, endDate: e.target.value })} /></label>
          <div className="pl-pop-actions">
            <button className="btn" disabled={busy}>{busy ? "Saving…" : "Save move"}</button>
            <button type="button" className="btn btn--quiet" onClick={() => setShowMove(false)}>Back</button>
          </div>
        </form>
      )}
    </div>
  );
}

function BlockPanel({ p, onDone, onError }: {
  p: Extract<Popover, { kind: "block" }>;
  onDone: (msg?: string) => Promise<void> | void;
  onError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  async function remove() {
    if (busy) return; setBusy(true);
    try { await apiDelete(`/api/admin/blocks/${p.block.id}`); await onDone("Block removed."); }
    catch (err) { onError((err as ApiError).message); setBusy(false); }
  }
  return (
    <div>
      <div className="pl-pop-head"><b>{niceType(p.block.type)}</b><span className="pl-pop-range">{p.block.start} → {p.block.end}</span></div>
      {p.block.reason && <p className="pl-pop-note">{p.block.reason}</p>}
      <div className="pl-pop-actions">
        <button className="btn danger" disabled={busy} onClick={remove}>Remove block</button>
      </div>
    </div>
  );
}

// Button-driven way to take a car off the road for a carwash, maintenance,
// cleaning or out-of-service window — no calendar dragging required. Writes the
// same availability block the drag flow does, so it shows on the board instantly.
function ServiceModal({ vehicles, defaultDate, onClose, onDone, onError }: {
  vehicles: Vehicle[];
  defaultDate: string;
  onClose: () => void;
  onDone: (msg?: string) => Promise<void> | void;
  onError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({
    vehicleId: vehicles[0]?.id ?? "",
    type: "maintenance",
    startDate: defaultDate,
    endDate: addDays(defaultDate, 1),
    reason: "",
  });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!f.vehicleId) { onError("Add a vehicle first."); return; }
    if (f.endDate <= f.startDate) { onError("The 'until' date must be after the start date."); return; }
    setBusy(true);
    try {
      await api(`/api/admin/vehicles/${f.vehicleId}/blocks`, {
        startDate: f.startDate, endDate: f.endDate, type: f.type, reason: f.reason,
      });
      await onDone("Service scheduled.");
    } catch (err) { onError((err as ApiError).message); setBusy(false); }
  }

  return (
    <>
      <div className="pl-backdrop" onClick={onClose} />
      <div className="pl-modal" role="dialog">
        <div className="pl-pop-head"><b>Schedule service</b><span className="pl-pop-range">Carwash, maintenance, cleaning or out of service</span></div>
        <form className="pl-form" onSubmit={submit}>
          <label>Car<select required value={f.vehicleId} onChange={(e) => setF({ ...f, vehicleId: e.target.value })}>
            {vehicles.length === 0 && <option value="">No cars yet</option>}
            {vehicles.map((v) => <option key={v.id} value={v.id}>{v.plate} — {v.name}</option>)}
          </select></label>
          <label>Type<select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{BLOCK_TYPES.map((t) => <option key={t} value={t}>{niceType(t)}</option>)}</select></label>
          <label>From<input type="date" required value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></label>
          <label>Until<input type="date" required value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></label>
          <label>Note (optional)<input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="e.g. brake service at AutoFix" /></label>
          <div className="pl-pop-actions">
            <button className="btn" disabled={busy}>{busy ? "Saving…" : "Schedule"}</button>
            <button type="button" className="btn btn--quiet" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </div>
    </>
  );
}
