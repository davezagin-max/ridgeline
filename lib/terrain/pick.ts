/**
 * Where a ray hits the terrain: used to turn a click on the 3D view into a
 * grid position without asking the renderer to test 300,000 triangles.
 *
 * Scene coordinates: x runs east and z runs south, both in metres from the
 * centre of the map; y is height above the lowest elevation, multiplied by the
 * vertical exaggeration.
 */
import { elevationAt, type Grid, type GridPoint } from "./grid";

export interface SceneFrame {
  /** Elevation that maps to y = 0. */
  baseElevation: number;
  /** Vertical exaggeration applied to heights. */
  exaggeration: number;
}

export type Vec3 = readonly [number, number, number];

export function gridToScene(
  grid: Grid,
  frame: SceneFrame,
  col: number,
  row: number,
): [number, number, number] {
  return [
    (col - (grid.width - 1) / 2) * grid.cellX,
    (elevationAt(grid, col, row) - frame.baseElevation) * frame.exaggeration,
    (row - (grid.height - 1) / 2) * grid.cellY,
  ];
}

export function sceneToGrid(grid: Grid, x: number, z: number): GridPoint {
  return {
    col: x / grid.cellX + (grid.width - 1) / 2,
    row: z / grid.cellY + (grid.height - 1) / 2,
  };
}

/**
 * Marches along the ray in half-cell steps until it dips below the surface,
 * then bisects to refine. Returns the grid position of the hit, or null when
 * the ray never meets the terrain.
 */
export function pickTerrain(
  grid: Grid,
  frame: SceneFrame,
  origin: Vec3,
  direction: Vec3,
): GridPoint | null {
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  if (length === 0) return null;
  const dx = direction[0] / length;
  const dy = direction[1] / length;
  const dz = direction[2] / length;

  const halfX = ((grid.width - 1) / 2) * grid.cellX;
  const halfZ = ((grid.height - 1) / 2) * grid.cellY;

  // Clip the ray to the map's footprint (a slab test on x and z).
  let near = 0;
  let far = Infinity;
  for (const [o, d, half] of [
    [origin[0], dx, halfX],
    [origin[2], dz, halfZ],
  ] as const) {
    if (Math.abs(d) < 1e-12) {
      if (o < -half || o > half) return null;
      continue;
    }
    const t0 = (-half - o) / d;
    const t1 = (half - o) / d;
    near = Math.max(near, Math.min(t0, t1));
    far = Math.min(far, Math.max(t0, t1));
  }
  if (near > far) return null;
  if (far === Infinity) far = near + 1e6; // a vertical ray: x and z never leave the footprint

  const above = (t: number): number => {
    const x = origin[0] + dx * t;
    const z = origin[2] + dz * t;
    const { col, row } = sceneToGrid(grid, x, z);
    const ground = (elevationAt(grid, col, row) - frame.baseElevation) * frame.exaggeration;
    return origin[1] + dy * t - ground;
  };

  const horizontal = Math.hypot(dx, dz);
  const step = horizontal > 1e-6 ? Math.min(grid.cellX, grid.cellY) / 2 / horizontal : Infinity;

  let previous = near;
  if (above(previous) < 0) return null; // the ray starts underground
  if (step === Infinity) {
    // Straight down (or up): one sample decides.
    if (dy >= 0) return null;
    const t = above(near) / -dy + near;
    return sceneToGrid(grid, origin[0] + dx * t, origin[2] + dz * t);
  }
  for (let t = near + step; ; t += step) {
    const clamped = Math.min(t, far);
    if (above(clamped) < 0) {
      let lo = previous;
      let hi = clamped;
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        if (above(mid) < 0) hi = mid;
        else lo = mid;
      }
      const hit = (lo + hi) / 2;
      return sceneToGrid(grid, origin[0] + dx * hit, origin[2] + dz * hit);
    }
    if (clamped >= far) return null;
    previous = clamped;
  }
}
