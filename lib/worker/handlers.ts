/**
 * What the terrain worker does, as plain functions so tests can call them
 * without a Worker. The worker file is a thin message loop around this.
 */
import { planRoute, roundTripPath } from "../plan/planner";
import { contours } from "../terrain/contours";
import { decimate, decodeHeightmap, type Grid, type GridMeta } from "../terrain/grid";
import { Router, optionsFor } from "../terrain/route";
import { shadeTerrain } from "../terrain/shade";
import { routeStats } from "../terrain/stats";
import {
  INDEX_EVERY,
  MESH_STEP,
  type Calls,
  type ContourResponse,
  type PlanResponse,
  type RouteRequest,
  type RouteResponse,
} from "./protocol";

export interface TerrainState {
  grid: Grid;
  coarse: Grid;
  meta: GridMeta;
  router: Router;
}

export function createState(buffer: ArrayBuffer, meta: GridMeta): TerrainState {
  const grid = decodeHeightmap(buffer, meta);
  return { grid, coarse: decimate(grid, MESH_STEP), meta, router: new Router(grid) };
}

const now = () => performance.now();

/** Contours of the coarse grid as line segments in scene metres. */
export function contourSegments(state: TerrainState, interval: number): ContourResponse {
  const started = now();
  const { coarse, meta, grid } = state;
  const levels = contours(coarse, interval);
  const halfX = ((grid.width - 1) / 2) * grid.cellX;
  const halfZ = ((grid.height - 1) / 2) * grid.cellY;

  const build = (wanted: (level: number) => boolean): Float32Array<ArrayBuffer> => {
    let segments = 0;
    for (const entry of levels) {
      if (!wanted(entry.level)) continue;
      for (const line of entry.lines) {
        const points = line.points.length / 2;
        segments += line.closed ? points : Math.max(points - 1, 0);
      }
    }
    const out = new Float32Array(segments * 6);
    let o = 0;
    for (const entry of levels) {
      if (!wanted(entry.level)) continue;
      const y = entry.level - meta.minElevation;
      for (const line of entry.lines) {
        const { points, closed } = line;
        const count = points.length / 2;
        const last = closed ? count : count - 1;
        for (let i = 0; i < last; i++) {
          const j = (i + 1) % count;
          out[o++] = points[i * 2] * coarse.cellX - halfX;
          out[o++] = y;
          out[o++] = points[i * 2 + 1] * coarse.cellY - halfZ;
          out[o++] = points[j * 2] * coarse.cellX - halfX;
          out[o++] = y;
          out[o++] = points[j * 2 + 1] * coarse.cellY - halfZ;
        }
      }
    }
    return out;
  };

  const isIndex = (level: number) => Math.round(level / interval) % INDEX_EVERY === 0;
  return {
    minor: build((level) => !isIndex(level)),
    index: build(isIndex),
    levels: levels.length,
    ms: now() - started,
  };
}

export function route(state: TerrainState, request: RouteRequest): RouteResponse {
  const started = now();
  const result = state.router.search(
    request.start,
    request.goal,
    optionsFor(request.mode, request.maxGrade),
  );
  if (!result.found) {
    return {
      found: false,
      path: new Int32Array(0),
      stats: null,
      expanded: result.expanded,
      ms: now() - started,
    };
  }
  const path = request.roundTrip ? roundTripPath(result.path) : result.path;
  return {
    found: true,
    path,
    stats: routeStats(state.grid, path, request.activity),
    expanded: result.expanded,
    ms: now() - started,
  };
}

export function plan(state: TerrainState, request: Calls["plan"]["request"]): PlanResponse {
  const started = now();
  const result = planRoute(state.router, state.meta, request.constraints);
  return { ...result, ms: now() - started };
}

export function shade(
  state: TerrainState,
  options: Calls["shade"]["request"],
): Calls["shade"]["response"] {
  return { pixels: shadeTerrain(state.grid, options) };
}
