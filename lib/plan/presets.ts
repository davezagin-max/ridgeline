import type { Units } from "../terrain/units";

/**
 * The three requests that work without a key. `demoId` is the fixture key in
 * both `fixtures/plan-route.json` and `fixtures/narrate-route.json`. Each
 * preset states its own units so its narration always matches its wording.
 */
export interface PlannerPreset {
  demoId: string;
  request: string;
  units: Units;
}

export const PLANNER_PRESETS: readonly PlannerPreset[] = [
  {
    demoId: "park-city-loop",
    request: "2-hour ride with under 2,000 ft of climbing from Park City",
    units: "imperial",
  },
  {
    demoId: "alta-to-brighton",
    request: "Hike from Alta over to Brighton, nothing steeper than 20%",
    units: "imperial",
  },
  {
    demoId: "big-cottonwood-capped",
    request:
      "Shortest ride from the mouth of Big Cottonwood up to Brighton, but keep the climbing under 4,000 ft",
    units: "imperial",
  },
];
