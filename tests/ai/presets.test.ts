import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import narrateFixtures from "@/fixtures/narrate-route.json";
import planFixtures from "@/fixtures/plan-route.json";
import type { Fixture, FixtureStore } from "@/lib/demo";
import { checkConstraints, type RouteConstraints } from "@/lib/plan/constraints";
import {
  NarrationDataSchema,
  buildFacts,
  checkNarration,
  type Narration,
  type RouteFacts,
} from "@/lib/plan/facts";
import { planRoute } from "@/lib/plan/planner";
import { PLANNER_PRESETS } from "@/lib/plan/presets";
import { Router } from "@/lib/terrain/route";
import { loadWasatch } from "../helpers/wasatch";

/**
 * Every fixture must be a valid output of the real pipeline, and the preset
 * list must carry the numbers the real router produces.
 *
 *   pnpm facts    rewrites fixtures/presets.json from the current fixtures and heightmap
 */
const PRESETS_FILE = path.resolve(import.meta.dirname, "../../fixtures/presets.json");
const plans = planFixtures as FixtureStore<RouteConstraints>;
const narrations = narrateFixtures as FixtureStore<Narration>;

interface PresetEntry {
  route: string;
  body: { demoId: string; request: string; facts?: RouteFacts };
}

const { grid, meta } = loadWasatch();
const router = new Router(grid);

/** The facts the browser would send for a preset: the fixture's constraints run through the real planner. */
function factsFor(demoId: string): RouteFacts {
  const preset = PLANNER_PRESETS.find((entry) => entry.demoId === demoId)!;
  const checked = checkConstraints(plans[demoId].data);
  if (!checked.ok) throw new Error(checked.error);
  return buildFacts(planRoute(router, meta, checked.constraints), preset.units);
}

function expectedPresets(): PresetEntry[] {
  return [
    ...PLANNER_PRESETS.map((preset) => ({
      route: "/api/plan-route",
      body: { demoId: preset.demoId, request: preset.request },
    })),
    ...PLANNER_PRESETS.map((preset) => ({
      route: "/api/narrate-route",
      body: { demoId: preset.demoId, request: preset.request, facts: factsFor(preset.demoId) },
    })),
  ];
}

function expectHonestFlags(fixture: Fixture) {
  // A placeholder is a hand-written sample: no timestamp, no usage, no cost. A recording has all three.
  if (fixture.placeholder) {
    expect(fixture.recordedAt).toBeNull();
    expect(fixture.costUsd).toBe(0);
    expect(fixture.usage.input_tokens + fixture.usage.output_tokens).toBe(0);
  } else {
    expect(fixture.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(fixture.usage.output_tokens).toBeGreaterThan(0);
  }
}

describe("fixtures validate against the real pipeline", () => {
  it("has one constraints fixture and one narration fixture per preset, and no strays", () => {
    const ids = PLANNER_PRESETS.map((preset) => preset.demoId).sort();
    expect(Object.keys(plans).sort()).toEqual(ids);
    expect(Object.keys(narrations).sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(3);
  });

  it.each(PLANNER_PRESETS.map((preset) => preset.demoId))("%s: constraints pass the validator and route", (demoId) => {
    const fixture = plans[demoId];
    expectHonestFlags(fixture);
    const checked = checkConstraints(fixture.data);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    // Stored constraints are already in canonical form: validating changes nothing.
    expect(checked.constraints).toEqual(fixture.data);
    const plan = planRoute(router, meta, checked.constraints);
    expect(plan.found).toBe(true);
    expect(plan.stats!.distanceM).toBeGreaterThan(1000);
  });

  it.each(PLANNER_PRESETS.map((preset) => preset.demoId))(
    "%s: narration quotes only what the router computes for it",
    (demoId) => {
      const fixture = narrations[demoId];
      expectHonestFlags(fixture);
      expect(NarrationDataSchema.safeParse(fixture.data).success).toBe(true);
      const facts = factsFor(demoId);
      expect(checkNarration(fixture.data, facts)).toEqual({ ok: true, problems: [] });
      // It is about this route, not just free of wrong numbers.
      expect(fixture.data.narration).toContain(facts.distance);
      expect(fixture.data.narration).toContain(facts.climb);
    },
  );

  it("constraints and narration fixtures for a preset are both samples or both recordings", () => {
    for (const { demoId } of PLANNER_PRESETS) {
      expect(narrations[demoId].placeholder, demoId).toBe(plans[demoId].placeholder);
    }
  });
});

describe("fixtures/presets.json", () => {
  it("lists every preset for both routes, with the facts the real router produces", () => {
    const expected = expectedPresets();
    if (process.env.UPDATE_FACTS === "1") {
      writeFileSync(PRESETS_FILE, `${JSON.stringify(expected, null, 2)}\n`);
    }
    const actual = JSON.parse(readFileSync(PRESETS_FILE, "utf8")) as PresetEntry[];
    expect(actual).toEqual(expected);
  });
});
