/**
 * Trail routing: A* over the heightmap as an 8-connected grid graph.
 *
 * Cost of stepping from one sample to a neighbour:
 *
 *   3D length of the step
 *   + climbWeight   * metres gained                    (only when going up)
 *   + descentWeight * metres lost on a steep descent   (only when steeper than descentGrade)
 *
 * and the step does not exist at all when its grade (rise over horizontal run,
 * up or down) exceeds `maxGrade`. That hard limit is the "max-grade wall".
 *
 * The heuristic is a lower bound on the remaining cost, so the first time the
 * goal is taken off the queue its cost is optimal:
 *
 *   sqrt(octile(node, goal)^2 + dz^2) + climbWeight * max(0, zGoal - zNode)
 *
 * `octile` is the shortest horizontal distance using only the 8 grid
 * directions; no path can be shorter in 3D than that distance combined with
 * the height difference, and no path can avoid climbing at least the net gain.
 * The bound is also consistent (it never drops by more than the cost of the
 * step taken), so a node's cost is final once it has been expanded.
 */
import type { Grid } from "./grid";

export interface RouteOptions {
  /** Extra cost per metre climbed, in metres of distance. */
  climbWeight: number;
  /** Extra cost per metre descended on steps steeper than `descentGrade`. */
  descentWeight: number;
  /** Downhill grade (rise over run) beyond which the descent penalty applies. */
  descentGrade: number;
  /** Steps steeper than this (rise over run, either direction) are forbidden. */
  maxGrade: number;
}

export type RouteMode = "climb-friendly" | "shortest";

/**
 * The two modes differ only in the climb weight. With everything else equal,
 * raising the weight can never produce a route with more climbing (see the
 * exchange argument in the tests), which is what makes "climb-friendly" a
 * promise rather than a hope.
 *
 * 30 means a metre of climbing costs as much as 30 metres of extra distance,
 * so the router will go a long way round to stay on a gentle line.
 */
export const MODE_CLIMB_WEIGHT: Record<RouteMode, number> = {
  shortest: 0,
  "climb-friendly": 30,
};

export const DEFAULT_ROUTE_OPTIONS: Omit<RouteOptions, "climbWeight"> = {
  descentWeight: 2,
  descentGrade: 0.15,
  maxGrade: 0.3,
};

export function optionsFor(
  mode: RouteMode,
  maxGrade = DEFAULT_ROUTE_OPTIONS.maxGrade,
): RouteOptions {
  return { ...DEFAULT_ROUTE_OPTIONS, maxGrade, climbWeight: MODE_CLIMB_WEIGHT[mode] };
}

export interface SearchResult {
  found: boolean;
  /** Node indices from start to goal, inclusive. Empty when not found. */
  path: Int32Array;
  /** Total cost of the path under the options used. */
  cost: number;
  /** How many nodes were expanded, for the UI and for performance tests. */
  expanded: number;
}

// Neighbour offsets: E, W, S, N, then the four diagonals.
const DCOL = [1, -1, 0, 0, 1, 1, -1, -1];
const DROW = [0, 0, 1, -1, 1, -1, 1, -1];

/** Cost of one step, or Infinity when the grade limit forbids it. */
export function stepCost(run: number, dz: number, options: RouteOptions): number {
  const grade = Math.abs(dz) / run;
  if (grade > options.maxGrade) return Infinity;
  let cost = Math.sqrt(run * run + dz * dz);
  if (dz > 0) cost += options.climbWeight * dz;
  else if (grade > options.descentGrade) cost += options.descentWeight * -dz;
  return cost;
}

/** A binary min-heap of (priority, node) pairs in flat arrays. */
class MinHeap {
  private keys: Float64Array;
  private values: Int32Array;
  size = 0;

  constructor(capacity = 1024) {
    this.keys = new Float64Array(capacity);
    this.values = new Int32Array(capacity);
  }

  clear(): void {
    this.size = 0;
  }

  push(key: number, value: number): void {
    if (this.size === this.keys.length) {
      const keys = new Float64Array(this.size * 2);
      const values = new Int32Array(this.size * 2);
      keys.set(this.keys);
      values.set(this.values);
      this.keys = keys;
      this.values = values;
    }
    let i = this.size++;
    const { keys, values } = this;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= key) break;
      keys[i] = keys[parent];
      values[i] = values[parent];
      i = parent;
    }
    keys[i] = key;
    values[i] = value;
  }

  /** Removes the entry with the smallest priority and returns its node. */
  pop(): number {
    const { keys, values } = this;
    const top = values[0];
    const size = --this.size;
    if (size > 0) {
      const key = keys[size];
      const value = values[size];
      let i = 0;
      for (;;) {
        let child = 2 * i + 1;
        if (child >= size) break;
        if (child + 1 < size && keys[child + 1] < keys[child]) child++;
        if (keys[child] >= key) break;
        keys[i] = keys[child];
        values[i] = values[child];
        i = child;
      }
      keys[i] = key;
      values[i] = value;
    }
    return top;
  }
}

/**
 * Holds the search buffers for one grid so repeated searches reuse them.
 * Not re-entrant: one search at a time (it lives in a worker).
 */
export class Router {
  readonly grid: Grid;
  private readonly best: Float64Array;
  private readonly parent: Int32Array;
  private readonly closed: Uint8Array;
  private readonly heap = new MinHeap(4096);
  private readonly runs: number[];

  constructor(grid: Grid) {
    this.grid = grid;
    const nodes = grid.width * grid.height;
    this.best = new Float64Array(nodes);
    this.parent = new Int32Array(nodes);
    this.closed = new Uint8Array(nodes);
    const diagonal = Math.hypot(grid.cellX, grid.cellY);
    this.runs = [
      grid.cellX,
      grid.cellX,
      grid.cellY,
      grid.cellY,
      diagonal,
      diagonal,
      diagonal,
      diagonal,
    ];
  }

  /** Shortest horizontal distance between two nodes using only the 8 grid directions. */
  octile(a: number, b: number): number {
    const { width, cellX, cellY } = this.grid;
    const dc = Math.abs((a % width) - (b % width));
    const dr = Math.abs(Math.floor(a / width) - Math.floor(b / width));
    const diagonalSteps = Math.min(dc, dr);
    return (
      diagonalSteps * this.runs[4] + (dc - diagonalSteps) * cellX + (dr - diagonalSteps) * cellY
    );
  }

  /** Lower bound on the cost from `node` to `goal`. */
  heuristic(node: number, goal: number, options: RouteOptions): number {
    const dz = this.grid.z[goal] - this.grid.z[node];
    const flat = this.octile(node, goal);
    return Math.sqrt(flat * flat + dz * dz) + (dz > 0 ? options.climbWeight * dz : 0);
  }

  /**
   * A* from `start` to `goal`. With `goal` = -1 it runs to exhaustion (plain
   * Dijkstra), leaving the cheapest cost and parent of every reachable node
   * in the buffers for `costTo` and `pathTo`.
   */
  search(start: number, goal: number, options: RouteOptions): SearchResult {
    const { width, height, z } = this.grid;
    const { best, parent, closed, heap, runs } = this;
    best.fill(Infinity);
    parent.fill(-1);
    closed.fill(0);
    heap.clear();

    const toGoal = goal >= 0;
    best[start] = 0;
    heap.push(toGoal ? this.heuristic(start, goal, options) : 0, start);
    let expanded = 0;

    while (heap.size > 0) {
      const node = heap.pop();
      if (closed[node]) continue; // a stale queue entry: this node was already settled
      closed[node] = 1;
      expanded++;
      if (node === goal) break;

      const col = node % width;
      const row = (node - col) / width;
      const here = z[node];
      const cost = best[node];
      for (let d = 0; d < 8; d++) {
        const c = col + DCOL[d];
        const r = row + DROW[d];
        if (c < 0 || r < 0 || c >= width || r >= height) continue;
        const next = r * width + c;
        if (closed[next]) continue;
        const step = stepCost(runs[d], z[next] - here, options);
        if (step === Infinity) continue;
        const candidate = cost + step;
        if (candidate < best[next]) {
          best[next] = candidate;
          parent[next] = node;
          heap.push(toGoal ? candidate + this.heuristic(next, goal, options) : candidate, next);
        }
      }
    }

    if (!toGoal) return { found: true, path: new Int32Array(0), cost: 0, expanded };
    const path = this.pathTo(goal, start);
    return {
      found: path.length > 0,
      path,
      cost: path.length > 0 ? best[goal] : Infinity,
      expanded,
    };
  }

  /** Cost of the cheapest path to `node` from the last search's start, or Infinity. */
  costTo(node: number): number {
    return this.closed[node] ? this.best[node] : Infinity;
  }

  /** The path found by the last search from `start` to `node`; empty when unreachable. */
  pathTo(node: number, start: number): Int32Array {
    if (!this.closed[node]) return new Int32Array(0);
    const reversed: number[] = [];
    for (let at = node; at !== -1; at = this.parent[at]) reversed.push(at);
    if (reversed[reversed.length - 1] !== start) return new Int32Array(0);
    return Int32Array.from(reversed.reverse());
  }
}

/** One-off search. Prefer a `Router` when searching the same grid repeatedly. */
export function findRoute(
  grid: Grid,
  start: number,
  goal: number,
  options: RouteOptions,
): SearchResult {
  return new Router(grid).search(start, goal, options);
}

/** Cost of an existing path under the given options (Infinity if a step breaks the grade limit). */
export function pathCost(grid: Grid, path: ArrayLike<number>, options: RouteOptions): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += stepCost(
      stepRun(grid, path[i - 1], path[i]),
      grid.z[path[i]] - grid.z[path[i - 1]],
      options,
    );
  }
  return total;
}

/** Horizontal distance between two neighbouring nodes. */
export function stepRun(grid: Grid, a: number, b: number): number {
  const dc = (b % grid.width) - (a % grid.width);
  const dr = Math.floor(b / grid.width) - Math.floor(a / grid.width);
  return Math.hypot(dc * grid.cellX, dr * grid.cellY);
}
