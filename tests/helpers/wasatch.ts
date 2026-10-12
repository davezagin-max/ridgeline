import { readFileSync } from "node:fs";
import path from "node:path";
import { decodeHeightmap, type Grid, type GridMeta } from "@/lib/terrain/grid";

const DATA = path.resolve(import.meta.dirname, "../../public/data");

let cached: { grid: Grid; meta: GridMeta } | null = null;

/** The committed heightmap, decoded once per test process. */
export function loadWasatch(): { grid: Grid; meta: GridMeta } {
  if (!cached) {
    const meta = JSON.parse(readFileSync(path.join(DATA, "wasatch.json"), "utf8")) as GridMeta;
    const file = readFileSync(path.join(DATA, "wasatch.u16"));
    const buffer = file.buffer.slice(
      file.byteOffset,
      file.byteOffset + file.byteLength,
    ) as ArrayBuffer;
    cached = { grid: decodeHeightmap(buffer, meta), meta };
  }
  return cached;
}
