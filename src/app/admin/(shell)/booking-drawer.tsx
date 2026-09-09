"use client";

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { apiGet, api, apiPatch, type ApiError } from "../client";
import { Drawer, Modal, useToast, SkeletonRows } from "@/app/admin/_ui";
import { DatePicker, MoneyInput, Select, TimeSelect } from "@/components/ui";
import { formatDateTime, atAruba, arubaDateOf, arubaTimeOf, arubaNowIso, parseTs } from "@/lib/time/format";
import { InspectionPanel } from "./inspection-panel";
import type { BookingDetail, BookingDetailPayment } from "@/lib/admin/booking-detail";
import "./booking-drawer.css";

interface VehicleOption { id: string; plate: string; name: string; class?: string; status?: string }

const BLOCK_TYPES = ["maintenance", "out_of_service", "carwash", "cleaning", "other"];
const niceType = (t: string) => t.replace(/_/g, " ");

export interface BookingDrawerProps {
  bookingId: string | null;
  onClose: () => void;
  /** Re-fetch planning data after any mutation (move, cancel, refund). */
  onChanged: () => void;
  /** Extension point: renders after Payments, before Actions. Wave 06 injects
   *  Checklist + Inspections here. Defaults to nothing. */
  extraSections?: ReactNode;
}

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  confirmed: "Confirmed",
  picked_up: "With customer",
  cancelled: "Cancelled",
  completed: "Completed",
};
const TYPE_LABEL: Record<string, string> = {
  reservation_fee: "Reservation fee",
  deposit: "Deposit",
  rental_deposit: "Deposit",
  rental_full: "Full rental",
  extension: "Extension",
};
const money = (c: number) => `$${(c / 100).toFixed(2)}`;

/**
 * The one-click booking surface: click a bar on the planning board, get
 * everything about that rental in one panel — who, what, when, what's been
 * paid, what's still owed, and the actions the desk needs (move, extend,
 * cancel). Fetches its own detail from GET /api/admin/bookings/:id and its
 * own vehicle list (for Move) so the parent board only has to pass an id.
 */
export function BookingDrawer({ bookingId, onClose, onChanged, extraSections = null }: BookingDrawerProps) {
  const [detail, setDetail] = useState<BookingDetail | null>(null);
  const [loading, setLoading] = useState(false);

  const [showMove, setShowMove] = useState(false);
  const [moveBusy, setMoveBusy] = useState(false);
  const [vehicles, setVehicles] = useState<VehicleOption[]>([]);
  const [mv, setMv] = useState({ vehicleId: "", startDate: "", startTime: "09:00", endDate: "", endTime: "09:00" });

  const [refundFor, setRefundFor] = useState<BookingDetailPayment | null>(null);
  const [refundCents, setRefundCents] = useState<number | null>(null);
  const [refundBusy, setRefundBusy] = useState(false);

  const [showCancel, setShowCancel] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState(false);

  const [paidUntilDraft, setPaidUntilDraft] = useState("");
  const [paidUntilBusy, setPaidUntilBusy] = useState(false);
  const [payBusy, setPayBusy] = useState(false);
  const [showOtherAmount, setShowOtherAmount] = useState(false);
  const [otherAmountCents, setOtherAmountCents] = useState<number | null>(null);

  const [showExtend, setShowExtend] = useState(false);
  const [exBusy, setExBusy] = useState(false);
  const [ex, setEx] = useState({ endDate: "", endTime: "09:00" });
  const [exDelta, setExDelta] = useState<number | null>(null);
  const [exPreviewBusy, setExPreviewBusy] = useState(false);
  const [exPreviewError, setExPreviewError] = useState<string | null>(null);
  const [exLinkUrl, setExLinkUrl] = useState<string | null>(null);
  const [exCopied, setExCopied] = useState(false);

  // Breakdown swap: reassign the car (keeping dates + price), then offer to take
  // the broken car off the road for repair.
  const [showSwap, setShowSwap] = useState(false);
  const [swapBusy, setSwapBusy] = useState(false);
  const [swapVehicleId, setSwapVehicleId] = useState("");
  const [swapAdvisory, setSwapAdvisory] = useState<string | null>(null);
  const [repairFor, setRepairFor] = useState<{ vehicleId: string; plate: string } | null>(null);
  const [repair, setRepair] = useState({ type: "maintenance", startDate: "", endDate: "", reason: "" });
  const [repairBusy, setRepairBusy] = useState(false);

  const toast = useToast();

  // Desk vs online, for the Confirm gate below: the confirm route only exists
  // on desk deployments (online bookings are confirmed by the Stripe webhook
  // when payment lands), so only show the button there. One fetch on mount,
  // fail-closed: an unresolved or failed fetch stays "online", which merely
  // hides the button; the route's own desk gate is the real enforcement.
  const [paymentMode, setPaymentMode] = useState<"online" | "desk">("online");
  useEffect(() => {
    apiGet<{ paymentMode?: "online" | "desk" }>("/api/booking-config")
      .then((c) => { if (c?.paymentMode) setPaymentMode(c.paymentMode); })
      .catch(() => { /* stay "online": the Confirm button just stays hidden */ });
  }, []);

  const load = useCallback(async () => {
    if (!bookingId) { setDetail(null); return; }
    setLoading(true);
    try {
      const d = await apiGet<BookingDetail>(`/api/admin/bookings/${bookingId}`);
      setDetail(d);
      setPaidUntilDraft(d.booking.paidUntil ?? "");
    } catch (e) {
      toast.show({ type: "error", message: (e as ApiError).message });
    }
    setLoading(false);
  }, [bookingId, toast]);

  useEffect(() => { void load(); }, [load]);

  // Switching to a different booking (or closing) drops any in-progress
  // sub-panel from the previous one — never carry a stale Move/Refund/Cancel
  // form over to a booking it does not belong to.
  useEffect(() => {
    setShowMove(false);
    setRefundFor(null);
    setShowCancel(false);
    setShowExtend(false);
    setExLinkUrl(null);
    setShowSwap(false);
    setSwapAdvisory(null);
    setRepairFor(null);
    setShowOtherAmount(false);
    setOtherAmountCents(null);
  }, [bookingId]);

  async function openMove() {
    if (!detail) return;
    setMv({
      vehicleId: detail.vehicle.id,
      startDate: arubaDateOf(detail.booking.startAt), startTime: arubaTimeOf(detail.booking.startAt),
      endDate: arubaDateOf(detail.booking.endAt), endTime: arubaTimeOf(detail.booking.endAt),
    });
    setShowMove(true);
    if (vehicles.length === 0) {
      try { setVehicles(await apiGet<VehicleOption[]>("/api/admin/vehicles")); }
      catch (e) { toast.show({ type: "error", message: (e as ApiError).message }); }
    }
  }

  async function submitMove(e: FormEvent) {
    e.preventDefault();
    if (!bookingId) return;
    setMoveBusy(true);
    try {
      await apiPatch(`/api/admin/bookings/${bookingId}/move`, {
        vehicleId: mv.vehicleId,
        startAt: atAruba(mv.startDate, mv.startTime), endAt: atAruba(mv.endDate, mv.endTime),
      });
      toast.show({ type: "success", message: "Moved." });
      setShowMove(false);
      onChanged();
      await load();
    } catch (e) {
      toast.show({ type: "error", message: (e as ApiError).message });
    }
    setMoveBusy(false);
  }

  async function openSwap() {
    if (!detail) return;
    setSwapVehicleId("");
    setSwapAdvisory(null);
    setShowSwap(true);
    if (vehicles.length === 0) {
      try { setVehicles(await apiGet<VehicleOption[]>("/api/admin/vehicles")); }
      catch (e) { toast.show({ type: "error", message: (e as ApiError).message }); }
    }
  }

  async function submitSwap(override: boolean) {
    if (!bookingId || !detail || !swapVehicleId) return;
    // Capture the car being LEFT before the reload swaps `detail` to the new one.
    const brokenCar = { vehicleId: detail.vehicle.id, plate: detail.vehicle.plate };
    setSwapBusy(true);
    try {
      await api(`/api/admin/bookings/${bookingId}/swap-vehicle`, { vehicleId: swapVehicleId, override });
      toast.show({ type: "success", message: "Swapped." });
      setShowSwap(false);
      setSwapAdvisory(null);
      onChanged();
      await load();
      // Ask whether to take the broken car off the road (spec: ask each time).
      setRepair({ type: "maintenance", startDate: arubaDateOf(arubaNowIso()), endDate: "", reason: "" });
      setRepairFor(brokenCar);
    } catch (e) {
      const err = e as ApiError;
      // A soft block/blackout on the target is overridable by the desk; a real
      // clash is not (it never carries this code).
      if (err.code === "advisory_conflict") setSwapAdvisory(err.message);
      else toast.show({ type: "error", message: err.message });
    }
    setSwapBusy(false);
  }

  async function submitRepair() {
    if (!repairFor || !repair.startDate || !repair.endDate) return;
    setRepairBusy(true);
    try {
      await api(`/api/admin/vehicles/${repairFor.vehicleId}/blocks`, {
        startAt: atAruba(repair.startDate, "00:00"),
        endAt: atAruba(repair.endDate, "00:00"),
        type: repair.type, reason: repair.reason,
      });
      toast.show({ type: "success", message: `${repairFor.plate} blocked for repair.` });
      setRepairFor(null);
      onChanged();
    } catch (e) {
      toast.show({ type: "error", message: (e as ApiError).message });
    }
    setRepairBusy(false);
  }

  function openRefund(p: BookingDetailPayment) {
    const remaining = p.amountCents - p.refundedCents;
    setRefundCents(remaining);
    setRefundFor(p);
  }

  async function submitRefund(e: FormEvent) {
    e.preventDefault();
    if (!refundFor || refundCents === null) return;
    setRefundBusy(true);
    try {
      const amountCents = refundCents;
      await api(`/api/admin/payments/${refundFor.id}/refund`, { amountCents });
      toast.show({ type: "success", message: `Refunded ${money(amountCents)}.` });
      setRefundFor(null);
      onChanged();
      await load();
    } catch (e) {
      toast.show({ type: "error", message: (e as ApiError).message });
    }
    setRefundBusy(false);
  }

  // Positive, non-destructive: unlike Cancel, Confirm needs no modal
  // double-check, so it is a plain fetch-and-refresh action on the button
  // itself (same shape as the other actions below, just without a sub-panel).
  async function doConfirm() {
    if (!bookingId) return;
    setConfirmBusy(true);
    try {
      await api(`/api/admin/bookings/${bookingId}/confirm`);
      toast.show({ type: "success", message: "Booking confirmed." });
      onChanged();
      await load();
    } catch (e) {
      toast.show({ type: "error", message: (e as ApiError).message });
    }
    setConfirmBusy(false);
  }

  async function doCancel(refund: boolean) {
    if (!bookingId) return;
    setCancelBusy(true);
    try {
      await api(`/api/admin/bookings/${bookingId}/cancel`, { refund });
      toast.show({ type: "success", message: "Booking cancelled." });
      setShowCancel(false);
      onChanged();
      onClose();
    } catch (e) {
      toast.show({ type: "error", message: (e as ApiError).message });
    }
    setCancelBusy(false);
  }

  function openExtend() {
    if (!detail) return;
    setEx({ endDate: arubaDateOf(detail.booking.endAt), endTime: arubaTimeOf(detail.booking.endAt) });
    setExLinkUrl(null);
    setShowExtend(true);
  }

  const currentEndAt = detail?.booking.endAt;

  // Live delta preview: re-quotes on every date/time change via the extend
  // route's dryRun mode (Task 10), so the desk sees the exact number Stripe
  // (or the desk) will charge before committing to anything.
  useEffect(() => {
    if (!showExtend || !bookingId || !currentEndAt || !ex.endDate) return;
    const endAt = atAruba(ex.endDate, ex.endTime);
    setExDelta(null);
    setExPreviewError(null);
    if (parseTs(endAt) <= parseTs(currentEndAt)) return; // not yet a valid extension; stay quiet
    let cancelled = false;
    setExPreviewBusy(true);
    (async () => {
      try {
        const r = await api<{ deltaCents: number }>(
          `/api/admin/bookings/${bookingId}/extend`,
          { endAt, payment: "desk", dryRun: true },
        );
        if (!cancelled) setExDelta(r.deltaCents);
      } catch (e) {
        if (!cancelled) setExPreviewError((e as ApiError).message);
      }
      if (!cancelled) setExPreviewBusy(false);
    })();
    return () => { cancelled = true; };
  }, [showExtend, bookingId, currentEndAt, ex.endDate, ex.endTime]);

  async function submitExtend(payment: "desk" | "link") {
    if (!bookingId) return;
    setExBusy(true);
    try {
      const endAt = atAruba(ex.endDate, ex.endTime);
      const r = await api<{ endAt: string; deltaCents: number; checkoutUrl: string | null }>(
        `/api/admin/bookings/${bookingId}/extend`,
        { endAt, payment },
      );
      onChanged();
      await load();
      if (payment === "link" && r.checkoutUrl) {
        setExLinkUrl(r.checkoutUrl);
        toast.show({
          type: "success",
          message: r.deltaCents > 0 ? `Extended. Send this link for ${money(r.deltaCents)}.` : "Extended.",
        });
      } else {
        toast.show({
          type: "success",
          message: r.deltaCents > 0 ? `Extended. Collected ${money(r.deltaCents)} at the desk.` : "Extended.",
        });
        setShowExtend(false);
      }
    } catch (e) {
      toast.show({ type: "error", message: (e as ApiError).message });
    }
    setExBusy(false);
  }

  async function copyExtendLink() {
    if (!exLinkUrl) return;
    try {
      await navigator.clipboard.writeText(exLinkUrl);
      setExCopied(true);
      setTimeout(() => setExCopied(false), 1500);
    } catch {
      toast.show({ type: "error", message: "Couldn't copy the link, please copy it by hand." });
    }
  }

  /** "Betaald t/m": add one month, clamped to the target month's length. */
  const addMonth = (iso: string): string => {
    const [y, m, d] = iso.split("-").map(Number);
    const ty = m === 12 ? y! + 1 : y!, tm = m === 12 ? 1 : m! + 1;
    const dim = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
    return `${ty}-${String(tm).padStart(2, "0")}-${String(Math.min(d!, dim)).padStart(2, "0")}`;
  };

  async function savePaidUntil(value: string | null) {
    if (!detail) return;
    setPaidUntilBusy(true);
    try {
      await api(`/api/admin/bookings/${detail.booking.id}/paid-until`, { paidUntil: value });
      onChanged();
      await load();
      toast.show({ type: "success", message: value ? `Marked paid until ${value}` : "Paid-until marker cleared" });
    } catch (e) {
      toast.show({ type: "error", message: (e as ApiError).message });
    } finally {
      setPaidUntilBusy(false);
    }
  }

  /** Record cash taken at the desk. Reuses the check-in wizard's route, which
   *  writes a succeeded desk 'balance' payment and bumps the ledger atomically. */
  async function recordPayment(amountCents: number) {
    if (!detail || amountCents <= 0) return;
    setPayBusy(true);
    try {
      await api(`/api/admin/bookings/${detail.booking.id}/desk-payment`, { amountCents });
      setShowOtherAmount(false);
      setOtherAmountCents(null);
      onChanged();
      await load();
      toast.show({ type: "success", message: `Recorded ${money(amountCents)} received` });
    } catch (e) {
      toast.show({ type: "error", message: (e as ApiError).message });
    } finally {
      setPayBusy(false);
    }
  }

  const b = detail?.booking;
  const canConfirm = paymentMode === "desk" && b?.status === "pending";
  const canCancel = b?.status === "pending" || b?.status === "confirmed";
  // A car can be swapped for any live booking, including one already picked up
  // (the car can break down mid-rental). Only cancelled/completed are out.
  const canSwap = b?.status === "pending" || b?.status === "confirmed" || b?.status === "picked_up";
  const swapCandidates = detail
    ? vehicles
        .filter((v) => v.id !== detail.vehicle.id && v.status !== "retired")
        .sort((x, y) => (x.class ?? "").localeCompare(y.class ?? "") || x.plate.localeCompare(y.plate))
    : [];

  return (
    <>
      <Drawer
        open={bookingId !== null}
        onClose={onClose}
        title={detail?.customer.name || "Booking"}
        description={detail ? `${detail.vehicle.plate} · ${detail.vehicle.name}` : undefined}
        size="lg"
      >
        {loading && !detail && <SkeletonRows rows={4} cols={2} />}
        {!loading && !detail && <p className="muted">Couldn&apos;t load this booking.</p>}
        {detail && b && (
          <div className="bd">
            <section className="bd-section">
              <h3>Summary</h3>
              <dl className="bd-summary">
                <div>
                  <dt>Customer</dt>
                  <dd>{detail.customer.name || detail.customer.email}<small>{detail.customer.email} · {detail.customer.phone || "no phone on file"}</small></dd>
                </div>
                <div>
                  <dt>Vehicle</dt>
                  <dd>{detail.vehicle.plate} · {detail.vehicle.name}</dd>
                </div>
                <div className="bd-period">
                  <dt>Period</dt>
                  <dd>{formatDateTime(b.startAt)} to {formatDateTime(b.endAt)}</dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd><span className={`bd-status bd-status--${b.status}`}>{STATUS_LABEL[b.status] ?? b.status}</span></dd>
                </div>
                <div>
                  <dt>Source</dt>
                  <dd><span className="tag">{b.source === "manual" ? "Manual" : "Online"}</span></dd>
                </div>
              </dl>
              {b.notes && <p className="pl-pop-note">{b.notes}</p>}
            </section>

            <section className="bd-section">
              <h3>Payments</h3>
              {detail.payments.length === 0 ? (
                <p className="muted">No payments yet.</p>
              ) : (
                <div className="bd-payments">
                  {detail.payments.map((p) => {
                    const remaining = p.amountCents - p.refundedCents;
                    return (
                      <div className="bd-payment-row" key={p.id}>
                        <span className="bd-payment-type">{TYPE_LABEL[p.type] ?? p.type}</span>
                        <span className="tag">{p.method}</span>
                        <span className={`tag ${p.status === "succeeded" ? "on" : p.status === "failed" ? "off" : ""}`}>{p.status}</span>
                        {p.refundedCents > 0 && <span className="tag off">Refunded {money(p.refundedCents)}</span>}
                        <span className="bd-payment-amt">{money(p.amountCents)}</span>
                        {p.status === "succeeded" && remaining > 0 && (
                          <button type="button" className="btn btn--quiet" onClick={() => openRefund(p)}>Refund</button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              <p className="bd-balance">Paid {money(b.amountPaidCents)} · Balance due at pickup {money(detail.balanceDueCents)}</p>
              {detail.paidNote && (
                <p className={detail.unpaid ? "bd-paidnote bd-paidnote--unpaid" : "bd-paidnote"}>{detail.paidNote}</p>
              )}

              {b.status !== "cancelled" && detail.balanceDueCents > 0 && (
                <div className="bd-moneygroup">
                  <h4 className="bd-moneygroup__title">Amount received</h4>
                  <div className="pl-pop-actions">
                    <button type="button" className="btn btn--accent" disabled={payBusy}
                      onClick={() => recordPayment(detail.balanceDueCents)}>
                      {payBusy ? "Saving…" : `Mark as paid (${money(detail.balanceDueCents)})`}
                    </button>
                    <button type="button" className="btn btn--quiet" disabled={payBusy}
                      onClick={() => setShowOtherAmount((v) => !v)}>
                      {showOtherAmount ? "Cancel" : "Other amount…"}
                    </button>
                  </div>
                  {showOtherAmount && (
                    <div className="bd-otheramount">
                      <label>Amount received
                        <MoneyInput cents={otherAmountCents} ariaLabel="Amount received"
                          onChange={(cents) => setOtherAmountCents(cents)} autoFocus />
                      </label>
                      <button type="button" className="btn btn--accent"
                        disabled={payBusy || otherAmountCents === null || otherAmountCents <= 0}
                        onClick={() => recordPayment(otherAmountCents!)}>
                        {payBusy ? "Saving…" : "Record payment"}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {(b.status === "picked_up" || b.status === "confirmed" || b.status === "completed") && (
                <div className="bd-moneygroup">
                  <h4 className="bd-moneygroup__title">Paid until</h4>
                  <div className="bd-paiduntil">
                    <label className="bd-paiduntil__label">
                      <DatePicker value={paidUntilDraft} onChange={(iso) => setPaidUntilDraft(iso)} ariaLabel="Paid until" />
                    </label>
                    <button type="button" className="btn btn--quiet"
                      disabled={paidUntilBusy || !paidUntilDraft || paidUntilDraft === (b.paidUntil ?? "")}
                      onClick={() => savePaidUntil(paidUntilDraft)}>Save</button>
                    <button type="button" className="btn btn--quiet" disabled={paidUntilBusy}
                      onClick={() => savePaidUntil(addMonth(paidUntilDraft || arubaDateOf(arubaNowIso())))}>+1 month</button>
                    {b.paidUntil && (
                      <button type="button" className="btn btn--quiet" disabled={paidUntilBusy}
                        onClick={() => savePaidUntil(null)}>Clear</button>
                    )}
                  </div>
                  <p className="muted bd-paiduntil__hint">For rentals paid by the month. Set the last day the customer has covered. Once that date passes, the bar on the board turns red striped. Leave this empty for ordinary rentals — then the balance above decides.</p>
                </div>
              )}
            </section>

            {extraSections ?? <InspectionPanel bookingId={b.id} onChanged={onChanged} />}

            <section className="bd-section">
              <h3>Actions</h3>
              {!showMove && !showSwap && (
                <div className="pl-pop-actions">
                  {canConfirm && (
                    <button type="button" className="btn btn--accent" disabled={confirmBusy} onClick={doConfirm}>
                      {confirmBusy ? "Confirming…" : "Confirm booking"}
                    </button>
                  )}
                  <button type="button" className="btn btn--quiet" onClick={openMove}>Move…</button>
                  <button type="button" className="btn btn--quiet" onClick={openExtend}>Extend…</button>
                  {canSwap && (
                    <button type="button" className="btn btn--quiet" onClick={openSwap}>Swap car…</button>
                  )}
                  {canCancel && (
                    <button type="button" className="btn danger" onClick={() => setShowCancel(true)}>Cancel rental</button>
                  )}
                </div>
              )}
              {showSwap && (
                <div className="pl-form">
                  <label>Swap to
                    <Select
                      value={swapVehicleId}
                      onChange={setSwapVehicleId}
                      options={swapCandidates.map((v) => ({ value: v.id, label: `${v.class ? v.class + " · " : ""}${v.plate} · ${v.name}` }))}
                      placeholder={vehicles.length === 0 ? "Loading cars…" : "Choose a replacement car"}
                    />
                  </label>
                  <p className="muted">Same dates and same price. Only the car changes.</p>
                  <div className="pl-pop-actions">
                    <button type="button" className="btn btn--accent" disabled={swapBusy || !swapVehicleId} onClick={() => submitSwap(false)}>{swapBusy ? "Swapping…" : "Swap car"}</button>
                    <button type="button" className="btn btn--quiet" onClick={() => setShowSwap(false)}>Back</button>
                  </div>
                </div>
              )}
              {showMove && (
                <form className="pl-form" onSubmit={submitMove}>
                  <label>Car
                    <Select
                      value={mv.vehicleId}
                      onChange={(v) => setMv({ ...mv, vehicleId: v })}
                      options={vehicles.map((v) => ({ value: v.id, label: `${v.plate} · ${v.name}` }))}
                      placeholder="Loading cars…"
                    />
                  </label>
                  <div className="bd-dates">
                    <label>Pick-up<DatePicker required value={mv.startDate} onChange={(iso) => setMv({ ...mv, startDate: iso })} /></label>
                    <label>Pick-up time<TimeSelect value={mv.startTime} onChange={(t) => setMv({ ...mv, startTime: t })} /></label>
                    <label>Return<DatePicker required value={mv.endDate} onChange={(iso) => setMv({ ...mv, endDate: iso })} /></label>
                    <label>Return time<TimeSelect value={mv.endTime} onChange={(t) => setMv({ ...mv, endTime: t })} /></label>
                  </div>
                  <div className="pl-pop-actions">
                    <button className="btn btn--accent" disabled={moveBusy}>{moveBusy ? "Saving…" : "Save move"}</button>
                    <button type="button" className="btn btn--quiet" onClick={() => setShowMove(false)}>Back</button>
                  </div>
                </form>
              )}
            </section>
          </div>
        )}
      </Drawer>

      <Modal
        open={refundFor !== null}
        onClose={() => setRefundFor(null)}
        title="Refund payment"
        description={refundFor ? `${TYPE_LABEL[refundFor.type] ?? refundFor.type} · ${money(refundFor.amountCents)} paid` : undefined}
        size="sm"
        footer={
          <>
            <button type="button" className="btn btn--quiet" onClick={() => setRefundFor(null)}>Cancel</button>
            <button type="submit" form="bd-refund-form" className="btn btn--accent" disabled={refundBusy}>{refundBusy ? "Refunding…" : "Refund"}</button>
          </>
        }
      >
        <form id="bd-refund-form" className="pl-form" onSubmit={submitRefund}>
          <label>Amount (USD)
            <MoneyInput
              autoFocus
              required
              cents={refundCents}
              ariaLabel="Refund amount (USD)"
              onChange={setRefundCents}
            />
          </label>
        </form>
      </Modal>

      <Modal
        open={showCancel}
        onClose={() => setShowCancel(false)}
        title="Cancel this rental?"
        description={b ? `${detail?.vehicle.plate} · ${formatDateTime(b.startAt)} to ${formatDateTime(b.endAt)}` : undefined}
        size="sm"
        footer={
          <>
            <button type="button" className="btn btn--quiet" onClick={() => setShowCancel(false)} disabled={cancelBusy}>Keep rental</button>
            <button
              type="button"
              className="btn"
              data-autofocus={detail && !detail.policySaysFree ? true : undefined}
              disabled={cancelBusy}
              onClick={() => doCancel(false)}
            >
              Cancel without refund
            </button>
            <button
              type="button"
              className="btn btn--accent"
              data-autofocus={detail && detail.policySaysFree ? true : undefined}
              disabled={cancelBusy}
              onClick={() => doCancel(true)}
            >
              Cancel and refund
            </button>
          </>
        }
      >
        <p className="muted">
          {detail?.policySaysFree
            ? "This is outside the cancellation window, so a refund is expected."
            : "This is inside the cancellation window, so policy alone would not refund it. The desk can still choose to."}
        </p>
      </Modal>

      <Modal
        open={showExtend}
        onClose={() => setShowExtend(false)}
        title="Extend this rental"
        description={b ? `Currently returns ${formatDateTime(b.endAt)}` : undefined}
        size="sm"
        footer={
          exLinkUrl ? (
            <button type="button" className="btn btn--accent" onClick={() => setShowExtend(false)}>Done</button>
          ) : (
            <>
              <button type="button" className="btn btn--quiet" onClick={() => setShowExtend(false)} disabled={exBusy}>Cancel</button>
              <button
                type="button"
                className="btn btn--quiet"
                disabled={exBusy || exDelta === null}
                onClick={() => submitExtend("desk")}
              >
                {exBusy ? "Saving…" : "Collected at desk"}
              </button>
              <button
                type="button"
                className="btn btn--accent"
                disabled={exBusy || exDelta === null}
                onClick={() => submitExtend("link")}
              >
                {exBusy ? "Saving…" : "Send payment link"}
              </button>
            </>
          )
        }
      >
        {exLinkUrl ? (
          <>
            <p className="muted">Share this link with the customer to collect the extension payment.</p>
            <div className="bd-extend-link">
              <input data-autofocus type="text" readOnly value={exLinkUrl} onFocus={(e) => e.currentTarget.select()} />
              <button type="button" className="btn btn--quiet" onClick={copyExtendLink}>{exCopied ? "Copied" : "Copy"}</button>
            </div>
          </>
        ) : (
          <>
            <div className="bd-extend-fields">
              <label>New return
                <DatePicker
                  required
                  min={b ? arubaDateOf(b.endAt) : undefined}
                  value={ex.endDate}
                  onChange={(iso) => setEx({ ...ex, endDate: iso })}
                />
              </label>
              <label>Return time
                <TimeSelect value={ex.endTime} onChange={(t) => setEx({ ...ex, endTime: t })} />
              </label>
            </div>
            <p className="bd-extend-preview">
              <span>Extra to charge</span>
              <strong>
                {exPreviewBusy
                  ? "Calculating…"
                  : exPreviewError
                    ? exPreviewError
                    : exDelta === null
                      ? "Pick a later return date"
                      : money(exDelta)}
              </strong>
            </p>
          </>
        )}
      </Modal>

      <Modal
        open={swapAdvisory !== null}
        onClose={() => setSwapAdvisory(null)}
        title="That car isn't free"
        size="sm"
        footer={
          <>
            <button type="button" className="btn btn--quiet" onClick={() => setSwapAdvisory(null)} disabled={swapBusy}>Back</button>
            <button type="button" className="btn danger" disabled={swapBusy} onClick={() => submitSwap(true)}>{swapBusy ? "Swapping…" : "Swap anyway"}</button>
          </>
        }
      >
        <p className="muted">{swapAdvisory}</p>
      </Modal>

      <Modal
        open={repairFor !== null}
        onClose={() => setRepairFor(null)}
        title={repairFor ? `Block ${repairFor.plate} for repair?` : "Block for repair?"}
        description="The customer is on the replacement car now. This one is free again, so take it off the road while it's fixed."
        size="sm"
        footer={
          <>
            <button type="button" className="btn btn--quiet" onClick={() => setRepairFor(null)} disabled={repairBusy}>Not now</button>
            <button
              type="button"
              className="btn btn--accent"
              disabled={repairBusy || !repair.startDate || !repair.endDate}
              onClick={submitRepair}
            >
              {repairBusy ? "Blocking…" : "Block car"}
            </button>
          </>
        }
      >
        <div className="pl-form">
          <label>Reason
            <Select
              value={repair.type}
              onChange={(t) => setRepair({ ...repair, type: t })}
              options={BLOCK_TYPES.map((t) => ({ value: t, label: niceType(t) }))}
            />
          </label>
          <div className="bd-dates">
            <label>From<DatePicker required value={repair.startDate} onChange={(iso) => setRepair({ ...repair, startDate: iso })} /></label>
            <label>Until<DatePicker required min={repair.startDate || undefined} value={repair.endDate} onChange={(iso) => setRepair({ ...repair, endDate: iso })} /></label>
          </div>
        </div>
      </Modal>
    </>
  );
}
