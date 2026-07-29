# Design: Breakdown vehicle swap ("Swap")

_2026-07-29 · branch `feat/breakdown-swap`_

## Problem

When a car breaks down, the desk needs to move the customer onto a different car.
Today the ops board only lets you change a booking's car while it is `pending` or
`confirmed` (via drag on the board, or the drawer's **Move…** panel). Once a car is
`picked_up` (out with the customer) the board refuses the change entirely, and
dragging such a bar wrongly falls through to the empty-track "New rental" gesture.
Breakdowns happen **both** before pickup and mid-rental, so the desk needs one
clear way to reassign the car regardless of status, without penalising the
customer on price for a fault that is not theirs.

## Goal

A dedicated **Swap** action on a booking that reassigns it to a replacement car,
keeping the same dates and the same price, and works even when the car is already
picked up. After the swap, offer to block the broken car for repair.

## Non-goals

- Changing the booking's dates (that is what **Move…** / **Extend…** already do).
- Re-pricing to the replacement car's rate.
- Showing pickup/drop-off **times** on the board (separate follow-up work).
- Any customer-facing notification/email changes (out of scope here).

## Decisions (from brainstorming)

| Question | Decision |
| --- | --- |
| Which breakdown timing? | Both (before pickup **and** mid-rental) → one action for all live statuses. |
| Broken car after swap? | **Ask each time** — prompt to block it for repair, reuse existing block/service dialog. |
| How to trigger? | A **button on the booking** (drawer), not drag. |
| Replacement price? | **Keep original price** — never re-price, FleetDesk absorbs the difference. |
| Which dates? | **Same dates, car-only.** |
| Replacement list? | **All** cars free for those dates, grouped by class (not restricted to same class). |

## Behaviour

### Backend: `swapVehicle(id, newVehicleId, { override })`

New operation in `src/lib/admin/swap-vehicle.ts`, deliberately separate from
`moveBooking` so the rules stay clean and the money path is easy to read.

- **Allowed statuses:** `pending`, `confirmed`, `picked_up`. Reject `cancelled` /
  `completed` with a 409 ("This booking can no longer be swapped").
- **Status is preserved** — a `picked_up` booking stays `picked_up` (the customer
  still has a car; only the vehicle changes).
- **Dates unchanged** — `startAt` / `endAt` / `bufferEndAt` stay as they are.
- **Price unchanged** — `priceBreakdown`, add-on snapshots and totals are left
  exactly as stored. No re-quote (this is the key difference from `moveBooking`).
- **Target validation:**
  - 404 if the replacement vehicle is missing or `retired`.
  - 400 if `newVehicleId` equals the current vehicle (no-op swap).
  - Real double-booking is always blocked by the existing physical exclusion
    constraint (booking clash + turnaround buffer) inside the transaction.
  - Advisory-only conflicts (soft block / blackout) on the replacement car are
    surfaced as a `advisory_conflict` 409, exactly like `moveBooking`, so the UI
    can offer a "Swap anyway" override. `override: true` skips the advisory
    pre-check but never the physical constraint.
- **Audit:** log as `admin.booking_vehicle_swapped` via the existing `mutate`
  wrapper, roles `["owner", "staff"]`, `after: { vehicleId }`.
- Availability pre-check runs **outside** the transaction (same PGlite
  single-connection constraint `moveBooking` documents), excluding this booking's
  own row.

### Endpoint

`POST /api/admin/bookings/[id]/swap-vehicle`
- Params: `{ id: uuid }`.
- Body: `{ vehicleId: uuid, override?: boolean }` (strict).
- Returns `{ id, vehicleId, startAt, endAt }`.
- Same `withRoute` + `mutate` shape as the move route.

### Frontend: drawer **Swap** panel

In `booking-drawer.tsx`, next to **Move… / Extend… / Cancel**:

- Add a **Swap** button. Visible when `status` is `pending`, `confirmed`, or
  `picked_up` (i.e. not cancelled/completed).
- Opens a sub-panel (same pattern as the Move panel) titled "Swap to another car":
  - Fetches `/api/admin/vehicles`, filters to cars **available for this booking's
    dates** and not the current car / not retired, grouped by class label.
  - The list is availability-aware: reuse the planning/availability data already
    loaded, or call the availability check per candidate. (Simplest first pass:
    show all non-retired, non-current cars grouped by class; the backend still
    rejects a genuinely-conflicting choice and the panel surfaces that error.)
  - Pick a car → **Swap** button → `POST …/swap-vehicle`.
  - On `advisory_conflict`, show a confirm ("That car has a block/blackout in this
    window. Swap anyway?") → retry with `override: true`.
- On success: toast "Swapped.", then the **broken-car prompt** (below), then
  `onChanged()` + reload.

### Broken-car repair prompt

After a successful swap, show a confirm: **"Block [oldPlate] for repair?"**
- **Yes** → open the existing Block/Service dialog (the board's `Schedule service` /
  block flow) prefilled with the old vehicle, so the desk sets type + dates.
- **No** → done; the old car simply frees up.

The prompt reuses the existing blocks flow (`POST /api/admin/vehicles/[id]/blocks`);
no new block logic is built here.

### Bundled bug fix (board drag)

`page.tsx` `onBarPointerDown`: a booking that cannot be dragged (`completed` /
`picked_up`, or non-primary button) currently `return`s **before**
`e.stopPropagation()`, so the pointerdown bubbles to the track and starts the
"drag to create a rental" gesture. Move `e.stopPropagation()` (for a left-button
press on a bar) ahead of the early return so dragging a non-movable bar is a
clean no-op. A plain click still opens the drawer, where the new **Swap** button
lives.

## Testing

Backend (vitest, the repo's only automated layer):
- `swapVehicle` happy path: `confirmed` booking → new car, dates/price/status
  unchanged, vehicleId updated.
- `picked_up` booking swaps successfully and **stays** `picked_up`.
- Price is **not** recomputed even when the replacement car has a different rate
  (assert `priceBreakdown` byte-identical).
- Reject `cancelled` / `completed` (409).
- Reject same-vehicle no-op (400) and retired/missing target (404).
- Real clash on the replacement car → 409 from the exclusion constraint.
- Advisory block on the replacement → `advisory_conflict` 409; `override: true`
  succeeds.
- Endpoint auth: rejects non owner/staff.

UI: no component-test harness in this repo → verify via `tsc`, `lint`, `build`,
and a live browser pass on `:3100` (swap a confirmed car, swap a picked-up car,
confirm the drag-on-picked-up no longer pops the New-rental menu).

## Files

- `src/lib/admin/swap-vehicle.ts` (new) — `SwapSchema`, `swapVehicle`.
- `src/app/api/admin/bookings/[id]/swap-vehicle/route.ts` (new).
- `src/test/swap-vehicle.test.ts` (new).
- `src/app/admin/(shell)/booking-drawer.tsx` — Swap button + panel + repair prompt.
- `src/app/admin/(shell)/booking-drawer.css` — panel styling if needed.
- `src/app/admin/(shell)/page.tsx` — the `onBarPointerDown` stopPropagation fix.
