import type { Grid, GridMeta } from "@/lib/terrain/grid";
import type { Landmark } from "@/lib/terrain/landmarks";
import type { ContourResponse } from "@/lib/worker/protocol";

/** Everything a map view needs to draw. Both the 3D and the 2D view take exactly this. */
export interface MapViewProps {
  grid: Grid;
  meta: GridMeta;
  /** Shaded RGBA texture from the worker, or null while it is being computed. */
  pixels: Uint8ClampedArray<ArrayBuffer> | null;
  /** Contour segments, or null when the layer is off. */
  contours: ContourResponse | null;
  /** Route as node indices, or null when there is none. */
  path: Int32Array | null;
  /** Start and end as fractional grid positions. */
  start: { col: number; row: number } | null;
  goal: { col: number; row: number } | null;
  /** The scrubber's position along the route, as a fractional grid position. */
  marker: { col: number; row: number } | null;
  landmarks: readonly Landmark[];
  showLabels: boolean;
  exaggeration: number;
  dark: boolean;
  /** When set, the next click on the terrain reports a grid position. */
  picking: boolean;
  onPick: (col: number, row: number) => void;
}

export const LABEL_KINDS_ALWAYS = new Set(["resort", "town"]);
