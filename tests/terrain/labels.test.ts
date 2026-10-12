import { describe, expect, it } from "vitest";
import { LABEL_PRIORITY, crowdedLabels, labelWidth } from "@/lib/terrain/labels";
import { LANDMARKS } from "@/lib/terrain/landmarks";

describe("label decluttering", () => {
  it("keeps labels that do not overlap", () => {
    const crowded = crowdedLabels([
      { key: "a", x: 0, y: 0, width: 60 },
      { key: "b", x: 100, y: 0, width: 60 },
      { key: "c", x: 0, y: 30, width: 60 },
    ]);
    expect(crowded.size).toBe(0);
  });

  it("drops the later of two overlapping labels, so order is priority", () => {
    const a = { key: "a", x: 0, y: 0, width: 60 };
    const b = { key: "b", x: 40, y: 5, width: 60 };
    expect([...crowdedLabels([a, b])]).toEqual(["b"]);
    expect([...crowdedLabels([b, a])]).toEqual(["a"]);
  });

  it("a dropped label does not block the ones after it", () => {
    const crowded = crowdedLabels([
      { key: "a", x: 0, y: 0, width: 60 },
      { key: "b", x: 50, y: 0, width: 60 }, // overlaps a
      { key: "c", x: 100, y: 0, width: 60 }, // would overlap b, but b was dropped
    ]);
    expect([...crowded]).toEqual(["b"]);
  });

  it("treats labels on separate lines as clear of each other", () => {
    const crowded = crowdedLabels([
      { key: "a", x: 0, y: 0, width: 80 },
      { key: "b", x: 0, y: 18, width: 80 },
    ]);
    expect(crowded.size).toBe(0);
  });

  it("gives every landmark kind a priority, with resorts ahead of peaks", () => {
    for (const landmark of LANDMARKS)
      expect(LABEL_PRIORITY[landmark.kind]).toBeGreaterThanOrEqual(0);
    expect(LABEL_PRIORITY.resort).toBeLessThan(LABEL_PRIORITY.peak);
    expect(labelWidth("Alta")).toBeLessThan(labelWidth("American Fork Twin Peaks"));
  });
});
