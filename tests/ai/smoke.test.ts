import { describe, expect, it } from "vitest";
import { POST as narratePost } from "@/app/api/narrate-route/route";
import { POST as planPost } from "@/app/api/plan-route/route";
import narrateFixtures from "@/fixtures/narrate-route.json";
import planFixtures from "@/fixtures/plan-route.json";
import type { ApiResponse } from "@/lib/api";
import type { FixtureStore } from "@/lib/demo";
import { checkConstraints, type RouteConstraints } from "@/lib/plan/constraints";
import { buildFacts, checkNarration, type Narration } from "@/lib/plan/facts";
import { PLANNER_PRESETS } from "@/lib/plan/presets";
import { elevationProfile } from "@/lib/terrain/stats";
import { createState, plan as runPlan } from "@/lib/worker/handlers";
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadWasatch } from "../helpers/wasatch";

/**
 * Smoke test: the main path a visitor takes with no key. Click a preset, the
 * constraints come back from demo mode, the same code the worker runs plans
 * the route on the real heightmap, and the narration that comes back only
 * quotes that route's numbers.
 */
const post = (url: string, body: unknown) =>
  new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("demo mode, end to end", () => {
  const { meta } = loadWasatch();
  const file = readFileSync(path.resolve(import.meta.dirname, "../../public/data/wasatch.u16"));
  const state = createState(
    file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer,
    meta,
  );
  const plans = planFixtures as FixtureStore<RouteConstraints>;
  const narrations = narrateFixtures as FixtureStore<Narration>;

  it.each(PLANNER_PRESETS)("$demoId: preset to drawn route to narration", async (preset) => {
    // Step 1: request to constraints, replayed from the fixture.
    const first = await planPost(post("/api/plan-route", { demoId: preset.demoId, request: preset.request }));
    const constraints = (await first.json()) as ApiResponse<RouteConstraints>;
    expect(first.status).toBe(200);
    if (!constraints.ok) throw new Error(constraints.error.message);
    expect(constraints.meta).toMatchObject({
      mode: "demo",
      // The response says honestly whether this is a sample or a recording.
      placeholder: plans[preset.demoId].placeholder,
    });
    const checked = checkConstraints(constraints.data);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;

    // Step 2: the router, exactly as the worker runs it.
    const planned = runPlan(state, { constraints: checked.constraints });
    expect(planned.found).toBe(true);
    expect(planned.path.length).toBeGreaterThan(50);
    expect(planned.stats!.maxGradePct).toBeLessThanOrEqual(planned.maxGrade * 100 + 1e-6);
    const profile = elevationProfile(state.grid, planned.path);
    expect(profile.distance[profile.distance.length - 1]).toBeCloseTo(planned.stats!.distanceM, 0);

    // Step 3: facts to narration, replayed from the fixture.
    const facts = buildFacts(planned, preset.units);
    const second = await narratePost(
      post("/api/narrate-route", { demoId: preset.demoId, request: preset.request, facts }),
    );
    const narration = (await second.json()) as ApiResponse<Narration>;
    expect(second.status).toBe(200);
    if (!narration.ok) throw new Error(narration.error.message);
    expect(narration.meta.placeholder).toBe(narrations[preset.demoId].placeholder);
    expect(narration.data.narration.length).toBeGreaterThan(80);
    // The browser runs this same check before showing the text.
    expect(checkNarration(narration.data, facts)).toEqual({ ok: true, problems: [] });
    expect(narration.data.narration).toContain(facts.distance);
  });

  it("the capped preset really does need the climb weight turned up", () => {
    const checked = checkConstraints(plans["big-cottonwood-capped"].data);
    if (!checked.ok) throw new Error(checked.error);
    const planned = runPlan(state, { constraints: checked.constraints });
    // Only meaningful while the fixture still asks for "shortest" with a cap, as the sample does.
    if (checked.constraints.mode === "shortest" && checked.constraints.maxClimbM !== null) {
      expect(planned.searches).toBeGreaterThan(1);
      expect(planned.climbWeight).toBeGreaterThan(0);
      expect(planned.stats!.climbM).toBeLessThanOrEqual(checked.constraints.maxClimbM);
    }
  });
});
