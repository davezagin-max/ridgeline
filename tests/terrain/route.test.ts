import { describe, expect, it } from "vitest";
import { makeGrid, nodeIndex, type Grid } from "@/lib/terrain/grid";
import { findLandmark, landmarkNode } from "@/lib/terrain/landmarks";
import {
  DEFAULT_ROUTE_OPTIONS,
  MODE_CLIMB_WEIGHT,
  Router,
  findRoute,
  optionsFor,
  pathCost,
  stepCost,
  stepRun,
  type RouteOptions,
} from "@/lib/terrain/route";
import {
  elevationProfile,
  estimateMinutes,
  routeStats,
  sampleProfile,
  thinProfile,
} from "@/lib/terrain/stats";
import { loadWasatch } from "../helpers/wasatch";

const PLAIN: RouteOptions = { climbWeight: 0, descentWeight: 0, descentGrade: 0.15, maxGrade: 0.3 };

/** Small deterministic pseudo-random generator (mulberry32). */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rolling terrain with a few bumps too steep to cross. */
function randomTerrain(seed: number, width = 14, height = 11): Grid {
  const random = seeded(seed);
  const hills = Array.from({ length: 5 }, () => ({
    col: random() * width,
    row: random() * height,
    size: 2 + random() * 3,
    peak: 4 + random() * 22,
  }));
  return makeGrid(width, height, 30, 28, (col, row) =>
    hills.reduce(
      (sum, hill) =>
        sum +
        hill.peak * Math.exp(-((col - hill.col) ** 2 + (row - hill.row) ** 2) / hill.size ** 2),
      random() * 1.5,
    ),
  );
}

const NEIGHBOURS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/**
 * An independent oracle: Bellman-Ford relaxation until nothing changes.
 * Slow and obviously correct, and it shares no code with the A* search
 * except the definition of a step's cost.
 */
function bellmanFord(grid: Grid, start: number, options: RouteOptions): Float64Array {
  const cost = new Float64Array(grid.width * grid.height).fill(Infinity);
  cost[start] = 0;
  for (let changed = true; changed;) {
    changed = false;
    for (let node = 0; node < cost.length; node++) {
      if (cost[node] === Infinity) continue;
      const col = node % grid.width;
      const row = Math.floor(node / grid.width);
      for (const [dc, dr] of NEIGHBOURS) {
        const c = col + dc;
        const r = row + dr;
        if (c < 0 || r < 0 || c >= grid.width || r >= grid.height) continue;
        const next = r * grid.width + c;
        const step = stepCost(
          Math.hypot(dc * grid.cellX, dr * grid.cellY),
          grid.z[next] - grid.z[node],
          options,
        );
        if (cost[node] + step < cost[next] - 1e-12) {
          cost[next] = cost[node] + step;
          changed = true;
        }
      }
    }
  }
  return cost;
}

function climbOf(grid: Grid, path: ArrayLike<number>): number {
  let climb = 0;
  for (let i = 1; i < path.length; i++) climb += Math.max(0, grid.z[path[i]] - grid.z[path[i - 1]]);
  return climb;
}

describe("step cost", () => {
  const options: RouteOptions = {
    climbWeight: 10,
    descentWeight: 2,
    descentGrade: 0.15,
    maxGrade: 0.3,
  };

  it("is the 3D length on the flat", () => {
    expect(stepCost(30, 0, options)).toBe(30);
  });

  it("adds the climb penalty per metre gained", () => {
    expect(stepCost(40, 3, options)).toBeCloseTo(Math.hypot(40, 3) + 30, 9);
  });

  it("penalises only steep descents, and less than climbs", () => {
    expect(stepCost(40, -3, options)).toBeCloseTo(Math.hypot(40, 3), 9); // 7.5% down: free
    expect(stepCost(40, -8, options)).toBeCloseTo(Math.hypot(40, 8) + 16, 9); // 20% down
    expect(stepCost(40, -8, options)).toBeLessThan(stepCost(40, 8, options));
  });

  it("forbids steps beyond the maximum grade in either direction", () => {
    expect(stepCost(10, 3, options)).toBeLessThan(Infinity); // exactly 30%
    expect(stepCost(10, 3.01, options)).toBe(Infinity);
    expect(stepCost(10, -3.01, options)).toBe(Infinity);
  });
});

describe("A* on hand-built grids", () => {
  it("crosses flat ground on the diagonal", () => {
    const grid = makeGrid(5, 5, 10, 10, () => 100);
    const result = findRoute(grid, nodeIndex(grid, 0, 0), nodeIndex(grid, 4, 4), PLAIN);
    expect(result.found).toBe(true);
    expect(Array.from(result.path)).toEqual([0, 6, 12, 18, 24]);
    expect(result.cost).toBeCloseTo(4 * Math.hypot(10, 10), 9);
  });

  it("mixes diagonal and straight steps on cells that are not square", () => {
    const grid = makeGrid(6, 3, 10, 20, () => 0);
    const result = findRoute(grid, nodeIndex(grid, 0, 0), nodeIndex(grid, 5, 2), PLAIN);
    // Two diagonals (to drop two rows) and three steps east.
    expect(result.cost).toBeCloseTo(2 * Math.hypot(10, 20) + 3 * 10, 9);
    expect(result.path).toHaveLength(6);
  });

  it("the start is its own route", () => {
    const grid = makeGrid(3, 3, 10, 10, () => 0);
    const result = findRoute(grid, 4, 4, PLAIN);
    expect(result.found).toBe(true);
    expect(Array.from(result.path)).toEqual([4]);
    expect(result.cost).toBe(0);
  });

  it("goes over a small bump when climbing is free and round it when climbing is costly", () => {
    // Three rows; a 2 m bump sits in the middle of the straight line from west to east.
    const grid = makeGrid(5, 3, 10, 10, (col, row) => (col === 2 && row === 1 ? 2 : 0));
    const start = nodeIndex(grid, 0, 1);
    const goal = nodeIndex(grid, 4, 1);

    const over = findRoute(grid, start, goal, PLAIN);
    expect(Array.from(over.path)).toEqual([5, 6, 7, 8, 9]);
    expect(over.cost).toBeCloseTo(20 + 2 * Math.hypot(10, 2), 9);

    const round = findRoute(grid, start, goal, { ...PLAIN, climbWeight: 30 });
    expect(round.path).not.toContain(nodeIndex(grid, 2, 1));
    expect(round.cost).toBeCloseTo(20 + 2 * Math.hypot(10, 10), 9);
    expect(climbOf(grid, round.path)).toBe(0);
    // Going over would have cost 60 more for the two metres of climbing.
    expect(round.cost).toBeLessThan(over.cost + 60);
  });

  it("charges for a steep descent", () => {
    const grid = makeGrid(3, 1, 10, 10, (col) => (col === 0 ? 4 : 0));
    const free = findRoute(grid, 0, 2, PLAIN);
    const charged = findRoute(grid, 0, 2, { ...PLAIN, maxGrade: 0.5, descentWeight: 2 });
    expect(free.found).toBe(false); // 40% down is past the 30% wall
    expect(charged.cost).toBeCloseTo(Math.hypot(10, 4) + 2 * 4 + 10, 9);
  });
});

describe("the max-grade wall", () => {
  // A wall of 100 m cliffs down column 3, with one gap in the bottom row.
  const wall = (gap: boolean) =>
    makeGrid(7, 5, 10, 10, (col, row) => (col === 3 && !(gap && row === 4) ? 100 : 0));

  it("routes through the only gap", () => {
    const grid = wall(true);
    const result = findRoute(grid, nodeIndex(grid, 0, 0), nodeIndex(grid, 6, 0), PLAIN);
    expect(result.found).toBe(true);
    expect(result.path).toContain(nodeIndex(grid, 3, 4));
    // Three diagonals and one straight step down to the gap, then the same back up.
    expect(result.cost).toBeCloseTo(2 * (3 * Math.hypot(10, 10) + 10), 9);
  });

  it("reports no route when the wall is unbroken", () => {
    const grid = wall(false);
    const result = findRoute(grid, nodeIndex(grid, 0, 0), nodeIndex(grid, 6, 0), PLAIN);
    expect(result.found).toBe(false);
    expect(result.path).toHaveLength(0);
    expect(result.cost).toBe(Infinity);
    // It gave up only after exhausting everything reachable: the 15 nodes west of the wall.
    expect(result.expanded).toBe(15);
  });

  it("goes straight over once the grade limit allows it", () => {
    const grid = makeGrid(7, 5, 10, 10, (col) => (col === 3 ? 2.5 : 0));
    const result = findRoute(grid, nodeIndex(grid, 0, 0), nodeIndex(grid, 6, 0), PLAIN);
    expect(Array.from(result.path)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("never takes a step steeper than the limit on rough terrain", () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const grid = randomTerrain(seed);
      for (const maxGrade of [0.08, 0.15, 0.3]) {
        const result = findRoute(grid, 0, grid.z.length - 1, {
          ...PLAIN,
          climbWeight: 5,
          maxGrade,
        });
        for (let i = 1; i < result.path.length; i++) {
          const run = stepRun(grid, result.path[i - 1], result.path[i]);
          const grade = Math.abs(grid.z[result.path[i]] - grid.z[result.path[i - 1]]) / run;
          expect(grade).toBeLessThanOrEqual(maxGrade + 1e-9);
        }
      }
    }
  });
});

describe("optimality", () => {
  const optionSets: RouteOptions[] = [
    PLAIN,
    { climbWeight: 8, descentWeight: 2, descentGrade: 0.1, maxGrade: 0.3 },
    { climbWeight: 30, descentWeight: 2, descentGrade: 0.15, maxGrade: 0.2 },
    { climbWeight: 60, descentWeight: 0, descentGrade: 0.15, maxGrade: 0.12 },
  ];

  it("matches an independent Bellman-Ford solver on random terrain", () => {
    let compared = 0;
    for (const seed of [11, 12, 13, 14, 15]) {
      const grid = randomTerrain(seed);
      const router = new Router(grid);
      const random = seeded(seed * 7);
      for (const options of optionSets) {
        const start = Math.floor(random() * grid.z.length);
        const truth = bellmanFord(grid, start, options);
        for (let trial = 0; trial < 12; trial++) {
          const goal = Math.floor(random() * grid.z.length);
          const result = router.search(start, goal, options);
          if (truth[goal] === Infinity) {
            expect(result.found).toBe(false);
            continue;
          }
          expect(result.found).toBe(true);
          expect(result.cost).toBeCloseTo(truth[goal], 6);
          // The reported cost is the cost of the path actually returned.
          expect(pathCost(grid, result.path, options)).toBeCloseTo(result.cost, 6);
          expect(result.path[0]).toBe(start);
          expect(result.path[result.path.length - 1]).toBe(goal);
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(150);
  });

  it("running to exhaustion gives the same costs as goal-directed search", () => {
    const grid = randomTerrain(21);
    const router = new Router(grid);
    const options = optionSets[1];
    const truth = bellmanFord(grid, 17, options);
    router.search(17, -1, options);
    for (let node = 0; node < grid.z.length; node++) {
      if (truth[node] === Infinity) expect(router.costTo(node)).toBe(Infinity);
      else expect(router.costTo(node)).toBeCloseTo(truth[node], 6);
    }
    const path = router.pathTo(grid.z.length - 1, 17);
    expect(pathCost(grid, path, options)).toBeCloseTo(truth[grid.z.length - 1], 6);
  });

  it("the heuristic never overestimates and never drops faster than a step costs", () => {
    for (const seed of [31, 32]) {
      const grid = randomTerrain(seed, 10, 8);
      const router = new Router(grid);
      for (const options of optionSets) {
        const goal = 37;
        for (let node = 0; node < grid.z.length; node++) {
          const estimate = router.heuristic(node, goal, options);
          const actual = new Router(grid).search(node, goal, options).cost;
          expect(estimate).toBeLessThanOrEqual(actual + 1e-6); // admissible
          const col = node % grid.width;
          const row = Math.floor(node / grid.width);
          for (const [dc, dr] of NEIGHBOURS) {
            const c = col + dc;
            const r = row + dr;
            if (c < 0 || r < 0 || c >= grid.width || r >= grid.height) continue;
            const next = r * grid.width + c;
            const step = stepCost(
              Math.hypot(dc * grid.cellX, dr * grid.cellY),
              grid.z[next] - grid.z[node],
              options,
            );
            if (step === Infinity) continue;
            expect(estimate).toBeLessThanOrEqual(
              step + router.heuristic(next, goal, options) + 1e-6,
            ); // consistent
          }
        }
      }
    }
  });

  it("the heuristic prunes: goal-directed search expands fewer nodes than exhaustive search", () => {
    const grid = makeGrid(
      60,
      60,
      30,
      30,
      (col, row) => 5 * Math.sin(col / 7) + 5 * Math.cos(row / 9),
    );
    const router = new Router(grid);
    const directed = router.search(nodeIndex(grid, 5, 5), nodeIndex(grid, 20, 12), PLAIN);
    const exhaustive = router.search(nodeIndex(grid, 5, 5), -1, PLAIN);
    expect(directed.expanded).toBeLessThan(exhaustive.expanded / 4);
  });
});

describe("climb-friendly versus shortest", () => {
  /*
   * Why this must hold. Let B be everything in the cost except the climb term.
   * "Shortest" minimises B + w1 * climb and "climb-friendly" minimises
   * B + w2 * climb with w2 > w1, over the same set of allowed paths. Writing
   * (B1, c1) and (B2, c2) for the two winners:
   *   B1 + w1 c1 <= B2 + w1 c2   and   B2 + w2 c2 <= B1 + w2 c1.
   * Adding them gives (w2 - w1)(c2 - c1) <= 0, so c2 <= c1.
   */
  it("uses a strictly larger climb weight and nothing else", () => {
    expect(MODE_CLIMB_WEIGHT["climb-friendly"]).toBeGreaterThan(MODE_CLIMB_WEIGHT.shortest);
    const a = optionsFor("shortest", 0.25);
    const b = optionsFor("climb-friendly", 0.25);
    expect({ ...a, climbWeight: 0 }).toEqual({ ...b, climbWeight: 0 });
    expect(a.maxGrade).toBe(0.25);
    expect(optionsFor("shortest").maxGrade).toBe(DEFAULT_ROUTE_OPTIONS.maxGrade);
  });

  it("never climbs more than shortest on random terrain", () => {
    let routed = 0;
    let improved = 0;
    for (let seed = 40; seed < 70; seed++) {
      const grid = randomTerrain(seed, 18, 14);
      const router = new Router(grid);
      const start = nodeIndex(grid, 0, seed % 14);
      const goal = nodeIndex(grid, 17, (seed * 5) % 14);
      const shortest = router.search(start, goal, optionsFor("shortest"));
      const shortestClimb = climbOf(grid, shortest.path);
      const friendly = router.search(start, goal, optionsFor("climb-friendly"));
      expect(friendly.found).toBe(shortest.found);
      if (!shortest.found) continue;
      routed++;
      const friendlyClimb = climbOf(grid, friendly.path);
      expect(friendlyClimb).toBeLessThanOrEqual(shortestClimb + 1e-6);
      // The other half of the trade: measured without the climb term, it is never cheaper.
      expect(pathCost(grid, friendly.path, optionsFor("shortest"))).toBeGreaterThanOrEqual(
        shortest.cost - 1e-6,
      );
      if (friendlyClimb < shortestClimb - 0.5) improved++;
    }
    expect(routed).toBeGreaterThan(20);
    expect(improved).toBeGreaterThan(5); // the modes genuinely differ, not just tie
  });

  it("holds on the real Wasatch heightmap between landmarks", () => {
    const { grid, meta } = loadWasatch();
    const router = new Router(grid);
    const pairs = [
      ["alta", "park-city"],
      ["big-cottonwood-mouth", "brighton"],
      ["snowbird", "solitude"],
      ["park-city", "guardsman-pass"],
    ];
    for (const [from, to] of pairs) {
      const start = landmarkNode(grid, meta, findLandmark(from)!);
      const goal = landmarkNode(grid, meta, findLandmark(to)!);
      const shortest = router.search(start, goal, optionsFor("shortest"));
      const shortestStats = routeStats(grid, shortest.path, "hike");
      const friendly = router.search(start, goal, optionsFor("climb-friendly"));
      const friendlyStats = routeStats(grid, friendly.path, "hike");
      expect(shortest.found && friendly.found).toBe(true);
      expect(friendlyStats.climbM).toBeLessThanOrEqual(shortestStats.climbM);
      expect(pathCost(grid, friendly.path, optionsFor("shortest"))).toBeGreaterThanOrEqual(
        shortest.cost - 1e-6,
      );
      expect(shortestStats.maxGradePct).toBeLessThanOrEqual(30 + 1e-6);
      expect(friendlyStats.maxGradePct).toBeLessThanOrEqual(30 + 1e-6);
    }
  });

  it("a tight grade limit cuts the Cottonwoods off from Park City", () => {
    const { grid, meta } = loadWasatch();
    const start = landmarkNode(grid, meta, findLandmark("alta")!);
    const goal = landmarkNode(grid, meta, findLandmark("park-city")!);
    expect(new Router(grid).search(start, goal, optionsFor("shortest", 0.1)).found).toBe(false);
  });
});

describe("route statistics and the pace model", () => {
  // West to east along one row: flat, up 6 m, up 6 m, down 4 m. Cells are 40 m.
  const grid = makeGrid(5, 1, 40, 40, (col) => [100, 100, 106, 112, 108][col]);
  const path = [0, 1, 2, 3, 4];

  it("adds up distance, climb, descent and the steepest step", () => {
    const stats = routeStats(grid, path, "hike");
    expect(stats.horizontalM).toBe(160);
    expect(stats.distanceM).toBeCloseTo(40 + 2 * Math.hypot(40, 6) + Math.hypot(40, 4), 5);
    expect(stats.climbM).toBeCloseTo(12, 5);
    expect(stats.descentM).toBeCloseTo(4, 5);
    expect(stats.maxGradePct).toBeCloseTo(15, 5);
    expect([stats.minElevationM, stats.maxElevationM]).toEqual([100, 112]);
    expect([stats.startElevationM, stats.endElevationM]).toEqual([100, 108]);
  });

  it("reversing a route swaps climb and descent", () => {
    const back = routeStats(grid, [...path].reverse(), "hike");
    expect(back.climbM).toBeCloseTo(4, 5);
    expect(back.descentM).toBeCloseTo(12, 5);
  });

  it("follows Naismith's rule", () => {
    // 5 km on the flat is an hour on foot; 600 m of climbing adds another.
    expect(estimateMinutes(5000, 0, "hike")).toBeCloseTo(60, 9);
    expect(estimateMinutes(5000, 600, "hike")).toBeCloseTo(120, 9);
    expect(estimateMinutes(12000, 300, "ride")).toBeCloseTo(90, 9);
    expect(routeStats(grid, path, "hike").minutes).toBeCloseTo((0.16 / 5 + 12 / 600) * 60, 6);
  });

  it("refuses an empty path", () => {
    expect(() => routeStats(grid, [], "hike")).toThrow();
  });

  it("builds a profile and samples it by distance", () => {
    const profile = elevationProfile(grid, path);
    expect(profile.distance[0]).toBe(0);
    expect(profile.distance[4]).toBeCloseTo(routeStats(grid, path, "hike").distanceM, 3);
    expect(Array.from(profile.elevation)).toEqual([100, 100, 106, 112, 108]);

    expect(sampleProfile(profile, 0).elevationM).toBe(100);
    expect(sampleProfile(profile, 1).elevationM).toBe(108);
    const quarterOfFirstStep = sampleProfile(profile, 10 / profile.distance[4]);
    expect(quarterOfFirstStep.index).toBeCloseTo(0.25, 4);
    expect(quarterOfFirstStep.gradePct).toBe(0);
    const midClimb = sampleProfile(profile, (40 + Math.hypot(40, 6) / 2) / profile.distance[4]);
    expect(midClimb.elevationM).toBeCloseTo(103, 3);
    expect(midClimb.gradePct).toBeCloseTo(15, 2);
    expect(sampleProfile(profile, 5).distanceM).toBeCloseTo(profile.distance[4], 5);
  });

  it("thins a long profile but keeps both ends", () => {
    const long = makeGrid(500, 1, 30, 30, (col) => col % 7);
    const profile = elevationProfile(
      long,
      Array.from({ length: 500 }, (_, i) => i),
    );
    const thin = thinProfile(profile, 50);
    expect(thin.distance).toHaveLength(50);
    expect(thin.distance[0]).toBe(0);
    expect(thin.distance[49]).toBe(profile.distance[499]);
    expect(thinProfile(profile, 1000)).toBe(profile);
  });
});
