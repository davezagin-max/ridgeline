import { describe, expect, it } from "vitest";
import {
  LIMITS,
  checkConstraints,
  constraintsFromToolInput,
  landmarkReference,
  toolProperties,
  type RouteConstraints,
} from "@/lib/plan/constraints";
import {
  buildFacts,
  checkNarration,
  factsText,
  numerals,
  templateNarration,
  FactsSchema,
} from "@/lib/plan/facts";
import { CLIMB_LADDER, DURATION_TOLERANCE, planRoute, roundTripPath } from "@/lib/plan/planner";
import { LANDMARKS, LANDMARK_IDS, findLandmark, landmarkNode } from "@/lib/terrain/landmarks";
import { DEFAULT_ROUTE_OPTIONS, Router, optionsFor } from "@/lib/terrain/route";
import { routeStats } from "@/lib/terrain/stats";
import { contourSegments, createState, route } from "@/lib/worker/handlers";
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadWasatch } from "../helpers/wasatch";

const TOOL_INPUT = {
  start: "park-city",
  end_or_loop: "loop",
  max_climb: 2000,
  climb_unit: "ft",
  max_grade_pct: null,
  target_duration_min: 120,
  mode: "climb-friendly",
  activity: "ride",
};

const base: RouteConstraints = {
  start: "alta",
  end: "brighton",
  maxClimbM: null,
  maxGradePct: null,
  targetDurationMin: null,
  mode: "climb-friendly",
  activity: "hike",
};

describe("constraints from the model's tool call", () => {
  it("converts feet to metres in code", () => {
    const checked = constraintsFromToolInput(TOOL_INPUT);
    expect(checked).toEqual({
      ok: true,
      constraints: {
        start: "park-city",
        end: null,
        maxClimbM: 609.6,
        maxGradePct: null,
        targetDurationMin: 120,
        mode: "climb-friendly",
        activity: "ride",
      },
    });
  });

  it("leaves metres alone and maps a named destination", () => {
    const checked = constraintsFromToolInput({
      ...TOOL_INPUT,
      end_or_loop: "canyons-village",
      max_climb: 500,
      climb_unit: "m",
    });
    expect(checked.ok && checked.constraints.maxClimbM).toBe(500);
    expect(checked.ok && checked.constraints.end).toBe("canyons-village");
  });

  it("pulls a grade limit into the supported range instead of failing", () => {
    const steep = constraintsFromToolInput({ ...TOOL_INPUT, max_grade_pct: 80 });
    const gentle = constraintsFromToolInput({ ...TOOL_INPUT, max_grade_pct: 1 });
    expect(steep.ok && steep.constraints.maxGradePct).toBe(LIMITS.gradePct.max);
    expect(gentle.ok && gentle.constraints.maxGradePct).toBe(LIMITS.gradePct.min);
  });

  it.each([
    [{ start: "atlantis" }, /Unknown start/],
    [{ end_or_loop: "atlantis" }, /Unknown destination/],
    [{ end_or_loop: "park-city" }, /same place/],
    [{ max_climb: -5 }, /Climb limit/],
    [{ max_climb: 900000 }, /Climb limit/],
    [{ target_duration_min: 2 }, /duration/],
    [{ target_duration_min: Number.NaN }, /wrong shape|duration/],
    [{ mode: "fastest" }, /wrong shape/],
    [{ climb_unit: "yd" }, /wrong shape/],
    [{ start: 7 }, /wrong shape/],
  ])("rejects %j", (patch, message) => {
    const checked = constraintsFromToolInput({ ...TOOL_INPUT, ...patch });
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.error).toMatch(message);
  });

  it("rejects input with a missing field or the wrong type altogether", () => {
    const missing: Record<string, unknown> = { ...TOOL_INPUT };
    delete missing.activity;
    expect(constraintsFromToolInput(missing).ok).toBe(false);
    expect(constraintsFromToolInput("alta to brighton").ok).toBe(false);
    expect(constraintsFromToolInput(null).ok).toBe(false);
    expect(checkConstraints({ ...base, extra: 1 }).ok).toBe(true); // unknown keys are dropped
    expect(checkConstraints({ ...base, start: undefined }).ok).toBe(false);
  });

  it("never echoes more than a short slice of an unknown name", () => {
    const checked = constraintsFromToolInput({ ...TOOL_INPUT, start: "x".repeat(500) });
    expect(!checked.ok && checked.error.length).toBeLessThan(80);
  });

  it("the tool schema is strict-compatible: all required, no ranges, landmark ids as enums", () => {
    const properties = toolProperties() as Record<string, { enum?: string[]; type: unknown }>;
    expect(Object.keys(properties)).toEqual([
      "start",
      "end_or_loop",
      "max_climb",
      "climb_unit",
      "max_grade_pct",
      "target_duration_min",
      "mode",
      "activity",
    ]);
    expect(properties.start.enum).toEqual([...LANDMARK_IDS]);
    expect(properties.end_or_loop.enum).toEqual([...LANDMARK_IDS, "loop"]);
    const text = JSON.stringify(properties);
    for (const banned of ["minimum", "maximum", "minLength", "maxLength", "minItems", "$ref"]) {
      expect(text).not.toContain(`"${banned}"`);
    }
    const unions = Object.values(properties).filter((property) => Array.isArray(property.type));
    expect(unions.length).toBeLessThanOrEqual(16);
  });

  it("lists every landmark for the model, one per line", () => {
    const lines = landmarkReference().split("\n");
    expect(lines).toHaveLength(LANDMARKS.length);
    expect(lines[0]).toBe("alta | Alta | resort");
  });
});

describe("planning on the real heightmap", () => {
  const { grid, meta } = loadWasatch();
  const router = new Router(grid);

  it("routes a plain point-to-point request with one search", () => {
    const plan = planRoute(router, meta, base);
    expect(plan.found).toBe(true);
    expect(plan.searches).toBe(1);
    expect(plan.destination).toBe("brighton");
    expect(plan.roundTrip).toBe(false);
    expect(plan.maxGrade).toBe(DEFAULT_ROUTE_OPTIONS.maxGrade);
    expect(plan.checks).toEqual([]);
    expect(plan.path[0]).toBe(landmarkNode(grid, meta, findLandmark("alta")!));
    expect(plan.path[plan.path.length - 1]).toBe(
      landmarkNode(grid, meta, findLandmark("brighton")!),
    );
    // The plan is exactly what the router returns for the same options.
    const direct = router.search(
      plan.path[0],
      plan.path[plan.path.length - 1],
      optionsFor("climb-friendly"),
    );
    expect(Array.from(plan.path)).toEqual(Array.from(direct.path));
    expect(plan.stats).toEqual(routeStats(grid, direct.path, "hike"));
  });

  it("turns the climb weight up until the route fits under a climb cap", () => {
    const uncapped = planRoute(router, meta, {
      ...base,
      start: "big-cottonwood-mouth",
      mode: "shortest",
      activity: "ride",
    });
    const cap = uncapped.stats!.climbM - 100;
    const capped = planRoute(router, meta, { ...uncapped.constraints, maxClimbM: cap });
    expect(uncapped.climbWeight).toBe(0);
    expect(capped.found).toBe(true);
    expect(capped.searches).toBeGreaterThan(1);
    expect(capped.climbWeight).toBeGreaterThan(0);
    expect(CLIMB_LADDER).toContain(capped.climbWeight);
    expect(capped.stats!.climbM).toBeLessThanOrEqual(cap);
    expect(capped.stats!.distanceM).toBeGreaterThan(uncapped.stats!.distanceM);
    expect(capped.checks).toEqual([
      { kind: "climb", ok: true, actualM: capped.stats!.climbM, limitM: cap },
    ]);
  });

  it("says so, and returns its gentlest attempt, when no weight fits the cap", () => {
    const plan = planRoute(router, meta, {
      ...base,
      start: "park-city",
      end: "guardsman-pass",
      maxClimbM: 300,
    });
    // The pass is about 800 m above town: no route can climb less than that.
    expect(plan.found).toBe(true);
    expect(plan.checks[0]).toMatchObject({ kind: "climb", ok: false, limitM: 300 });
    expect(plan.stats!.climbM).toBeGreaterThan(800);
    expect(plan.searches).toBe(1 + CLIMB_LADDER.filter((weight) => weight > 30).length);
  });

  it("builds an out-and-back to the landmark that best fits the target time", () => {
    const constraints: RouteConstraints = {
      start: "park-city",
      end: null,
      maxClimbM: 609.6,
      maxGradePct: null,
      targetDurationMin: 120,
      mode: "climb-friendly",
      activity: "ride",
    };
    const plan = planRoute(router, meta, constraints);
    expect(plan.found).toBe(true);
    expect(plan.roundTrip).toBe(true);
    expect(plan.destination).not.toBeNull();
    expect(plan.destination).not.toBe("park-city");
    const start = landmarkNode(grid, meta, findLandmark("park-city")!);
    const turnaround = landmarkNode(grid, meta, findLandmark(plan.destination!)!);
    expect(plan.path[0]).toBe(start);
    expect(plan.path[plan.path.length - 1]).toBe(start);
    expect(plan.path[(plan.path.length - 1) / 2]).toBe(turnaround);
    // Out and back along the same line: climb equals descent.
    expect(plan.stats!.climbM).toBeCloseTo(plan.stats!.descentM, 6);
    expect(plan.stats!.climbM).toBeLessThanOrEqual(609.6);
    expect(plan.checks.map((check) => check.kind)).toEqual(["climb", "duration"]);

    // No other landmark that fits the cap comes closer to the target time.
    router.search(start, -1, { ...DEFAULT_ROUTE_OPTIONS, climbWeight: plan.climbWeight });
    const chosenMiss = Math.abs(plan.stats!.minutes - 120);
    for (const landmark of LANDMARKS) {
      if (landmark.id === "park-city") continue;
      const out = router.pathTo(landmarkNode(grid, meta, landmark), start);
      if (out.length < 2) continue;
      const stats = routeStats(grid, roundTripPath(out), "ride");
      if (stats.climbM <= 609.6) {
        expect(Math.abs(stats.minutes - 120), landmark.id).toBeGreaterThanOrEqual(
          chosenMiss - 1e-9,
        );
      }
    }
    const durationCheck = plan.checks[1];
    expect(durationCheck.ok).toBe(chosenMiss <= 120 * DURATION_TOLERANCE);
  });

  it("honours an explicit grade limit and reports when nothing gets through", () => {
    const strict = planRoute(router, meta, { ...base, maxGradePct: 20 });
    expect(strict.maxGrade).toBeCloseTo(0.2, 9);
    expect(strict.stats!.maxGradePct).toBeLessThanOrEqual(20 + 1e-6);
    expect(strict.checks).toEqual([
      { kind: "grade", ok: true, actualPct: strict.stats!.maxGradePct, limitPct: 20 },
    ]);

    const blocked = planRoute(router, meta, { ...base, end: "park-city", maxGradePct: 8 });
    expect(blocked.found).toBe(false);
    expect(blocked.reason).toBe("No route from Alta to Park City Old Town stays under a 8% grade.");
    expect(blocked.path).toHaveLength(0);
    expect(blocked.stats).toBeNull();
  });

  it("refuses unknown landmarks without searching", () => {
    const plan = planRoute(router, meta, { ...base, start: "atlantis" });
    expect(plan).toMatchObject({
      found: false,
      searches: 0,
      reason: "That place is not on this map.",
    });
  });

  it("round trips mirror the outbound path", () => {
    expect(Array.from(roundTripPath([4, 9, 2]))).toEqual([4, 9, 2, 9, 4]);
    expect(Array.from(roundTripPath([7]))).toEqual([7]);
  });
});

describe("facts and the narration check", () => {
  const { grid, meta } = loadWasatch();
  const router = new Router(grid);
  const plan = planRoute(router, meta, {
    start: "park-city",
    end: null,
    maxClimbM: 609.6,
    maxGradePct: null,
    targetDurationMin: 120,
    mode: "climb-friendly",
    activity: "ride",
  });
  const facts = buildFacts(plan, "imperial");

  it("formats the router's numbers and nothing else", () => {
    expect(FactsSchema.safeParse(facts).success).toBe(true);
    expect(facts.from).toBe("Park City Old Town");
    expect(facts.shape).toBe("out and back");
    expect(facts.distance).toMatch(/^\d+\.\d mi$/);
    expect(facts.climb).toMatch(/^[\d,]+ ft$/);
    expect(facts.estimatedTime).toMatch(/^\d h \d\d min$/);
    expect(facts.limits[0]).toBe("Climb limit of 2,000 ft: met.");
    expect(buildFacts(plan, "metric").climb).toMatch(/^[\d,]+ m$/);
    expect(factsText(facts)).toContain(`total climb: ${facts.climb}`);
  });

  it("cannot describe a plan with no route", () => {
    const blocked = planRoute(router, meta, { ...base, end: "park-city", maxGradePct: 8 });
    expect(() => buildFacts(blocked, "imperial")).toThrow();
  });

  it("extracts numerals, ignoring thousands separators", () => {
    expect(numerals("9.1 mi, 1,850 ft, 2 h 05 min at 9%")).toEqual(["9.1", "1850", "2", "05", "9"]);
    expect(numerals("no figures here")).toEqual([]);
  });

  it("accepts a narration that quotes the facts", () => {
    const narration = {
      title: `${facts.from} to ${facts.to}`,
      narration: `An easy spin: ${facts.distance} with ${facts.climb} of climbing, about ${facts.estimatedTime}. It stays under your 2,000 ft limit.`,
    };
    expect(checkNarration(narration, facts)).toEqual({ ok: true, problems: [] });
  });

  it("rejects a narration with a figure the router did not produce", () => {
    const check = checkNarration(
      {
        title: "A loop",
        narration: `About 12 miles and ${facts.climb} of climbing, roughly 3 hours.`,
      },
      facts,
    );
    expect(check.ok).toBe(false);
    expect(check.problems[0]).toBe("These figures are not in the facts: 12, 3.");
  });

  it("rejects a rounded or converted figure", () => {
    const [value] = numerals(facts.distance);
    const rounded = String(Math.round(Number(value)) + 40);
    expect(
      checkNarration({ title: "Loop", narration: `Roughly ${rounded} miles.` }, facts).ok,
    ).toBe(false);
  });

  it("rejects empty and overlong text", () => {
    expect(checkNarration({ title: " ", narration: "" }, facts).problems).toEqual([
      "The title is empty.",
      "The narration is empty.",
    ]);
    expect(checkNarration({ title: "t".repeat(81), narration: "fine" }, facts).ok).toBe(false);
    expect(checkNarration({ title: "ok", narration: "word ".repeat(200) }, facts).ok).toBe(false);
  });

  it("requires the distance and the total climb to be stated verbatim", () => {
    const silent = checkNarration(
      { title: "A loop", narration: "A pleasant out-and-back ride." },
      facts,
    );
    expect(silent.problems).toEqual([
      `State the distance exactly as given (${facts.distance}).`,
      `State the total climb exactly as given (${facts.climb}).`,
    ]);
    const half = checkNarration(
      { title: "A loop", narration: `A pleasant ride of ${facts.distance}.` },
      facts,
    );
    expect(half.problems).toEqual([`State the total climb exactly as given (${facts.climb}).`]);
  });

  it("the code-written fallback always passes its own check", () => {
    for (const units of ["imperial", "metric"] as const) {
      const unitFacts = buildFacts(plan, units);
      const fallback = templateNarration(unitFacts);
      expect(fallback.source).toBe("template");
      expect(checkNarration(fallback, unitFacts)).toEqual({ ok: true, problems: [] });
      expect(fallback.narration).toContain(unitFacts.distance);
    }
  });
});

describe("worker handlers", () => {
  const { meta } = loadWasatch();
  const file = readFileSync(path.resolve(import.meta.dirname, "../../public/data/wasatch.u16"));
  const state = createState(
    file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer,
    meta,
  );

  it("traces contours as scene-space segments, index lines separately", () => {
    const result = contourSegments(state, 100);
    expect(result.levels).toBe(21);
    expect(result.minor.length % 6).toBe(0);
    expect(result.index.length % 6).toBe(0);
    expect(result.minor.length).toBeGreaterThan(result.index.length);
    // Index contours are every 500 m: their heights above the base are 1500, 2000, ... minus the base.
    const heights = new Set<number>();
    for (let i = 1; i < result.index.length; i += 3)
      heights.add(Math.round(result.index[i] + meta.minElevation));
    expect([...heights].sort((a, b) => a - b)).toEqual([1500, 2000, 2500, 3000]);
    // Every vertex is inside the map's footprint.
    const halfX = ((meta.width - 1) / 2) * meta.cellX;
    for (let i = 0; i < result.minor.length; i += 3) {
      expect(Math.abs(result.minor[i])).toBeLessThanOrEqual(halfX + 1);
    }
  });

  it("routes between nodes and doubles the path for a round trip", () => {
    const start = landmarkNode(state.grid, meta, findLandmark("alta")!);
    const goal = landmarkNode(state.grid, meta, findLandmark("cecret-lake")!);
    const request = {
      start,
      goal,
      mode: "climb-friendly" as const,
      maxGrade: 0.3,
      activity: "hike" as const,
    };
    const oneWay = route(state, { ...request, roundTrip: false });
    const both = route(state, { ...request, roundTrip: true });
    expect(oneWay.found).toBe(true);
    expect(both.path).toHaveLength(oneWay.path.length * 2 - 1);
    expect(both.stats!.distanceM).toBeCloseTo(oneWay.stats!.distanceM * 2, 3);
    expect(both.stats!.climbM).toBeCloseTo(oneWay.stats!.climbM + oneWay.stats!.descentM, 3);
    const blocked = route(state, { ...request, maxGrade: 0.02, roundTrip: false });
    expect(blocked).toMatchObject({ found: false, stats: null });
    expect(blocked.path).toHaveLength(0);
  });
});
