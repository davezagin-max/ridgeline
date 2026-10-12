/**
 * Turns constraints into a route, deterministically.
 *
 * The router minimises one number (distance plus weighted climb), so "keep the
 * climb under 600 m" is not something it can be told directly: a hard cap on a
 * path-wide total makes shortest-path search NP-hard. The planner uses the
 * standard workaround, Lagrangian relaxation: treat the climb weight as a dial
 * and turn it up until the cheapest route fits under the cap. Raising the
 * weight can never increase the climb (see the proof in the route tests), so
 * the first weight on the ladder that fits is the least-distorted route that
 * does.
 *
 * "Loop" requests become an out-and-back to a landmark: one exhaustive search
 * from the start gives the best route to every landmark at once, and the
 * planner picks the turnaround whose round trip is closest to the target time
 * while respecting the climb cap.
 */
import type { Grid, GridMeta } from "../terrain/grid";
import { LANDMARKS, findLandmark, landmarkNode, type Landmark } from "../terrain/landmarks";
import {
  DEFAULT_ROUTE_OPTIONS,
  MODE_CLIMB_WEIGHT,
  type RouteOptions,
  type Router,
} from "../terrain/route";
import { routeStats, type RouteStats } from "../terrain/stats";
import type { RouteConstraints } from "./constraints";

/** Climb weights tried in order once the mode's own weight does not fit the cap. */
export const CLIMB_LADDER = [30, 60, 120, 240] as const;

/** Round trips within this fraction of the target time count as hitting it. */
export const DURATION_TOLERANCE = 0.25;

/** Used when a loop is requested without a target time. */
export const DEFAULT_LOOP_MINUTES = 120;

export type PlanCheck =
  | { kind: "climb"; ok: boolean; actualM: number; limitM: number }
  | { kind: "duration"; ok: boolean; actualMin: number; targetMin: number }
  | { kind: "grade"; ok: boolean; actualPct: number; limitPct: number };

export interface RoutePlan {
  found: boolean;
  /** Why there is no route, in words the UI can show. */
  reason: string | null;
  constraints: RouteConstraints;
  /** Landmark id at the far end: the given destination, or the chosen turnaround. */
  destination: string | null;
  roundTrip: boolean;
  /** Node indices. For a round trip: out to the destination and back along the same line. */
  path: Int32Array;
  stats: RouteStats | null;
  /** Grade limit applied, as a fraction (0.3 is 30%). */
  maxGrade: number;
  /** Climb weight the accepted route was found with. */
  climbWeight: number;
  /** Searches run to get here. */
  searches: number;
  checks: PlanCheck[];
}

export function roundTripPath(out: ArrayLike<number>): Int32Array {
  const path = new Int32Array(out.length * 2 - 1);
  for (let i = 0; i < out.length; i++) {
    path[i] = out[i];
    path[path.length - 1 - i] = out[i];
  }
  return path;
}

function weightsFor(constraints: RouteConstraints): number[] {
  const base = MODE_CLIMB_WEIGHT[constraints.mode];
  if (constraints.maxClimbM === null) return [base];
  return [base, ...CLIMB_LADDER.filter((weight) => weight > base)];
}

function buildChecks(constraints: RouteConstraints, stats: RouteStats): PlanCheck[] {
  const checks: PlanCheck[] = [];
  if (constraints.maxClimbM !== null) {
    checks.push({
      kind: "climb",
      ok: stats.climbM <= constraints.maxClimbM,
      actualM: stats.climbM,
      limitM: constraints.maxClimbM,
    });
  }
  if (constraints.targetDurationMin !== null) {
    const target = constraints.targetDurationMin;
    checks.push({
      kind: "duration",
      ok: Math.abs(stats.minutes - target) <= target * DURATION_TOLERANCE,
      actualMin: stats.minutes,
      targetMin: target,
    });
  }
  if (constraints.maxGradePct !== null) {
    checks.push({
      kind: "grade",
      ok: stats.maxGradePct <= constraints.maxGradePct + 1e-6,
      actualPct: stats.maxGradePct,
      limitPct: constraints.maxGradePct,
    });
  }
  return checks;
}

interface Candidate {
  destination: Landmark;
  path: Int32Array;
  stats: RouteStats;
  weight: number;
}

export function planRoute(
  router: Router,
  meta: Pick<GridMeta, "width" | "height" | "bounds">,
  constraints: RouteConstraints,
): RoutePlan {
  const grid: Grid = router.grid;
  const maxGrade =
    constraints.maxGradePct === null
      ? DEFAULT_ROUTE_OPTIONS.maxGrade
      : constraints.maxGradePct / 100;
  const base = {
    constraints,
    roundTrip: constraints.end === null,
    maxGrade,
  };
  const none = (reason: string, searches: number): RoutePlan => ({
    ...base,
    found: false,
    reason,
    destination: constraints.end,
    path: new Int32Array(0),
    stats: null,
    climbWeight: MODE_CLIMB_WEIGHT[constraints.mode],
    searches,
    checks: [],
  });

  const startLandmark = findLandmark(constraints.start);
  const endLandmark = constraints.end === null ? null : findLandmark(constraints.end);
  if (!startLandmark || (constraints.end !== null && !endLandmark)) {
    return none("That place is not on this map.", 0);
  }
  const start = landmarkNode(grid, meta, startLandmark);
  const optionsAt = (climbWeight: number): RouteOptions => ({
    ...DEFAULT_ROUTE_OPTIONS,
    maxGrade,
    climbWeight,
  });
  const fits = (stats: RouteStats) =>
    constraints.maxClimbM === null || stats.climbM <= constraints.maxClimbM;

  let searches = 0;
  let best: Candidate | null = null;

  for (const weight of weightsFor(constraints)) {
    searches++;
    let candidate: Candidate | null = null;

    if (endLandmark) {
      const result = router.search(start, landmarkNode(grid, meta, endLandmark), optionsAt(weight));
      if (!result.found) break; // reachability does not depend on the weight
      candidate = {
        destination: endLandmark,
        path: result.path,
        stats: routeStats(grid, result.path, constraints.activity),
        weight,
      };
    } else {
      router.search(start, -1, optionsAt(weight));
      const target = constraints.targetDurationMin ?? DEFAULT_LOOP_MINUTES;
      let closest = Infinity;
      for (const landmark of LANDMARKS) {
        if (landmark.id === startLandmark.id) continue;
        const out = router.pathTo(landmarkNode(grid, meta, landmark), start);
        if (out.length < 2) continue;
        const path = roundTripPath(out);
        const stats = routeStats(grid, path, constraints.activity);
        // Turnarounds that fit the climb cap compete on how close they come to the target
        // time. If none fits, the one with the least climbing is kept for the next weight.
        const miss = fits(stats) ? Math.abs(stats.minutes - target) : 1e9 + stats.climbM;
        if (miss < closest) {
          closest = miss;
          candidate = { destination: landmark, path, stats, weight };
        }
      }
      if (!candidate) break;
    }

    if (!best || candidate.stats.climbM < best.stats.climbM) best = candidate;
    if (fits(candidate.stats)) {
      best = candidate;
      break;
    }
  }

  if (!best) {
    const limit = Math.round(maxGrade * 100);
    return none(
      endLandmark
        ? `No route from ${startLandmark.name} to ${endLandmark.name} stays under a ${limit}% grade.`
        : `Nothing is reachable from ${startLandmark.name} under a ${limit}% grade.`,
      searches,
    );
  }

  return {
    ...base,
    found: true,
    reason: null,
    destination: best.destination.id,
    path: best.path,
    stats: best.stats,
    climbWeight: best.weight,
    searches,
    checks: buildChecks(constraints, best.stats),
  };
}
