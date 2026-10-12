import { describe, expect, it } from "vitest";
import { makeGrid } from "@/lib/terrain/grid";
import { gridToScene, pickTerrain, sceneToGrid } from "@/lib/terrain/pick";
import { shadeTerrain, tintAt } from "@/lib/terrain/shade";
import { SLOPE_BANDS } from "@/lib/terrain/slope";
import {
  feetToMetres,
  formatDistance,
  formatDuration,
  formatGrade,
  formatHeight,
  metresToFeet,
} from "@/lib/terrain/units";

describe("scene coordinates", () => {
  const grid = makeGrid(11, 7, 30, 20, (col) => 1000 + col * 10);
  const frame = { baseElevation: 1000, exaggeration: 2 };

  it("puts the middle of the map at the origin, east on +x and south on +z", () => {
    expect(gridToScene(grid, frame, 5, 3)).toEqual([0, 100, 0]);
    expect(gridToScene(grid, frame, 10, 6)).toEqual([150, 200, 60]);
    expect(gridToScene(grid, frame, 0, 0)).toEqual([-150, 0, -60]);
  });

  it("round-trips through sceneToGrid", () => {
    const [x, , z] = gridToScene(grid, frame, 7.25, 1.5);
    const back = sceneToGrid(grid, x, z);
    expect(back.col).toBeCloseTo(7.25, 9);
    expect(back.row).toBeCloseTo(1.5, 9);
  });
});

describe("ray picking against the heightfield", () => {
  const flat = makeGrid(21, 21, 10, 10, () => 500);
  const frame = { baseElevation: 500, exaggeration: 1 };

  it("a ray straight down lands directly below its origin", () => {
    const hit = pickTerrain(flat, frame, [30, 400, -20], [0, -1, 0]);
    expect(hit?.col).toBeCloseTo(13, 6);
    expect(hit?.row).toBeCloseTo(8, 6);
  });

  it("a slanted ray hits a flat plane where the geometry says it should", () => {
    // From 100 m up, heading east and down at 45 degrees: lands 100 m further east.
    const hit = pickTerrain(flat, frame, [-50, 100, 0], [1, -1, 0]);
    expect(hit?.col).toBeCloseTo(10 + 5, 3);
    expect(hit?.row).toBeCloseTo(10, 6);
  });

  it("stops at the first slope it meets, not the ground behind it", () => {
    // A 200 m ridge running north-south through the middle of the map.
    const ridge = makeGrid(
      41,
      5,
      10,
      10,
      (col) => 500 + Math.max(0, 200 - Math.abs(col - 20) * 40),
    );
    // A level ray 100 m up, travelling east from the west edge: the ridge face is at 100 m
    // when |col - 20| * 40 = 100, i.e. col 17.5.
    const hit = pickTerrain(ridge, frame, [-200, 100, 0], [1, 0, 0]);
    expect(hit?.col).toBeCloseTo(17.5, 2);
  });

  it("respects vertical exaggeration", () => {
    const ramp = makeGrid(21, 3, 10, 10, (col) => 500 + col * 5);
    const hit = pickTerrain(
      ramp,
      { baseElevation: 500, exaggeration: 2 },
      [-100, 60, 0],
      [1, 0, 0],
    );
    // Exaggerated height is 10 m per column, so 60 m is reached at column 6.
    expect(hit?.col).toBeCloseTo(6, 2);
  });

  it("returns null for rays that miss", () => {
    expect(pickTerrain(flat, frame, [0, 100, 0], [0, 1, 0])).toBeNull(); // pointing at the sky
    expect(pickTerrain(flat, frame, [5000, 100, 0], [0, -1, 0])).toBeNull(); // off the map
    expect(pickTerrain(flat, frame, [-500, 100, 0], [1, 0, 0])).toBeNull(); // level, above everything
    expect(pickTerrain(flat, frame, [0, 100, 0], [0, 0, 0])).toBeNull(); // no direction
  });
});

describe("the shaded texture", () => {
  it("interpolates the elevation tint between its stops and clamps outside them", () => {
    expect(tintAt(1300)).toEqual([206, 211, 176]);
    expect(tintAt(900)).toEqual([206, 211, 176]);
    expect(tintAt(4000)).toEqual([246, 244, 238]);
    const mid = tintAt(1500);
    expect(mid[0]).toBeCloseTo((206 + 174) / 2, 6);
    expect(mid[1]).toBeCloseTo((211 + 192) / 2, 6);
  });

  it("leaves flat ground at its tint, with or without hillshade", () => {
    const flat = makeGrid(4, 4, 30, 30, () => 2100);
    const plain = shadeTerrain(flat, { hillshade: false, slopeBands: false, dark: false });
    const shaded = shadeTerrain(flat, { hillshade: true, slopeBands: false, dark: false });
    expect(Array.from(plain.slice(0, 4))).toEqual([128, 162, 110, 255]);
    expect(Array.from(shaded.slice(0, 4))).toEqual([128, 162, 110, 255]);
    expect(plain).toHaveLength(4 * 4 * 4);
  });

  it("lights slopes facing north-west and darkens slopes facing south-east", () => {
    // Rising toward the south-east, so the slope faces north-west, into the light.
    const lit = makeGrid(5, 5, 30, 30, (col, row) => 2100 + (col + row) * 6);
    const dark = makeGrid(5, 5, 30, 30, (col, row) => 2100 - (col + row) * 6);
    const centre = (2 * 5 + 2) * 4;
    const options = { hillshade: true, slopeBands: false, dark: false };
    const flatGreen = tintAt(lit.z[12])[1];
    expect(shadeTerrain(lit, options)[centre + 1]).toBeGreaterThan(flatGreen);
    expect(shadeTerrain(dark, options)[centre + 1]).toBeLessThan(tintAt(dark.z[12])[1] * 0.9);
  });

  it("paints slope bands only where the ground is steep enough", () => {
    // 38 degrees: inside the red 35-45 band.
    const steep = makeGrid(5, 5, 30, 30, (col) => 2000 + col * 30 * Math.tan((38 * Math.PI) / 180));
    const gentle = makeGrid(
      5,
      5,
      30,
      30,
      (col) => 2000 + col * 30 * Math.tan((10 * Math.PI) / 180),
    );
    const centre = (2 * 5 + 2) * 4;
    const on = { hillshade: false, slopeBands: true, dark: false };
    const off = { hillshade: false, slopeBands: false, dark: false };
    const red = SLOPE_BANDS.find((band) => band.label === "35-45°")!.color;
    const banded = shadeTerrain(steep, on);
    const base = shadeTerrain(steep, off);
    expect(banded[centre]).toBeCloseTo(base[centre] * 0.22 + red[0] * 0.78, -1);
    expect(banded[centre]).toBeGreaterThan(banded[centre + 2]); // clearly red
    expect(shadeTerrain(gentle, on)).toEqual(shadeTerrain(gentle, off));
  });

  it("dims every channel for the dark theme", () => {
    const grid = makeGrid(3, 3, 30, 30, () => 2500);
    const light = shadeTerrain(grid, { hillshade: false, slopeBands: false, dark: false });
    const dark = shadeTerrain(grid, { hillshade: false, slopeBands: false, dark: true });
    expect(dark[0]).toBeLessThan(light[0]);
    expect(dark[1]).toBeLessThan(light[1]);
    expect(dark[3]).toBe(255);
  });
});

describe("units", () => {
  it("converts feet and metres exactly", () => {
    expect(feetToMetres(2000)).toBeCloseTo(609.6, 9);
    expect(metresToFeet(609.6)).toBeCloseTo(2000, 9);
  });

  it("formats distance, height, duration and grade for display", () => {
    expect(formatDistance(11909, "imperial")).toBe("7.4 mi");
    expect(formatDistance(11909, "metric")).toBe("11.9 km");
    expect(formatHeight(563.9, "imperial")).toBe("1,850 ft");
    expect(formatHeight(563.9, "metric")).toBe("564 m");
    expect(formatDuration(125)).toBe("2 h 05 min");
    expect(formatDuration(45.4)).toBe("45 min");
    expect(formatDuration(119.6)).toBe("2 h 00 min");
    expect(formatGrade(-17.6)).toBe("18%");
  });
});
