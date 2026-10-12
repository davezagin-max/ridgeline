/**
 * Bakes the map's look into one RGBA image: an elevation tint, multiplied by
 * hillshade, with the slope-angle bands laid over the top. The 3D mesh uses the
 * image as its texture and the 2D fallback draws it directly, so the two views
 * can never disagree, and toggling a layer is one pass over the pixels rather
 * than any per-vertex work in React.
 */
import type { Grid } from "./grid";
import {
  DEFAULT_SUN,
  SLOPE_BANDS,
  gradientAt,
  hillshade,
  slopeBandIndex,
  slopeDegrees,
  sunVector,
} from "./slope";

export interface ShadeOptions {
  hillshade: boolean;
  slopeBands: boolean;
  /** A dimmer palette for the dark theme. */
  dark: boolean;
}

type Rgb = readonly [number, number, number];

/** Elevation tint in the style of a printed topo sheet: valley sage up to pale rock. */
const TINT: readonly (readonly [number, Rgb])[] = [
  [1300, [206, 211, 176]],
  [1700, [174, 192, 142]],
  [2100, [128, 162, 110]],
  [2500, [104, 140, 96]],
  [2800, [150, 152, 112]],
  [3100, [190, 174, 142]],
  [3350, [226, 219, 206]],
  [3500, [246, 244, 238]],
];

const BAND_OPACITY = 0.78;

/** Tint colour for an elevation, linearly interpolated between the stops. */
export function tintAt(elevation: number): [number, number, number] {
  if (elevation <= TINT[0][0]) return [...TINT[0][1]];
  for (let i = 1; i < TINT.length; i++) {
    if (elevation <= TINT[i][0]) {
      const [e0, c0] = TINT[i - 1];
      const [e1, c1] = TINT[i];
      const t = (elevation - e0) / (e1 - e0);
      return [
        c0[0] + (c1[0] - c0[0]) * t,
        c0[1] + (c1[1] - c0[1]) * t,
        c0[2] + (c1[2] - c0[2]) * t,
      ];
    }
  }
  return [...TINT[TINT.length - 1][1]];
}

/** RGBA pixels, one per grid sample, row 0 at the north edge. */
export function shadeTerrain(grid: Grid, options: ShadeOptions): Uint8ClampedArray<ArrayBuffer> {
  const { width, height, z } = grid;
  const pixels = new Uint8ClampedArray(width * height * 4);
  const light = sunVector(DEFAULT_SUN);
  const flat = light[2]; // hillshade of level ground
  const dim = options.dark ? 0.74 : 1;

  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const i = row * width + col;
      const gradient = gradientAt(grid, col, row);
      let [r, g, b] = tintAt(z[i]);

      if (options.hillshade) {
        // Level ground keeps its tint; slopes toward the sun brighten, slopes away darken.
        const shade = hillshade(gradient, light);
        const factor = 0.42 + 0.58 * (shade / flat);
        r *= factor;
        g *= factor;
        b *= factor;
      }

      if (options.slopeBands) {
        const band = slopeBandIndex(slopeDegrees(gradient));
        if (band >= 0) {
          const color = SLOPE_BANDS[band].color;
          r = r * (1 - BAND_OPACITY) + color[0] * BAND_OPACITY;
          g = g * (1 - BAND_OPACITY) + color[1] * BAND_OPACITY;
          b = b * (1 - BAND_OPACITY) + color[2] * BAND_OPACITY;
        }
      }

      const p = i * 4;
      pixels[p] = r * dim;
      pixels[p + 1] = g * dim;
      pixels[p + 2] = b * dim;
      pixels[p + 3] = 255;
    }
  }
  return pixels;
}
