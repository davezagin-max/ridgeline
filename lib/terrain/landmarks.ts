/**
 * Named places for orientation and for routing by name.
 *
 * Positions were entered by hand and then checked against the heightmap
 * (`tests/terrain/landmarks.test.ts`): every peak sits on a local summit, and
 * every landmark with a published elevation agrees with the terrain under it.
 * They are approximate map labels, not survey points.
 */
import raw from "../data/landmarks.json";
import { lonLatToGrid, nearestNode, type Grid, type GridMeta } from "./grid";

export type LandmarkKind = "resort" | "town" | "pass" | "trailhead" | "lake" | "peak";

export interface Landmark {
  id: string;
  name: string;
  kind: LandmarkKind;
  lat: number;
  lon: number;
  /** Commonly published elevation in feet, when one is well known. */
  publishedFt: number | null;
}

export const LANDMARKS: readonly Landmark[] = raw as Landmark[];

export const LANDMARK_IDS: readonly string[] = LANDMARKS.map((landmark) => landmark.id);

export function findLandmark(id: string): Landmark | null {
  return LANDMARKS.find((landmark) => landmark.id === id) ?? null;
}

/** The grid node nearest a landmark. */
export function landmarkNode(
  grid: Grid,
  meta: Pick<GridMeta, "width" | "height" | "bounds">,
  landmark: Landmark,
): number {
  const { col, row } = lonLatToGrid(meta, landmark.lon, landmark.lat);
  return nearestNode(grid, col, row);
}
