/**
 * Contour lines by marching squares, joined into polylines.
 *
 * Each grid cell is classified by which of its four corners are at or above
 * the level (16 cases). A contour crosses a cell edge exactly when the edge's
 * two ends are on opposite sides, and the crossing point is found by linear
 * interpolation along that edge.
 *
 * Joining works on edge identity, not on coordinates: the crossing on a given
 * grid edge is computed once, from that edge's two samples, so the two cells
 * that share the edge agree on it exactly. Every crossing is used by at most
 * one segment in each of those two cells, so each crossing has at most two
 * neighbours, and following neighbours yields simple chains: open lines that
 * end on the grid boundary, and closed loops.
 *
 * Saddles (cases 5 and 10: two opposite corners high, two low) are ambiguous:
 * the highs could be joined through the cell or kept apart. The cell-centre
 * value (the mean of the four corners) decides.
 */
import type { Grid } from "./grid";

export interface Polyline {
  /** Flat [col, row, col, row, ...] in fractional grid coordinates. */
  points: Float32Array;
  /** True when the line returns to its start. The first point is not repeated. */
  closed: boolean;
}

export interface ContourLevel {
  level: number;
  lines: Polyline[];
}

// Cell edges, in the order used by the case table.
const TOP = 0;
const RIGHT = 1;
const BOTTOM = 2;
const LEFT = 3;

/**
 * Segments per case, as pairs of cell edges. Corner bits: top-left 8,
 * top-right 4, bottom-right 2, bottom-left 1 (set when the corner is at or
 * above the level). Cases 5 and 10 are handled separately.
 */
const SEGMENTS: readonly (readonly number[])[] = [
  [], // 0  all low
  [LEFT, BOTTOM], // 1  bottom-left high
  [BOTTOM, RIGHT], // 2  bottom-right high
  [LEFT, RIGHT], // 3  bottom row high
  [TOP, RIGHT], // 4  top-right high
  [], // 5  saddle: top-right and bottom-left high
  [TOP, BOTTOM], // 6  right column high
  [TOP, LEFT], // 7  only top-left low
  [TOP, LEFT], // 8  top-left high
  [TOP, BOTTOM], // 9  left column high
  [], // 10 saddle: top-left and bottom-right high
  [TOP, RIGHT], // 11 only top-right low
  [LEFT, RIGHT], // 12 top row high
  [BOTTOM, RIGHT], // 13 only bottom-right low
  [LEFT, BOTTOM], // 14 only bottom-left low
  [], // 15 all high
];

/** Segments for a saddle, given the case and whether the cell centre is at or above the level. */
export function saddleSegments(caseIndex: 5 | 10, centreHigh: boolean): number[] {
  // Case 5 has highs at top-right and bottom-left. If the centre is high they are
  // one region, so the contour cuts off the two low corners (top-left, bottom-right).
  // Otherwise each high corner is cut off on its own. Case 10 is the mirror image.
  const cutTopLeftAndBottomRight = caseIndex === 5 ? centreHigh : !centreHigh;
  return cutTopLeftAndBottomRight ? [TOP, LEFT, BOTTOM, RIGHT] : [TOP, RIGHT, LEFT, BOTTOM];
}

export const CELL_EDGES = { TOP, RIGHT, BOTTOM, LEFT } as const;

/** Reusable scratch space so tracing many levels allocates once. */
interface Scratch {
  /** Up to two neighbouring edge ids per edge id, -1 when empty. */
  linkA: Int32Array;
  linkB: Int32Array;
  visited: Uint8Array;
}

function createScratch(grid: Grid): Scratch {
  const edges = grid.width * grid.height * 2;
  return {
    linkA: new Int32Array(edges).fill(-1),
    linkB: new Int32Array(edges).fill(-1),
    visited: new Uint8Array(edges),
  };
}

function traceLevel(grid: Grid, level: number, scratch: Scratch): Polyline[] {
  const { width, height, z } = grid;
  const { linkA, linkB, visited } = scratch;
  const nodes = width * height;
  const touched: number[] = [];

  // Edge ids: the horizontal edge leaving node n eastward is n; the vertical
  // edge leaving node n southward is nodes + n.
  const link = (a: number, b: number) => {
    if (linkA[a] === -1) {
      if (linkB[a] === -1) touched.push(a);
      linkA[a] = b;
    } else linkB[a] = b;
    if (linkA[b] === -1) {
      if (linkB[b] === -1) touched.push(b);
      linkA[b] = a;
    } else linkB[b] = a;
  };

  for (let row = 0; row < height - 1; row++) {
    for (let col = 0; col < width - 1; col++) {
      const n = row * width + col;
      const tl = z[n];
      const tr = z[n + 1];
      const bl = z[n + width];
      const br = z[n + width + 1];
      const caseIndex =
        (tl >= level ? 8 : 0) |
        (tr >= level ? 4 : 0) |
        (br >= level ? 2 : 0) |
        (bl >= level ? 1 : 0);
      if (caseIndex === 0 || caseIndex === 15) continue;
      const edgeIds = [n, nodes + n + 1, n + width, nodes + n]; // top, right, bottom, left
      const segments =
        caseIndex === 5 || caseIndex === 10
          ? saddleSegments(caseIndex, (tl + tr + bl + br) / 4 >= level)
          : SEGMENTS[caseIndex];
      for (let s = 0; s < segments.length; s += 2) {
        link(edgeIds[segments[s]], edgeIds[segments[s + 1]]);
      }
    }
  }

  const pointOf = (edge: number, out: number[]) => {
    const vertical = edge >= nodes;
    const n = vertical ? edge - nodes : edge;
    const col = n % width;
    const row = (n - col) / width;
    const a = z[n];
    const b = z[vertical ? n + width : n + 1];
    // The ends straddle the level, so a !== b and 0 <= t <= 1.
    const t = (level - a) / (b - a);
    if (vertical) out.push(col, row + t);
    else out.push(col + t, row);
  };

  const walk = (start: number): Polyline => {
    const points: number[] = [];
    let previous = -1;
    let current = start;
    let closed = false;
    for (;;) {
      visited[current] = 1;
      pointOf(current, points);
      const a = linkA[current];
      const b = linkB[current];
      const next = a !== -1 && a !== previous ? a : b !== previous ? b : -1;
      if (next === -1) break;
      if (next === start) {
        closed = true;
        break;
      }
      if (visited[next]) break;
      previous = current;
      current = next;
    }
    return { points: Float32Array.from(points), closed };
  };

  const lines: Polyline[] = [];
  // Open lines first: start from crossings that have a single neighbour.
  for (const edge of touched) {
    if (!visited[edge] && linkB[edge] === -1) lines.push(walk(edge));
  }
  // Whatever is left is made of loops.
  for (const edge of touched) {
    if (!visited[edge]) lines.push(walk(edge));
  }

  for (const edge of touched) {
    linkA[edge] = -1;
    linkB[edge] = -1;
    visited[edge] = 0;
  }
  return lines;
}

/** The joined contour lines of one elevation. */
export function contourLines(grid: Grid, level: number): Polyline[] {
  return traceLevel(grid, level, createScratch(grid));
}

/** Multiples of `interval` strictly inside (min, max). */
export function contourLevels(min: number, max: number, interval: number): number[] {
  if (!(interval > 0)) throw new Error("Contour interval must be positive.");
  const levels: number[] = [];
  for (
    let level = Math.floor(min / interval) * interval + interval;
    level < max;
    level += interval
  ) {
    if (level > min) levels.push(level);
  }
  return levels;
}

/** Contours at every multiple of `interval` the grid crosses. */
export function contours(grid: Grid, interval: number): ContourLevel[] {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < grid.z.length; i++) {
    if (grid.z[i] < min) min = grid.z[i];
    if (grid.z[i] > max) max = grid.z[i];
  }
  const scratch = createScratch(grid);
  return contourLevels(min, max, interval)
    .map((level) => ({ level, lines: traceLevel(grid, level, scratch) }))
    .filter((entry) => entry.lines.length > 0);
}

/** Total number of line segments across polylines (a closed line has one extra). */
export function segmentCount(lines: readonly Polyline[]): number {
  let count = 0;
  for (const line of lines) {
    const points = line.points.length / 2;
    count += line.closed ? points : Math.max(points - 1, 0);
  }
  return count;
}
