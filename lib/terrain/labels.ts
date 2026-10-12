/**
 * Label decluttering shared by the 3D and 2D views.
 *
 * Labels are placed greedily in the order given (most important first). A
 * label whose box would overlap one already placed is reported as crowded;
 * the views then show only its symbol. Simple, deterministic, and fast enough
 * to run on every rendered frame.
 */
import type { LandmarkKind } from "./landmarks";

export interface LabelBox {
  key: string;
  /** Screen position of the label's anchor (its symbol), in pixels. */
  x: number;
  y: number;
  /** Width of the box to the right of the anchor, in pixels. */
  width: number;
}

/** Lower numbers claim space first. */
export const LABEL_PRIORITY: Record<LandmarkKind, number> = {
  resort: 0,
  town: 0,
  pass: 1,
  trailhead: 2,
  lake: 2,
  peak: 3,
};

const HALF_HEIGHT = 9;
const LEFT_PAD = 8;

/** A rough width for a name set in the label font: symbol plus about 6.6 px per character. */
export function labelWidth(name: string): number {
  return 18 + name.length * 6.6;
}

/** Keys of the labels that do not fit, given the ones before them in the list. */
export function crowdedLabels(labels: readonly LabelBox[]): Set<string> {
  const crowded = new Set<string>();
  const placed: number[] = []; // x0, y0, x1, y1 per placed label
  for (const label of labels) {
    const x0 = label.x - LEFT_PAD;
    const x1 = label.x + label.width;
    const y0 = label.y - HALF_HEIGHT;
    const y1 = label.y + HALF_HEIGHT;
    let overlaps = false;
    for (let i = 0; i < placed.length; i += 4) {
      if (x0 < placed[i + 2] && x1 > placed[i] && y0 < placed[i + 3] && y1 > placed[i + 1]) {
        overlaps = true;
        break;
      }
    }
    if (overlaps) crowded.add(label.key);
    else placed.push(x0, y0, x1, y1);
  }
  return crowded;
}
