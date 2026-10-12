import { describe, expect, it } from "vitest";
import { decodeHeightmap, elevationRange, lonLatToGrid } from "@/lib/terrain/grid";
import { LANDMARKS, LANDMARK_IDS, findLandmark, landmarkNode } from "@/lib/terrain/landmarks";
import { loadWasatch } from "../helpers/wasatch";

const FT = 0.3048;

describe("the committed heightmap", () => {
  const { grid, meta } = loadWasatch();

  it("decodes to the range its metadata declares", () => {
    const range = elevationRange(grid);
    expect(grid.z).toHaveLength(meta.width * meta.height);
    expect(range.min).toBeCloseTo(meta.minElevation, 1);
    expect(range.max).toBeCloseTo(meta.maxElevation, 1);
    expect(grid.cellX).toBeCloseTo(31.36, 1);
    expect(grid.cellY).toBeCloseTo(31.32, 1);
  });

  it("rejects a file of the wrong size", () => {
    expect(() => decodeHeightmap(new ArrayBuffer(10), meta)).toThrow(/expected/);
  });

  it("names its source and says whether it is real terrain", () => {
    expect(typeof meta.synthetic).toBe("boolean");
    expect(meta.source.attribution.length).toBeGreaterThan(20);
    expect(meta.accessed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("landmarks checked against the heightmap", () => {
  const { grid, meta } = loadWasatch();

  it("have unique, URL-safe ids", () => {
    expect(new Set(LANDMARK_IDS).size).toBe(LANDMARKS.length);
    for (const id of LANDMARK_IDS) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(findLandmark("alta")?.name).toBe("Alta");
    expect(findLandmark("nowhere")).toBeNull();
  });

  it("all lie inside the map, away from the very edge", () => {
    for (const landmark of LANDMARKS) {
      const { col, row } = lonLatToGrid(meta, landmark.lon, landmark.lat);
      expect(col, landmark.id).toBeGreaterThan(8);
      expect(col, landmark.id).toBeLessThan(meta.width - 9);
      expect(row, landmark.id).toBeGreaterThan(8);
      expect(row, landmark.id).toBeLessThan(meta.height - 9);
    }
  });

  // These two checks only mean something on real terrain.
  it.skipIf(meta.synthetic)("agree with their published elevations", () => {
    for (const landmark of LANDMARKS) {
      if (landmark.publishedFt === null) continue;
      const elevation = grid.z[landmarkNode(grid, meta, landmark)];
      // A 31 m grid rounds off sharp summits, so peaks get a little more slack.
      const tolerance = landmark.kind === "peak" ? 25 : 20;
      expect(Math.abs(elevation - landmark.publishedFt * FT), landmark.id).toBeLessThan(tolerance);
    }
  });

  it.skipIf(meta.synthetic)("peaks sit on local summits", () => {
    for (const landmark of LANDMARKS.filter((entry) => entry.kind === "peak")) {
      const node = landmarkNode(grid, meta, landmark);
      const col = node % grid.width;
      const row = Math.floor(node / grid.width);
      let higher = 0;
      // Nothing within about 150 m may be more than a couple of metres higher.
      for (let dr = -5; dr <= 5; dr++) {
        for (let dc = -5; dc <= 5; dc++) {
          if (grid.z[(row + dr) * grid.width + col + dc] > grid.z[node] + 2) higher++;
        }
      }
      expect(higher, landmark.id).toBe(0);
    }
  });
});
