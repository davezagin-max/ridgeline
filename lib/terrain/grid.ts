/**
 * The heightmap as a plain grid of elevations in metres.
 *
 * Row 0 is the north edge and column 0 the west edge. Samples sit on the cell
 * corners ("node registered"), so a `width` x `height` grid spans
 * `(width - 1) * cellX` metres east-west. Pure functions only: this module runs
 * unchanged in the browser, in the worker, and in Node tests.
 */

export interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** `public/data/wasatch.json`, written by `tools/terrain/build.py`. */
export interface GridMeta {
  name: string;
  width: number;
  height: number;
  bounds: Bounds;
  /** Metres between neighbouring samples, east-west and north-south. */
  cellX: number;
  cellY: number;
  minElevation: number;
  maxElevation: number;
  encoding: { file: string; type: string; offset: number; scale: number; rowOrder: string };
  /** True when the terrain is generated noise rather than measured elevation. */
  synthetic: boolean;
  source: {
    name: string;
    url: string | null;
    license: string | null;
    attribution: string;
    processing: string;
  };
  accessed: string;
}

export interface Grid {
  width: number;
  height: number;
  cellX: number;
  cellY: number;
  /** Elevation in metres, row-major, `z[row * width + col]`. */
  z: Float32Array;
}

export interface GridPoint {
  col: number;
  row: number;
}

/** Unpacks the little-endian uint16 file into metres. */
export function decodeHeightmap(buffer: ArrayBuffer, meta: GridMeta): Grid {
  const count = meta.width * meta.height;
  if (buffer.byteLength !== count * 2) {
    throw new Error(`Heightmap is ${buffer.byteLength} bytes; expected ${count * 2}.`);
  }
  const view = new DataView(buffer);
  const z = new Float32Array(count);
  const { offset, scale } = meta.encoding;
  for (let i = 0; i < count; i++) z[i] = offset + view.getUint16(i * 2, true) * scale;
  return { width: meta.width, height: meta.height, cellX: meta.cellX, cellY: meta.cellY, z };
}

/** Builds a grid from a function of (col, row). Used by tests and the synthetic fallback. */
export function makeGrid(
  width: number,
  height: number,
  cellX: number,
  cellY: number,
  elevation: (col: number, row: number) => number,
): Grid {
  const z = new Float32Array(width * height);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) z[row * width + col] = elevation(col, row);
  }
  return { width, height, cellX, cellY, z };
}

export function nodeIndex(grid: Grid, col: number, row: number): number {
  return row * grid.width + col;
}

export function nodePoint(grid: Grid, index: number): GridPoint {
  return { col: index % grid.width, row: Math.floor(index / grid.width) };
}

/** Nearest grid node to a fractional position, clamped to the grid. */
export function nearestNode(grid: Grid, col: number, row: number): number {
  const c = Math.min(Math.max(Math.round(col), 0), grid.width - 1);
  const r = Math.min(Math.max(Math.round(row), 0), grid.height - 1);
  return r * grid.width + c;
}

/** Bilinear elevation at a fractional grid position, clamped to the edges. */
export function elevationAt(grid: Grid, col: number, row: number): number {
  const { width, height, z } = grid;
  const c = Math.min(Math.max(col, 0), width - 1);
  const r = Math.min(Math.max(row, 0), height - 1);
  const c0 = Math.min(Math.floor(c), width - 2);
  const r0 = Math.min(Math.floor(r), height - 2);
  const tc = c - c0;
  const tr = r - r0;
  const i = r0 * width + c0;
  const top = z[i] * (1 - tc) + z[i + 1] * tc;
  const bottom = z[i + width] * (1 - tc) + z[i + width + 1] * tc;
  return top * (1 - tr) + bottom * tr;
}

/** Every `step`-th sample in each direction. Keeps the last row and column aligned to the edge. */
export function decimate(grid: Grid, step: number): Grid {
  if (step <= 1) return grid;
  const width = Math.floor((grid.width - 1) / step) + 1;
  const height = Math.floor((grid.height - 1) / step) + 1;
  const z = new Float32Array(width * height);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      z[row * width + col] = grid.z[row * step * grid.width + col * step];
    }
  }
  return { width, height, cellX: grid.cellX * step, cellY: grid.cellY * step, z };
}

export function lonLatToGrid(
  meta: Pick<GridMeta, "width" | "height" | "bounds">,
  lon: number,
  lat: number,
): GridPoint {
  const { west, east, south, north } = meta.bounds;
  return {
    col: ((lon - west) / (east - west)) * (meta.width - 1),
    row: ((north - lat) / (north - south)) * (meta.height - 1),
  };
}

export function gridToLonLat(
  meta: Pick<GridMeta, "width" | "height" | "bounds">,
  col: number,
  row: number,
): { lon: number; lat: number } {
  const { west, east, south, north } = meta.bounds;
  return {
    lon: west + (col / (meta.width - 1)) * (east - west),
    lat: north - (row / (meta.height - 1)) * (north - south),
  };
}

export function elevationRange(grid: Grid): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < grid.z.length; i++) {
    const value = grid.z[i];
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { min, max };
}
