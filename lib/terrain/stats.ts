/**
 * What a route adds up to: distance, climb, descent, steepest step, an
 * estimated time, and the elevation profile the chart draws.
 */
import type { Grid } from "./grid";
import { stepRun } from "./route";

export type Activity = "hike" | "ride";

/**
 * The pace model is Naismith's rule: time = horizontal distance / flat speed
 * + metres climbed / climb rate. Descents are counted at flat speed.
 *
 * - hike: 5 km/h plus one hour per 600 m of ascent (Naismith's original figures).
 * - ride: 12 km/h on trail plus one hour per 600 m of ascent, a steady
 *   recreational mountain-bike pace.
 *
 * It is an estimate for comparing routes, not a schedule.
 */
export const PACE: Record<Activity, { label: string; flatKmh: number; climbMPerHour: number }> = {
  hike: { label: "Hike", flatKmh: 5, climbMPerHour: 600 },
  ride: { label: "Ride", flatKmh: 12, climbMPerHour: 600 },
};

export function estimateMinutes(horizontalM: number, climbM: number, activity: Activity): number {
  const pace = PACE[activity];
  return (horizontalM / 1000 / pace.flatKmh + climbM / pace.climbMPerHour) * 60;
}

export interface RouteStats {
  /** Length along the surface (3D), metres. */
  distanceM: number;
  /** Length on the map (horizontal), metres. */
  horizontalM: number;
  climbM: number;
  descentM: number;
  /** Steepest single step, as a percentage, uphill or downhill. */
  maxGradePct: number;
  minElevationM: number;
  maxElevationM: number;
  startElevationM: number;
  endElevationM: number;
  minutes: number;
}

export function routeStats(grid: Grid, path: ArrayLike<number>, activity: Activity): RouteStats {
  if (path.length === 0) throw new Error("Cannot summarise an empty path.");
  let distanceM = 0;
  let horizontalM = 0;
  let climbM = 0;
  let descentM = 0;
  let maxGrade = 0;
  let min = grid.z[path[0]];
  let max = min;
  for (let i = 1; i < path.length; i++) {
    const run = stepRun(grid, path[i - 1], path[i]);
    const dz = grid.z[path[i]] - grid.z[path[i - 1]];
    horizontalM += run;
    distanceM += Math.sqrt(run * run + dz * dz);
    if (dz > 0) climbM += dz;
    else descentM -= dz;
    if (run > 0) maxGrade = Math.max(maxGrade, Math.abs(dz) / run);
    const elevation = grid.z[path[i]];
    if (elevation < min) min = elevation;
    if (elevation > max) max = elevation;
  }
  return {
    distanceM,
    horizontalM,
    climbM,
    descentM,
    maxGradePct: maxGrade * 100,
    minElevationM: min,
    maxElevationM: max,
    startElevationM: grid.z[path[0]],
    endElevationM: grid.z[path[path.length - 1]],
    minutes: estimateMinutes(horizontalM, climbM, activity),
  };
}

export interface Profile {
  /** Cumulative 3D distance at each path node, metres. Starts at 0. */
  distance: Float32Array;
  elevation: Float32Array;
}

export function elevationProfile(grid: Grid, path: ArrayLike<number>): Profile {
  const distance = new Float32Array(path.length);
  const elevation = new Float32Array(path.length);
  let total = 0;
  for (let i = 0; i < path.length; i++) {
    if (i > 0) {
      const run = stepRun(grid, path[i - 1], path[i]);
      const dz = grid.z[path[i]] - grid.z[path[i - 1]];
      total += Math.sqrt(run * run + dz * dz);
    }
    distance[i] = total;
    elevation[i] = grid.z[path[i]];
  }
  return { distance, elevation };
}

export interface ProfileSample {
  /** Fractional index into the path. */
  index: number;
  distanceM: number;
  elevationM: number;
  /** Grade of the step being travelled, percent, signed (positive is uphill). */
  gradePct: number;
}

/** The point a fraction `t` (0 to 1) of the way along the route by distance. */
export function sampleProfile(profile: Profile, t: number): ProfileSample {
  const { distance, elevation } = profile;
  const last = distance.length - 1;
  if (last <= 0) {
    return { index: 0, distanceM: 0, elevationM: elevation[0] ?? 0, gradePct: 0 };
  }
  const target = Math.min(Math.max(t, 0), 1) * distance[last];
  // Binary search for the step that contains the target distance.
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (distance[mid] <= target) lo = mid;
    else hi = mid;
  }
  const span = distance[hi] - distance[lo];
  const f = span > 0 ? (target - distance[lo]) / span : 0;
  const dz = elevation[hi] - elevation[lo];
  const run = Math.sqrt(Math.max(span * span - dz * dz, 0));
  return {
    index: lo + f,
    distanceM: target,
    elevationM: elevation[lo] + dz * f,
    gradePct: run > 0 ? (dz / run) * 100 : 0,
  };
}

/** Thins a profile to at most `maxPoints` for drawing, always keeping both ends. */
export function thinProfile(profile: Profile, maxPoints: number): Profile {
  const count = profile.distance.length;
  if (count <= maxPoints) return profile;
  const distance = new Float32Array(maxPoints);
  const elevation = new Float32Array(maxPoints);
  for (let i = 0; i < maxPoints; i++) {
    const source = Math.round((i / (maxPoints - 1)) * (count - 1));
    distance[i] = profile.distance[source];
    elevation[i] = profile.elevation[source];
  }
  return { distance, elevation };
}
