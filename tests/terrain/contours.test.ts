import { describe, expect, it } from "vitest";
import {
  CELL_EDGES,
  contourLevels,
  contourLines,
  contours,
  saddleSegments,
  segmentCount,
  type Polyline,
} from "@/lib/terrain/contours";
import { elevationAt, makeGrid, type Grid } from "@/lib/terrain/grid";

const { TOP, RIGHT, BOTTOM, LEFT } = CELL_EDGES;

function pointsOf(line: Polyline): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < line.points.length; i += 2) out.push([line.points[i], line.points[i + 1]]);
  return out;
}

/** Every vertex must sit on a grid edge at exactly the contour's elevation. */
function expectOnLevel(grid: Grid, lines: Polyline[], level: number) {
  for (const line of lines) {
    for (const [col, row] of pointsOf(line)) {
      const onEdge =
        Math.abs(col - Math.round(col)) < 1e-6 || Math.abs(row - Math.round(row)) < 1e-6;
      expect(onEdge).toBe(true);
      expect(elevationAt(grid, col, row)).toBeCloseTo(level, 2);
    }
  }
}

function cone(size: number, peak: number, falloff: number) {
  const centre = (size - 1) / 2;
  return makeGrid(
    size,
    size,
    10,
    10,
    (col, row) => peak - falloff * Math.hypot(col - centre, row - centre),
  );
}

describe("marching squares: single cell", () => {
  it("draws nothing when all corners are on the same side", () => {
    const flat = makeGrid(2, 2, 1, 1, () => 5);
    expect(contourLines(flat, 4)).toEqual([]);
    expect(contourLines(flat, 6)).toEqual([]);
  });

  it("cuts off a single high corner with one segment, interpolated along the edges", () => {
    // Top-left is 10, the rest 0: the level-2.5 contour crosses the top and left edges a quarter...
    // of the way from the low end, i.e. three quarters of the way from the high corner.
    const grid = makeGrid(2, 2, 1, 1, (col, row) => (col === 0 && row === 0 ? 10 : 0));
    const lines = contourLines(grid, 2.5);
    expect(lines).toHaveLength(1);
    expect(lines[0].closed).toBe(false);
    const points = pointsOf(lines[0]).sort((a, b) => a[0] - b[0]);
    expect(points[0][0]).toBeCloseTo(0, 6);
    expect(points[0][1]).toBeCloseTo(0.75, 6);
    expect(points[1][0]).toBeCloseTo(0.75, 6);
    expect(points[1][1]).toBeCloseTo(0, 6);
  });

  it("splits a row of highs from a row of lows with a straight line", () => {
    const grid = makeGrid(2, 2, 1, 1, (_col, row) => (row === 0 ? 8 : 0));
    const lines = contourLines(grid, 2);
    expect(lines).toHaveLength(1);
    for (const [, row] of pointsOf(lines[0])) expect(row).toBeCloseTo(0.75, 6);
  });
});

describe("marching squares: saddles", () => {
  // Top-left and bottom-right high (10), top-right 0, bottom-left 2. Centre value 5.5.
  const saddle = makeGrid(2, 2, 1, 1, (col, row) => (col === row ? 10 : col === 1 ? 0 : 2));

  it("joins the two highs when the cell centre is above the level", () => {
    // Level 5 < centre 5.5: the highs form one band, so each low corner is cut off on its own.
    const lines = contourLines(saddle, 5);
    expect(lines).toHaveLength(2);
    const nearTopRight = lines.find((line) =>
      pointsOf(line).some(([col, row]) => col === 1 && row < 1),
    );
    const nearBottomLeft = lines.find((line) =>
      pointsOf(line).some(([col, row]) => col === 0 && row > 0),
    );
    expect(nearTopRight).toBeDefined();
    expect(nearBottomLeft).toBeDefined();
    expect(nearTopRight).not.toBe(nearBottomLeft);
    // The segment round the top-right corner touches the top and right edges only.
    for (const [col, row] of pointsOf(nearTopRight!)) expect(row === 0 || col === 1).toBe(true);
  });

  it("keeps the two highs apart when the cell centre is below the level", () => {
    // Level 6 > centre 5.5: each high corner is cut off on its own.
    const lines = contourLines(saddle, 6);
    expect(lines).toHaveLength(2);
    const nearTopLeft = lines.find((line) =>
      pointsOf(line).some(([col, row]) => col === 0 && row < 1),
    );
    expect(nearTopLeft).toBeDefined();
    for (const [col, row] of pointsOf(nearTopLeft!)) expect(row === 0 || col === 0).toBe(true);
  });

  it("the decision table mirrors between the two saddle cases", () => {
    expect(saddleSegments(5, true)).toEqual([TOP, LEFT, BOTTOM, RIGHT]);
    expect(saddleSegments(5, false)).toEqual([TOP, RIGHT, LEFT, BOTTOM]);
    expect(saddleSegments(10, true)).toEqual([TOP, RIGHT, LEFT, BOTTOM]);
    expect(saddleSegments(10, false)).toEqual([TOP, LEFT, BOTTOM, RIGHT]);
  });

  it("a saddle between two hills merges their contours below the pass and splits them above", () => {
    // Two cones 12 cells apart; the pass between them is at 100 - 6 * 6 = 64.
    const grid = makeGrid(33, 17, 10, 10, (col, row) =>
      Math.max(100 - 6 * Math.hypot(col - 10, row - 8), 100 - 6 * Math.hypot(col - 22, row - 8)),
    );
    const above = contourLines(grid, 80);
    const below = contourLines(grid, 60);
    expect(above).toHaveLength(2);
    expect(above.every((line) => line.closed)).toBe(true);
    expect(below).toHaveLength(1);
    expect(below[0].closed).toBe(true);
    expectOnLevel(grid, above, 80);
    expectOnLevel(grid, below, 60);
  });
});

describe("marching squares: joined polylines", () => {
  it("turns a hill into one closed loop per level", () => {
    const grid = cone(21, 100, 8);
    for (const level of [30, 50, 70, 90]) {
      const lines = contourLines(grid, level);
      expect(lines).toHaveLength(1);
      expect(lines[0].closed).toBe(true);
      expectOnLevel(grid, lines, level);
      // Every vertex is roughly the right distance from the summit.
      const radius = (100 - level) / 8;
      for (const [col, row] of pointsOf(lines[0])) {
        expect(Math.hypot(col - 10, row - 10)).toBeGreaterThan(radius - 0.75);
        expect(Math.hypot(col - 10, row - 10)).toBeLessThan(radius + 0.75);
      }
    }
  });

  it("visits each crossing once: a loop has as many segments as vertices", () => {
    const lines = contourLines(cone(21, 100, 8), 50);
    const vertices = lines[0].points.length / 2;
    expect(segmentCount(lines)).toBe(vertices);
    const unique = new Set(
      pointsOf(lines[0]).map(([col, row]) => `${col.toFixed(4)},${row.toFixed(4)}`),
    );
    expect(unique.size).toBe(vertices);
  });

  it("turns a tilted plane into one open line from edge to edge", () => {
    const grid = makeGrid(12, 9, 10, 10, (col, row) => col * 10 + row * 3);
    const lines = contourLines(grid, 47);
    expect(lines).toHaveLength(1);
    expect(lines[0].closed).toBe(false);
    expectOnLevel(grid, lines, 47);
    const points = pointsOf(lines[0]);
    const ends = [points[0], points[points.length - 1]];
    for (const [col, row] of ends) {
      const onBoundary =
        col < 1e-6 || row < 1e-6 || Math.abs(col - 11) < 1e-6 || Math.abs(row - 8) < 1e-6;
      expect(onBoundary).toBe(true);
    }
    // Consecutive vertices are neighbours: never more than one cell apart.
    for (let i = 1; i < points.length; i++) {
      expect(Math.abs(points[i][0] - points[i - 1][0])).toBeLessThanOrEqual(1 + 1e-6);
      expect(Math.abs(points[i][1] - points[i - 1][1])).toBeLessThanOrEqual(1 + 1e-6);
    }
  });

  it("joins a ring that leaves the grid into separate open pieces", () => {
    // A cone centred on the west edge: the loop is cut by the boundary into one open arc.
    const grid = makeGrid(11, 11, 10, 10, (col, row) => 100 - 10 * Math.hypot(col, row - 5));
    const lines = contourLines(grid, 60);
    expect(lines).toHaveLength(1);
    expect(lines[0].closed).toBe(false);
  });

  it("copes with samples exactly on the level", () => {
    const grid = makeGrid(5, 5, 10, 10, (col, row) => (col === 2 && row === 2 ? 10 : 0));
    const lines = contourLines(grid, 10);
    for (const line of lines) {
      for (const value of line.points) expect(Number.isFinite(value)).toBe(true);
    }
    expect(contourLines(grid, 0)).toEqual([]);
  });

  it("is deterministic", () => {
    const grid = cone(17, 90, 7);
    expect(contourLines(grid, 40)).toEqual(contourLines(grid, 40));
  });
});

describe("contour levels", () => {
  it("lists the multiples of the interval strictly inside the range", () => {
    expect(contourLevels(1337.2, 1500, 40)).toEqual([1360, 1400, 1440, 1480]);
    expect(contourLevels(100, 200, 50)).toEqual([150]);
    expect(contourLevels(10, 20, 50)).toEqual([]);
  });

  it("rejects a non-positive interval", () => {
    expect(() => contourLevels(0, 100, 0)).toThrow();
  });

  it("traces every level of a grid in one call", () => {
    const grid = cone(21, 100, 8);
    const all = contours(grid, 20);
    expect(all.map((entry) => entry.level)).toEqual(
      [0, 20, 40, 60, 80].filter((level) => level > Math.min(...grid.z)),
    );
    for (const entry of all) expectOnLevel(grid, entry.lines, entry.level);
    // Reusing scratch space between levels must not leak state from one level into the next.
    expect(all.find((entry) => entry.level === 60)!.lines).toEqual(contourLines(grid, 60));
  });
});
