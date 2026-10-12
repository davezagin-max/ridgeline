import { lonLatToGrid, type GridMeta } from "@/lib/terrain/grid";
import { findLandmark } from "@/lib/terrain/landmarks";
import type { RouteMode } from "@/lib/terrain/route";
import type { Activity, RouteStats } from "@/lib/terrain/stats";

/** One end of a route: a grid position, and the landmark it came from if any. */
export interface RoutePoint {
  col: number;
  row: number;
  landmarkId: string | null;
}

/** What the routing controls currently say. A new object means "route again". */
export interface RouteSpec {
  start: RoutePoint;
  goal: RoutePoint;
  mode: RouteMode;
  maxGradePct: number;
  roundTrip: boolean;
  activity: Activity;
}

/** The route on screen. */
export interface RouteView {
  spec: RouteSpec;
  found: boolean;
  path: Int32Array | null;
  stats: RouteStats | null;
  /** Search effort, for the footnote under the stats. */
  expanded: number;
  ms: number;
  /** Set when the route came from the planner rather than the controls. */
  planned: boolean;
}

/** Which end the next click on the map sets. Picking always goes start, then end. */
export type PickTarget = "start" | "goal";

export function landmarkPoint(meta: GridMeta, id: string): RoutePoint {
  const landmark = findLandmark(id);
  if (!landmark) throw new Error(`Unknown landmark: ${id}`);
  const { col, row } = lonLatToGrid(meta, landmark.lon, landmark.lat);
  return { col: Math.round(col), row: Math.round(row), landmarkId: id };
}

export function pointNode(meta: GridMeta, point: RoutePoint): number {
  const col = Math.min(Math.max(Math.round(point.col), 0), meta.width - 1);
  const row = Math.min(Math.max(Math.round(point.row), 0), meta.height - 1);
  return row * meta.width + col;
}

export function defaultSpec(meta: GridMeta): RouteSpec {
  return {
    start: landmarkPoint(meta, "alta"),
    goal: landmarkPoint(meta, "park-city"),
    mode: "climb-friendly",
    maxGradePct: 30,
    roundTrip: false,
    activity: "hike",
  };
}
