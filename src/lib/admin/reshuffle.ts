/**
 * Pure planner behind the auto-sorting swap. When the desk hands a customer a
 * specific vehicle, the rentals already sitting on that vehicle in the same
 * window get re-homed onto other identical vehicles so nobody has to solve the
 * puzzle by hand.
 *
 * Times are epoch milliseconds. A booking occupies [start, bufferEnd) against
 * other bookings (the DB exclusion rule) and [start, end) against blocks (the
 * same rule checkAvailability uses). No DB access here, so it is unit-testable.
 */

export interface PlanBooking {
  id: string;
  vehicleId: string;
  start: number;
  end: number;
  bufferEnd: number;
}

export interface PlanBlock {
  vehicleId: string;
  start: number;
  end: number;
}

export interface PlanInput {
  /** Candidate vehicles, in a stable order (plate order). */
  vehicleIds: string[];
  /** Bookings that must stay where they are (picked up, or the swapped one). */
  fixed: PlanBooking[];
  /** Bookings the planner may move. Their vehicleId is their current vehicle. */
  movable: PlanBooking[];
  blocks: PlanBlock[];
  /** Keep a booking on its current vehicle when it still fits there. */
  preferStay: boolean;
}

export type PlanResult =
  | { ok: true; assignment: Map<string, string> }
  | { ok: false; failedId: string };

interface Lane { bookings: PlanBooking[]; blocks: PlanBlock[] }

function fits(lane: Lane, b: PlanBooking): boolean {
  for (const o of lane.bookings) if (o.start < b.bufferEnd && b.start < o.bufferEnd) return false;
  for (const k of lane.blocks) if (k.start < b.end && b.start < k.end) return false;
  return true;
}

/** Idle time left on the lane right before `b` starts. Smaller = tighter fit,
 *  which keeps long free runs open on the other vehicles. */
function gapBefore(lane: Lane, b: PlanBooking): number {
  let latest = Number.NEGATIVE_INFINITY;
  for (const o of lane.bookings) if (o.bufferEnd <= b.start && o.bufferEnd > latest) latest = o.bufferEnd;
  for (const k of lane.blocks) if (k.end <= b.start && k.end > latest) latest = k.end;
  return latest === Number.NEGATIVE_INFINITY ? Number.POSITIVE_INFINITY : b.start - latest;
}

/**
 * Greedy interval assignment, earliest start first, best fit per booking. With
 * no fixed rentals this is the classic optimal strategy for identical machines;
 * with fixed ones it is a strong heuristic, and a miss means the fleet is
 * genuinely (or very nearly) full in that window.
 */
export function planAssignment(input: PlanInput): PlanResult {
  const lanes = new Map<string, Lane>();
  for (const v of input.vehicleIds) lanes.set(v, { bookings: [], blocks: [] });
  for (const f of input.fixed) lanes.get(f.vehicleId)?.bookings.push(f);
  for (const k of input.blocks) lanes.get(k.vehicleId)?.blocks.push(k);

  const order = [...input.movable].sort((a, b) => a.start - b.start || b.bufferEnd - a.bufferEnd || a.id.localeCompare(b.id));
  const assignment = new Map<string, string>();

  for (const b of order) {
    let chosen: string | null = null;
    if (input.preferStay) {
      const own = lanes.get(b.vehicleId);
      if (own && fits(own, b)) chosen = b.vehicleId;
    }
    if (!chosen) {
      let bestGap = Number.POSITIVE_INFINITY;
      let bestIsOwn = false;
      for (const v of input.vehicleIds) {
        const lane = lanes.get(v)!;
        if (!fits(lane, b)) continue;
        const gap = gapBefore(lane, b);
        const isOwn = v === b.vehicleId;
        if (chosen === null || gap < bestGap || (gap === bestGap && isOwn && !bestIsOwn)) {
          chosen = v; bestGap = gap; bestIsOwn = isOwn;
        }
      }
    }
    if (!chosen) return { ok: false, failedId: b.id };
    lanes.get(chosen)!.bookings.push(b);
    assignment.set(b.id, chosen);
  }
  return { ok: true, assignment };
}

/**
 * Exhaustive fallback: backtracking over every vehicle per rental (earliest start
 * first, best fit tried first), with a step budget so a huge board can never hang
 * a request. Within the budget it finds an arrangement whenever one exists, so a
 * refusal really means the fleet is full. Returns null when the budget runs out.
 */
export function planAssignmentExact(input: PlanInput, budget = 200_000): PlanResult | null {
  const lanes = new Map<string, Lane>();
  for (const v of input.vehicleIds) lanes.set(v, { bookings: [], blocks: [] });
  for (const f of input.fixed) lanes.get(f.vehicleId)?.bookings.push(f);
  for (const k of input.blocks) lanes.get(k.vehicleId)?.blocks.push(k);

  const order = [...input.movable].sort((a, b) => a.start - b.start || b.bufferEnd - a.bufferEnd || a.id.localeCompare(b.id));
  const assignment = new Map<string, string>();
  let steps = 0;
  let deepestFail = order[0]?.id ?? "";
  let deepest = -1;

  const solve = (i: number): boolean | null => {
    if (i === order.length) return true;
    const b = order[i]!;
    const options = input.vehicleIds
      .filter((v) => fits(lanes.get(v)!, b))
      .sort((x, y) => {
        if (input.preferStay && (x === b.vehicleId) !== (y === b.vehicleId)) return x === b.vehicleId ? -1 : 1;
        return gapBefore(lanes.get(x)!, b) - gapBefore(lanes.get(y)!, b);
      });
    if (options.length === 0 && i > deepest) { deepest = i; deepestFail = b.id; }
    for (const v of options) {
      if (++steps > budget) return null;
      const lane = lanes.get(v)!;
      lane.bookings.push(b);
      assignment.set(b.id, v);
      const r = solve(i + 1);
      if (r !== false) return r;
      lane.bookings.pop();
      assignment.delete(b.id);
    }
    return false;
  };

  const r = solve(0);
  if (r === null) return null;
  return r ? { ok: true, assignment } : { ok: false, failedId: deepestFail };
}

/**
 * The movable bookings that are chained in time to `seed`: anything overlapping
 * the seed window, then anything overlapping those, and so on. Re-sorting only
 * this cluster keeps the rest of the board untouched.
 */
export function timeCluster(seed: { start: number; bufferEnd: number }, pool: PlanBooking[]): PlanBooking[] {
  let lo = seed.start;
  let hi = seed.bufferEnd;
  const taken = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const b of pool) {
      if (taken.has(b.id)) continue;
      if (b.start < hi && lo < b.bufferEnd) {
        taken.add(b.id);
        if (b.start < lo) lo = b.start;
        if (b.bufferEnd > hi) hi = b.bufferEnd;
        grew = true;
      }
    }
  }
  return pool.filter((b) => taken.has(b.id));
}
