/** Messages between the page and the terrain worker. */
import type { RouteConstraints } from "../plan/constraints";
import type { RoutePlan } from "../plan/planner";
import type { GridMeta } from "../terrain/grid";
import type { RouteMode } from "../terrain/route";
import type { ShadeOptions } from "../terrain/shade";
import type { Activity, RouteStats } from "../terrain/stats";

export interface RouteRequest {
  start: number;
  goal: number;
  mode: RouteMode;
  /** Grade limit as a fraction: 0.3 is 30%. */
  maxGrade: number;
  roundTrip: boolean;
  activity: Activity;
}

export interface RouteResponse {
  found: boolean;
  path: Int32Array;
  stats: RouteStats | null;
  /** Nodes the search expanded and how long it took, shown in the UI. */
  expanded: number;
  ms: number;
}

export interface ContourResponse {
  /** Line-segment endpoints as x, y, z triples in scene metres (y is height above the base). */
  minor: Float32Array<ArrayBuffer>;
  /** Every fifth level, drawn heavier. */
  index: Float32Array<ArrayBuffer>;
  levels: number;
  ms: number;
}

export type PlanResponse = RoutePlan & { ms: number };

export interface Calls {
  init: { request: { buffer: ArrayBuffer; meta: GridMeta }; response: { nodes: number } };
  shade: { request: ShadeOptions; response: { pixels: Uint8ClampedArray<ArrayBuffer> } };
  contours: { request: { interval: number }; response: ContourResponse };
  route: { request: RouteRequest; response: RouteResponse };
  plan: { request: { constraints: RouteConstraints }; response: PlanResponse };
}

export type CallName = keyof Calls;

export interface WorkerRequest<N extends CallName = CallName> {
  id: number;
  type: N;
  payload: Calls[N]["request"];
}

export type WorkerResponse<N extends CallName = CallName> =
  { id: number; ok: true; result: Calls[N]["response"] } | { id: number; ok: false; error: string };

/** The mesh and the contours use every `MESH_STEP`-th sample of the heightmap. */
export const MESH_STEP = 2;
/** Every fifth contour is an index contour. */
export const INDEX_EVERY = 5;
