/**
 * Slope, aspect and hillshade from the elevation grid.
 *
 * Gradients are rise over run in real metres: the difference between the two
 * neighbours divided by the distance between them (`2 * cellX` east-west,
 * `2 * cellY` north-south), not by "2 grid units". On the edges, where one
 * neighbour is missing, the one-sided difference is used instead.
 */
import type { Grid } from "./grid";

export interface Gradient {
  /** Rise per metre travelled east. */
  east: number;
  /** Rise per metre travelled north. */
  north: number;
}

export function gradientAt(grid: Grid, col: number, row: number): Gradient {
  const { width, height, cellX, cellY, z } = grid;
  const west = Math.max(col - 1, 0);
  const eastCol = Math.min(col + 1, width - 1);
  const northRow = Math.max(row - 1, 0);
  const southRow = Math.min(row + 1, height - 1);
  const i = row * width;
  const east = (z[i + eastCol] - z[i + west]) / ((eastCol - west) * cellX || 1);
  // Row numbers grow southward, so "north minus south" is the northward rise.
  const north =
    (z[northRow * width + col] - z[southRow * width + col]) / ((southRow - northRow) * cellY || 1);
  return { east, north };
}

/** Steepness in degrees: 0 is flat, 45 rises one metre per metre. */
export function slopeDegrees(gradient: Gradient): number {
  return (Math.atan(Math.hypot(gradient.east, gradient.north)) * 180) / Math.PI;
}

/**
 * Compass bearing the slope faces, which is the downhill direction:
 * 0 = north, 90 = east, 180 = south, 270 = west. Null on flat ground.
 */
export function aspectDegrees(gradient: Gradient): number | null {
  if (gradient.east === 0 && gradient.north === 0) return null;
  const bearing = (Math.atan2(-gradient.east, -gradient.north) * 180) / Math.PI;
  return (bearing + 360) % 360;
}

export interface Sun {
  /** Compass bearing of the light source. Maps conventionally light from the north-west. */
  azimuth: number;
  /** Height above the horizon in degrees. */
  altitude: number;
}

export const DEFAULT_SUN: Sun = { azimuth: 315, altitude: 45 };

/** Unit vector pointing from the ground toward the sun, as (east, north, up). */
export function sunVector(sun: Sun): [number, number, number] {
  const azimuth = (sun.azimuth * Math.PI) / 180;
  const altitude = (sun.altitude * Math.PI) / 180;
  return [
    Math.sin(azimuth) * Math.cos(altitude),
    Math.cos(azimuth) * Math.cos(altitude),
    Math.sin(altitude),
  ];
}

/**
 * Lambertian hillshade in [0, 1]: the cosine of the angle between the surface
 * normal and the sun. The normal of a surface with gradient (gx, gy) is
 * (-gx, -gy, 1) normalised. Flat ground gives sin(altitude).
 */
export function hillshade(gradient: Gradient, light: readonly [number, number, number]): number {
  const length = Math.sqrt(gradient.east * gradient.east + gradient.north * gradient.north + 1);
  const dot = (-gradient.east * light[0] - gradient.north * light[1] + light[2]) / length;
  return dot > 0 ? dot : 0;
}

/** Slope in degrees for every sample. */
export function slopeField(grid: Grid): Float32Array {
  const out = new Float32Array(grid.width * grid.height);
  for (let row = 0; row < grid.height; row++) {
    for (let col = 0; col < grid.width; col++) {
      out[row * grid.width + col] = slopeDegrees(gradientAt(grid, col, row));
    }
  }
  return out;
}

export interface SlopeBand {
  /** Inclusive lower bound in degrees. */
  from: number;
  /** Exclusive upper bound in degrees. */
  to: number;
  label: string;
  color: readonly [number, number, number];
}

/**
 * The slope-angle colouring ski tourers know from avalanche-terrain maps:
 * nothing below 27 degrees, then yellow through orange to red across the
 * angles where most slab avalanches release, and cooler colours for terrain
 * that is usually too steep to hold a slab.
 */
export const SLOPE_BANDS: readonly SlopeBand[] = [
  { from: 27, to: 30, label: "27-29°", color: [245, 224, 66] },
  { from: 30, to: 32, label: "30-31°", color: [247, 184, 52] },
  { from: 32, to: 35, label: "32-34°", color: [240, 134, 40] },
  { from: 35, to: 46, label: "35-45°", color: [214, 48, 49] },
  { from: 46, to: 51, label: "46-50°", color: [152, 78, 184] },
  { from: 51, to: 60, label: "51-59°", color: [62, 96, 200] },
  { from: 60, to: 91, label: "60°+", color: [34, 34, 38] },
];

/** Index into `SLOPE_BANDS`, or -1 below the first band. */
export function slopeBandIndex(degrees: number): number {
  if (degrees < SLOPE_BANDS[0].from) return -1;
  for (let i = 0; i < SLOPE_BANDS.length; i++) {
    if (degrees < SLOPE_BANDS[i].to) return i;
  }
  return SLOPE_BANDS.length - 1;
}
