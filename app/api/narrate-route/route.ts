import { z } from "zod";
import fixtures from "@/fixtures/narrate-route.json";
import { jsonRoute } from "@/lib/api";
import type { FixtureStore } from "@/lib/demo";
import { FactsSchema, type Narration } from "@/lib/plan/facts";
import { narrateRoute } from "@/lib/plan/live";

/**
 * Step 2 of the optional AI path: the router's numbers in, a short narration out.
 * The facts come from the visitor's browser, so they are treated as untrusted
 * text like the request itself, and the narration may only quote them.
 */
const Body = z.object({
  demoId: z.string().max(64).optional(),
  request: z.string().trim().min(3).max(300),
  facts: FactsSchema,
});

export const maxDuration = 60;

export const POST = jsonRoute({
  store: "narrate-route",
  fixtures: fixtures as FixtureStore<Narration>,
  schema: Body,
  maxBytes: 8 * 1024,
  live: ({ body, client, req }) => narrateRoute(client, body.request, body.facts, req.signal),
});
