import { z } from "zod";
import { and, eq, gt, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { availabilityBlocks, bookings, customers, vehicles } from "@/lib/db/schema";
import { Errors } from "@/lib/http/errors";
import { translateDbError } from "@/lib/db/errors";
import { getSettings } from "@/lib/admin/settings";
import { checkAvailability } from "@/lib/booking/availability";
import { arubaDateOf, parseTs } from "@/lib/time/format";
import { planAssignment, planAssignmentExact, timeCluster, type PlanBooking } from "@/lib/admin/reshuffle";

/**
 * Breakdown swap: move a booking onto a replacement car when its assigned car is
 * out of action, WITHOUT touching the dates or the price. This is the deliberate
 * counterpart to {@link moveBooking}:
 *
 *  - it works for a `picked_up` booking too (the car is out with the customer and
 *    has broken down) — the status is preserved, only the vehicle changes;
 *  - it never re-quotes. A breakdown is not the customer's fault, so the original
 *    price snapshot, add-on lines and totals are left exactly as they were, even
 *    if the replacement car normally costs more or less.
 *
 * Auto-sort: when the target already carries other rentals in this window, those
 * rentals are re-homed onto other free vehicles of the same class instead of the
 * swap being refused (cars in one class are interchangeable, so the desk hands out whichever
 * vehicle is at hand and the system solves the puzzle). It first tries to move
 * only the clashing rentals; if that does not fit, it re-sorts the rentals that
 * are chained in time to this one. Picked-up rentals never move (the vehicle is
 * physically out). If nothing fits, the swap is refused and nothing changes.
 *
 * Every write is still guarded by the physical exclusion constraint, so a swap can
 * never double-book a vehicle. A soft block/blackout on the target surfaces as an
 * `advisory_conflict` the desk can explicitly override.
 */
/** Why the desk swapped. Walk-in = handed out whichever vehicle was at hand;
 *  repair/damaged = the vehicle being left is going off the road. */
export const SWAP_REASONS = ["walk_in", "repair", "damaged", "other"] as const;
export type SwapReason = (typeof SWAP_REASONS)[number];

export const SwapSchema = z.object({
  vehicleId: z.string().uuid(),
  override: z.boolean().default(false),
  reason: z.enum(SWAP_REASONS).optional(),
}).strict();
// Input (not infer): swapVehicle is called directly in tests/internal callers
// without SwapSchema.parse, so `override` (the field with a default) stays
// optional at the type level.
export type SwapInput = z.input<typeof SwapSchema>;

const NOT_SWAPPABLE = "This booking can no longer be swapped";
const PICK_DIFFERENT = "Pick a different car to swap to";

/** Statuses whose car can still be swapped. A picked_up car is out with the
 *  customer but can break down mid-rental, so it is included (unlike moving,
 *  which only shifts dates on a car that has not left yet). */
function isSwappable(status: string): boolean {
  return status === "pending" || status === "confirmed" || status === "picked_up";
}

export interface MovedBooking {
  id: string;
  customerName: string;
  fromPlate: string;
  toPlate: string;
  startAt: string;
  endAt: string;
}

const LIVE = ["pending", "confirmed", "picked_up"] as const;

export async function swapVehicle(id: string, input: SwapInput) {
  const db = await getDb();
  const settings = await getSettings();

  // Advisory pre-check OUTSIDE the transaction (checkAvailability opens its own
  // connection; PGlite is single-connection so calling it inside db.transaction()
  // deadlocks — same placement moveBooking uses). Rentals on the target are NOT
  // advisory any more: they get re-sorted below. Blocks, blackouts and a
  // non-active target still are.
  if (!input.override) {
    const [existing] = await db.select().from(bookings).where(eq(bookings.id, id));
    if (existing) {
      // A terminal booking can never be swapped, override or not — check that
      // FIRST so it never surfaces a misleading "swap anyway" advisory offer.
      if (!isSwappable(existing.status)) throw Errors.conflict(NOT_SWAPPABLE);
      if (input.vehicleId === existing.vehicleId) throw Errors.badRequest(PICK_DIFFERENT);
      const [vehicle] = await db.select().from(vehicles).where(eq(vehicles.id, input.vehicleId));
      // A missing/retired target is a hard error below, never an overridable advisory.
      if (vehicle && vehicle.status !== "retired") {
        const availability = await checkAvailability(input.vehicleId, existing.startAt, existing.endAt, settings, id, { ignoreBookings: true });
        if (!availability.available) {
          throw Errors.conflict(`${availability.reason ?? "That car is unavailable"}. Confirm to swap anyway.`, { code: "advisory_conflict" });
        }
      }
    }
  }

  try {
    return await db.transaction(async (tx) => {
      const [booking] = await tx.select().from(bookings).where(eq(bookings.id, id)).for("update");
      if (!booking) throw Errors.notFound("Booking not found");
      if (!isSwappable(booking.status)) throw Errors.conflict(NOT_SWAPPABLE);
      if (input.vehicleId === booking.vehicleId) throw Errors.badRequest(PICK_DIFFERENT);

      const [vehicle] = await tx.select().from(vehicles).where(eq(vehicles.id, input.vehicleId));
      if (!vehicle || vehicle.status === "retired") throw Errors.notFound("Target vehicle not available");

      // The same-class fleet is the pool the planner may use. Only active vehicles
      // take re-homed rentals; everything else just counts as occupied.
      const fleet = await tx.select({ id: vehicles.id, plate: vehicles.plate, status: vehicles.status })
        .from(vehicles).where(eq(vehicles.class, vehicle.class));
      const plateOf = new Map(fleet.map((v) => [v.id, v.plate]));
      // A vehicle left because it broke must not be handed re-sorted rentals.
      const leftBroken = input.reason === "repair" || input.reason === "damaged";
      const laneIds = fleet.filter((v) => v.status === "active" && !(leftBroken && v.id === booking.vehicleId))
        .sort((a, b) => a.plate.localeCompare(b.plate)).map((v) => v.id);
      const laneSet = new Set(laneIds);

      // Every live rental on these scooters, however old. A moved rental can start
      // well before the swapped one (a stale "confirmed" that was never checked
      // out), so no date floor is safe here: a hidden older rental is exactly
      // what the exclusion constraint would then trip over.
      const fleetIds = fleet.map((v) => v.id);
      const rows = await tx.select({
        id: bookings.id, vehicleId: bookings.vehicleId, status: bookings.status,
        startAt: bookings.startAt, endAt: bookings.endAt, bufferEndAt: bookings.bufferEndAt,
      }).from(bookings).where(and(
        inArray(bookings.vehicleId, fleetIds),
        inArray(bookings.status, [...LIVE]),
      ));
      // Blocks only matter from the earliest live rental onwards.
      const earliest = rows.reduce((m, r) => (parseTs(r.startAt) < parseTs(m) ? r.startAt : m), booking.startAt);
      const blockRows = await tx.select().from(availabilityBlocks).where(and(
        inArray(availabilityBlocks.vehicleId, fleetIds),
        gt(availabilityBlocks.endAt, earliest),
      ));

      const toPlan = (r: { id: string; vehicleId: string; startAt: string; endAt: string; bufferEndAt: string }): PlanBooking => ({
        id: r.id, vehicleId: r.vehicleId,
        start: parseTs(r.startAt), end: parseTs(r.endAt), bufferEnd: parseTs(r.bufferEndAt),
      });
      const self: PlanBooking = { ...toPlan(booking), vehicleId: input.vehicleId };
      const others = rows.filter((r) => r.id !== booking.id);
      const displaced = others.filter((r) =>
        r.vehicleId === input.vehicleId && parseTs(r.startAt) < self.bufferEnd && self.start < parseTs(r.bufferEndAt));

      // A rental on the target that is already picked up means that vehicle is
      // physically out with someone else — the board is out of date.
      const out = displaced.find((r) => r.status === "picked_up");
      if (out) {
        throw Errors.conflict(`${vehicle.plate} is still marked as out with another renter until ${arubaDateOf(out.endAt)}. Check it in first, then swap.`);
      }

      let moves: Array<{ id: string; from: string; to: string }> = [];
      if (displaced.length > 0) {
        const blocks = blockRows.map((k) => ({ vehicleId: k.vehicleId, start: parseTs(k.startAt), end: parseTs(k.endAt) }));
        const displacedIds = new Set(displaced.map((r) => r.id));

        // Stage 1: move only the rentals that clash, everything else stays put.
        let result = planAssignment({
          vehicleIds: laneIds,
          fixed: [self, ...others.filter((r) => !displacedIds.has(r.id)).map(toPlan)],
          movable: displaced.map(toPlan),
          blocks,
          preferStay: false,
        });

        // Stage 2/3/4: re-sort every not-yet-picked-up rental chained in time to
        // this one — keep-in-place first, then pure best fit, then exhaustive.
        // Rentals outside the chain never share time with it, so leaving them
        // put loses no solutions.
        if (!result.ok) {
          const pool = others
            .filter((r) => r.status !== "picked_up" && (laneSet.has(r.vehicleId) || displacedIds.has(r.id)))
            .map(toPlan);
          const cluster = timeCluster(self, pool);
          const clusterIds = new Set(cluster.map((b) => b.id));
          const fixed = [self, ...others.filter((r) => !clusterIds.has(r.id)).map(toPlan)];
          result = planAssignment({ vehicleIds: laneIds, fixed, movable: cluster, blocks, preferStay: true });
          if (!result.ok) result = planAssignment({ vehicleIds: laneIds, fixed, movable: cluster, blocks, preferStay: false });
          // Last resort: try every arrangement of the chained rentals, so a
          // refusal means the fleet really is full, not that the shortcut missed.
          if (!result.ok) result = planAssignmentExact({ vehicleIds: laneIds, fixed, movable: cluster, blocks, preferStay: true }) ?? result;
        }

        if (!result.ok) {
          const failed = others.find((r) => r.id === result.failedId);
          const when = failed ? ` (${arubaDateOf(failed.startAt)} to ${arubaDateOf(failed.endAt)})` : "";
          throw Errors.conflict(`No free vehicle left to move the other rental${when} to. Every vehicle in that class is taken in those dates.`);
        }
        const assignment = result.assignment;
        moves = others
          .filter((r) => assignment.has(r.id) && assignment.get(r.id) !== r.vehicleId)
          .map((r) => ({ id: r.id, from: r.vehicleId, to: assignment.get(r.id)! }));
      }

      // The exclusion constraint is checked row by row, so a chain of moves could
      // trip it half-way. Park the moving rentals outside the constraint first
      // (status it ignores), write every final position, then restore status.
      // All inside this transaction, so nobody ever sees the parked state.
      const statusOf = new Map(others.map((r) => [r.id, r.status]));
      if (moves.length > 0) {
        await tx.update(bookings).set({ status: "cancelled" })
          .where(inArray(bookings.id, moves.map((m) => m.id)));
      }
      // Vehicle only. Dates, buffer, status, price and add-on snapshots are all
      // left as-is, for the swapped rental and every re-homed one.
      const [updated] = await tx.update(bookings)
        .set({ vehicleId: input.vehicleId, updatedAt: new Date() })
        .where(eq(bookings.id, id))
        .returning();
      for (const m of moves) {
        await tx.update(bookings)
          .set({ vehicleId: m.to, status: statusOf.get(m.id)!, updatedAt: new Date() })
          .where(eq(bookings.id, m.id));
      }

      let moved: MovedBooking[] = [];
      if (moves.length > 0) {
        const info = await tx.select({ id: bookings.id, startAt: bookings.startAt, endAt: bookings.endAt, name: customers.name })
          .from(bookings).innerJoin(customers, eq(bookings.customerId, customers.id))
          .where(inArray(bookings.id, moves.map((m) => m.id)));
        const byId = new Map(info.map((i) => [i.id, i]));
        moved = moves.map((m) => ({
          id: m.id,
          customerName: byId.get(m.id)?.name ?? "",
          fromPlate: plateOf.get(m.from) ?? "",
          toPlate: plateOf.get(m.to) ?? "",
          startAt: byId.get(m.id)?.startAt ?? "",
          endAt: byId.get(m.id)?.endAt ?? "",
        })).sort((a, b) => parseTs(a.startAt) - parseTs(b.startAt));
      }
      return Object.assign(updated!, { moved });
    });
  } catch (e) {
    const t = translateDbError(e); // 23P01 overlap+buffer → 409
    if (t) throw t;
    throw e;
  }
}
