import { describe, expect, it } from "vitest";
import {
  decimate,
  elevationAt,
  gridToLonLat,
  lonLatToGrid,
  makeGrid,
  nearestNode,
} from "@/lib/terrain/grid";
import {
  DEFAULT_SUN,
  SLOPE_BANDS,
  aspectDegrees,
  gradientAt,
  hillshade,
  slopeBandIndex,
  slopeDegrees,
  slopeField,
  sunVector,
} from "@/lib/terrain/slope";

/** A plane rising `east` metres per metre eastward and `north` per metre northward. */
function plane(east: number, north: number, cellX = 30, cellY = 30, size = 9) {
  return makeGrid(
    size,
    size,
    cellX,
    cellY,
    (col, row) => east * col * cellX + north * (size - 1 - row) * cellY,
  );
}

describe("grid sampling", () => {
  const grid = makeGrid(4, 3, 10, 10, (col, row) => col * 100 + row * 10);

  it("interpolates bilinearly between samples", () => {
    expect(elevationAt(grid, 1, 1)).toBe(110);
    expect(elevationAt(grid, 1.5, 1)).toBeCloseTo(160, 5);
    expect(elevationAt(grid, 1.5, 0.5)).toBeCloseTo(155, 5);
  });

  it("clamps positions outside the grid to the edge", () => {
    expect(elevationAt(grid, -5, -5)).toBe(0);
    expect(elevationAt(grid, 99, 99)).toBe(320);
    expect(nearestNode(grid, 99, -3)).toBe(3);
  });

  it("decimation keeps every other sample and doubles the cell size", () => {
    const fine = makeGrid(9, 5, 10, 12, (col, row) => col + row * 100);
    const coarse = decimate(fine, 2);
    expect([coarse.width, coarse.height, coarse.cellX, coarse.cellY]).toEqual([5, 3, 20, 24]);
    expect(coarse.z[1 * 5 + 2]).toBe(fine.z[2 * 9 + 4]);
  });

  it("maps longitude and latitude to grid positions and back", () => {
    const meta = {
      width: 1024,
      height: 640,
      bounds: { west: -111.83, south: 40.52, east: -111.45, north: 40.7 },
    };
    expect(lonLatToGrid(meta, -111.83, 40.7)).toEqual({ col: 0, row: 0 });
    const corner = lonLatToGrid(meta, -111.45, 40.52);
    expect(corner.col).toBeCloseTo(1023, 6);
    expect(corner.row).toBeCloseTo(639, 6);
    const back = gridToLonLat(meta, 300, 200);
    const again = lonLatToGrid(meta, back.lon, back.lat);
    expect(again.col).toBeCloseTo(300, 6);
    expect(again.row).toBeCloseTo(200, 6);
  });
});

describe("slope from central differences in metres", () => {
  it("is zero on flat ground", () => {
    const flat = makeGrid(5, 5, 30, 30, () => 2000);
    expect(slopeDegrees(gradientAt(flat, 2, 2))).toBe(0);
    expect(aspectDegrees(gradientAt(flat, 2, 2))).toBeNull();
  });

  it("recovers the angle of a tilted plane", () => {
    const grid = plane(Math.tan((30 * Math.PI) / 180), 0);
    expect(slopeDegrees(gradientAt(grid, 4, 4))).toBeCloseTo(30, 4);
  });

  it("uses the real cell size, not grid units", () => {
    // The same one-metre rise per column is steep on 1 m cells and gentle on 100 m cells.
    const steep = makeGrid(5, 5, 1, 1, (col) => col);
    const gentle = makeGrid(5, 5, 100, 100, (col) => col);
    expect(slopeDegrees(gradientAt(steep, 2, 2))).toBeCloseTo(45, 5);
    expect(slopeDegrees(gradientAt(gentle, 2, 2))).toBeCloseTo(0.573, 3);
  });

  it("handles cells that are not square", () => {
    // 1 m of rise per column east and per row north, on 20 m by 40 m cells.
    const grid = makeGrid(7, 7, 20, 40, (col, row) => col + (6 - row));
    const gradient = gradientAt(grid, 3, 3);
    expect(gradient.east).toBeCloseTo(1 / 20, 6);
    expect(gradient.north).toBeCloseTo(1 / 40, 6);
    expect(slopeDegrees(gradient)).toBeCloseTo(
      (Math.atan(Math.hypot(1 / 20, 1 / 40)) * 180) / Math.PI,
      5,
    );
  });

  it("falls back to one-sided differences on the edges", () => {
    const grid = plane(0.25, -0.1);
    for (const [col, row] of [
      [0, 0],
      [8, 0],
      [0, 8],
      [8, 8],
      [4, 0],
    ]) {
      const gradient = gradientAt(grid, col, row);
      expect(gradient.east).toBeCloseTo(0.25, 5);
      expect(gradient.north).toBeCloseTo(-0.1, 5);
    }
  });

  it("slopeField agrees with the per-sample calculation", () => {
    const grid = makeGrid(6, 4, 30, 30, (col, row) => Math.sin(col) * 40 + row * row * 5);
    const field = slopeField(grid);
    expect(field).toHaveLength(24);
    expect(field[2 * 6 + 3]).toBeCloseTo(slopeDegrees(gradientAt(grid, 3, 2)), 5);
  });
});

describe("aspect", () => {
  it("is the compass direction the slope faces (downhill)", () => {
    // Rising to the east means the slope faces west.
    expect(aspectDegrees(gradientAt(plane(0.2, 0), 4, 4))).toBeCloseTo(270, 5);
    expect(aspectDegrees(gradientAt(plane(-0.2, 0), 4, 4))).toBeCloseTo(90, 5);
    // Rising to the north means the slope faces south.
    expect(aspectDegrees(gradientAt(plane(0, 0.2), 4, 4))).toBeCloseTo(180, 5);
    expect(aspectDegrees(gradientAt(plane(0, -0.2), 4, 4))).toBeCloseTo(0, 5);
    expect(aspectDegrees(gradientAt(plane(-0.2, -0.2), 4, 4))).toBeCloseTo(45, 5);
  });
});

describe("hillshade", () => {
  const light = sunVector(DEFAULT_SUN);

  it("points the default sun north-west and 45 degrees up", () => {
    expect(light[0]).toBeCloseTo(-0.5, 6);
    expect(light[1]).toBeCloseTo(0.5, 6);
    expect(light[2]).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it("gives flat ground the sine of the sun's altitude", () => {
    expect(hillshade({ east: 0, north: 0 }, light)).toBeCloseTo(Math.sin(Math.PI / 4), 6);
  });

  it("is brightest for a slope facing the sun and dark for one facing away", () => {
    // Facing north-west at 45 degrees: the normal points straight at the sun.
    const facing = hillshade({ east: Math.SQRT1_2, north: -Math.SQRT1_2 }, light);
    const away = hillshade({ east: -Math.SQRT1_2, north: Math.SQRT1_2 }, light);
    expect(facing).toBeCloseTo(1, 6);
    expect(away).toBe(0);
  });

  it("never leaves the range 0 to 1", () => {
    for (let east = -3; east <= 3; east += 0.75) {
      for (let north = -3; north <= 3; north += 0.75) {
        const shade = hillshade({ east, north }, light);
        expect(shade).toBeGreaterThanOrEqual(0);
        expect(shade).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("slope bands", () => {
  it("leaves terrain under 27 degrees unshaded", () => {
    expect(slopeBandIndex(0)).toBe(-1);
    expect(slopeBandIndex(26.99)).toBe(-1);
  });

  it("puts each angle in the band that contains it", () => {
    expect(SLOPE_BANDS[slopeBandIndex(27)].label).toBe("27-29°");
    expect(SLOPE_BANDS[slopeBandIndex(31.9)].label).toBe("30-31°");
    expect(SLOPE_BANDS[slopeBandIndex(34)].label).toBe("32-34°");
    expect(SLOPE_BANDS[slopeBandIndex(38)].label).toBe("35-45°");
    expect(SLOPE_BANDS[slopeBandIndex(47)].label).toBe("46-50°");
    expect(SLOPE_BANDS[slopeBandIndex(55)].label).toBe("51-59°");
    expect(SLOPE_BANDS[slopeBandIndex(89)].label).toBe("60°+");
  });

  it("covers 27 to 90 degrees with no gaps or overlaps", () => {
    for (let i = 1; i < SLOPE_BANDS.length; i++) {
      expect(SLOPE_BANDS[i].from).toBe(SLOPE_BANDS[i - 1].to);
    }
    expect(SLOPE_BANDS[0].from).toBe(27);
    expect(SLOPE_BANDS[SLOPE_BANDS.length - 1].to).toBeGreaterThan(90);
  });
});
