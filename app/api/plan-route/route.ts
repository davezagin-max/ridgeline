import { z } from "zod";
import fixtures from "@/fixtures/plan-route.json";
import { jsonRoute } from "@/lib/api";
import type { FixtureStore } from "@/lib/demo";
import type { RouteConstraints } from "@/lib/plan/constraints";
import { interpretRequest } from "@/lib/plan/live";

/**
 * Step 1 of the optional AI path: a sentence in, routing constraints out.
 * The browser then runs the router itself; no route is computed on the server.
 */
const Body = z.object({
  demoId: z.string().max(64).optional(),
  request: z.string().trim().min(3).max(300),
});

export const maxDuration = 60;

export const POST = jsonRoute({
  store: "plan-route",
  fixtures: fixtures as FixtureStore<RouteConstraints>,
  schema: Body,
  maxBytes: 4 * 1024,
  // The request's signal aborts the upstream call if the visitor cancels or leaves.
  live: ({ body, client, req }) => interpretRequest(client, body.request, req.signal),
});
