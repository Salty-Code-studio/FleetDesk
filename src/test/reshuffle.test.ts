import { describe, it, expect } from "vitest";
import { planAssignment, planAssignmentExact, timeCluster, type PlanBooking, type PlanBlock, type PlanInput } from "@/lib/admin/reshuffle";

const DAY = 86_400_000;

/** Small deterministic PRNG so a failure is reproducible from its seed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

function valid(input: PlanInput, assignment: Map<string, string>): boolean {
  // Only judge what the planner controls: every moved rental against everything
  // else. Fixed-vs-fixed overlaps cannot exist in the real DB (the exclusion
  // constraint), but the random generator can produce them.
  const moved = input.movable.map((m) => ({ ...m, vehicleId: assignment.get(m.id) ?? "" }));
  if (moved.some((m) => !input.vehicleIds.includes(m.vehicleId))) return false;
  const others = [...input.fixed, ...moved];
  for (const a of moved) {
    for (const b of others) {
      if (a.id !== b.id && a.vehicleId === b.vehicleId && a.start < b.bufferEnd && b.start < a.bufferEnd) return false;
    }
    for (const k of input.blocks) {
      if (k.vehicleId === a.vehicleId && k.start < a.end && a.start < k.end) return false;
    }
  }
  return true;
}

/** Try every lane for every movable rental. Only viable for tiny boards. */
function bruteForceFeasible(input: PlanInput): boolean {
  const n = input.movable.length;
  const L = input.vehicleIds.length;
  const total = L ** n;
  for (let code = 0; code < total; code++) {
    const a = new Map<string, string>();
    let c = code;
    for (const m of input.movable) { a.set(m.id, input.vehicleIds[c % L]!); c = Math.floor(c / L); }
    if (valid(input, a)) return true;
  }
  return false;
}

function randomBoard(r: () => number): PlanInput {
  const lanes = 2 + Math.floor(r() * 3); // 2..4 scooters
  const vehicleIds = Array.from({ length: lanes }, (_, i) => `v${i}`);
  const mk = (id: string): PlanBooking => {
    const start = Math.floor(r() * 30) * DAY;
    const end = start + (1 + Math.floor(r() * 10)) * DAY;
    return { id, vehicleId: vehicleIds[Math.floor(r() * lanes)]!, start, end, bufferEnd: end + (r() < 0.5 ? DAY : 0) };
  };
  const fixed: PlanBooking[] = [];
  for (let i = 0; i < Math.floor(r() * 3); i++) fixed.push(mk(`f${i}`));
  const movable: PlanBooking[] = [];
  for (let i = 0; i < 2 + Math.floor(r() * 5); i++) movable.push(mk(`m${i}`));
  const blocks: PlanBlock[] = [];
  if (r() < 0.4) {
    const start = Math.floor(r() * 30) * DAY;
    blocks.push({ vehicleId: vehicleIds[Math.floor(r() * lanes)]!, start, end: start + (1 + Math.floor(r() * 8)) * DAY });
  }
  return { vehicleIds, fixed, movable, blocks, preferStay: r() < 0.5 };
}

describe("reshuffle planner", () => {
  it("never misses an arrangement that exists, and never returns an invalid one (3000 random boards)", () => {
    let feasibleBoards = 0;
    let greedyMissed = 0;
    for (let seed = 1; seed <= 3000; seed++) {
      const board = randomBoard(rng(seed));
      const truth = bruteForceFeasible(board);
      const exact = planAssignmentExact(board);
      expect(exact, `seed ${seed}: budget ran out on a tiny board`).not.toBeNull();
      expect(exact!.ok, `seed ${seed}: exact=${exact!.ok} brute=${truth}`).toBe(truth);
      if (exact!.ok) expect(valid(board, exact!.assignment), `seed ${seed}: invalid exact plan`).toBe(true);

      const greedy = planAssignment(board);
      if (greedy.ok) expect(valid(board, greedy.assignment), `seed ${seed}: invalid greedy plan`).toBe(true);
      if (truth) { feasibleBoards++; if (!greedy.ok) greedyMissed++; }
    }
    // Sanity: the random boards exercise both outcomes.
    expect(feasibleBoards).toBeGreaterThan(300);
    expect(feasibleBoards).toBeLessThan(3000);
    // The shortcut alone is not complete; the exhaustive stage covers its misses.
    expect(greedyMissed).toBeLessThan(feasibleBoards);
  });

  it("timeCluster follows chains of overlapping rentals and stops at gaps", () => {
    const b = (id: string, s: number, e: number): PlanBooking => ({ id, vehicleId: "v", start: s * DAY, end: e * DAY, bufferEnd: e * DAY });
    const pool = [b("a", 2, 5), b("b", 4, 9), b("c", 8, 12), b("far", 20, 22)];
    expect(timeCluster({ start: 0, bufferEnd: 3 * DAY }, pool).map((x) => x.id).sort()).toEqual(["a", "b", "c"]);
  });
});
