"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiMeta, ErrorKind } from "@/lib/api";
import { callApi } from "@/lib/client";
import { checkConstraints, type RouteConstraints } from "@/lib/plan/constraints";
import {
  NarrationDataSchema,
  buildFacts,
  checkNarration,
  templateNarration,
  type Narration,
} from "@/lib/plan/facts";
import type { Units } from "@/lib/terrain/units";
import type { TerrainWorker } from "@/lib/worker/client";
import type { PlanResponse } from "@/lib/worker/protocol";

export type PlannerStep = "reading" | "routing" | "writing";

export type PlannerState =
  | { status: "idle" }
  | { status: "working"; step: PlannerStep; request: string; constraints: RouteConstraints | null }
  | {
      status: "done";
      request: string;
      constraints: RouteConstraints;
      /** Cost and provenance of the constraints call. */
      constraintsMeta: ApiMeta;
      plan: PlanResponse;
      narration: Narration | null;
      /** True when the narration shown was rebuilt by code in the browser. */
      rebuilt: boolean;
      /** Why there is no narration, when there is none. */
      narrationError: string | null;
      /** Both calls added together, for the cost meter. */
      meta: ApiMeta;
    }
  | { status: "error"; request: string; kind: ErrorKind; message: string; meta: ApiMeta | null };

export interface PlannerInput {
  demoId?: string;
  request: string;
  units: Units;
}

function addMeta(a: ApiMeta, b: ApiMeta | undefined): ApiMeta {
  if (!b) return a;
  return {
    mode: b.mode,
    placeholder: a.placeholder || b.placeholder,
    recordedAt: b.recordedAt ?? a.recordedAt,
    model: b.model ?? a.model,
    usage: {
      input_tokens: a.usage.input_tokens + b.usage.input_tokens,
      output_tokens: a.usage.output_tokens + b.usage.output_tokens,
      cache_creation_input_tokens:
        a.usage.cache_creation_input_tokens + b.usage.cache_creation_input_tokens,
      cache_read_input_tokens: a.usage.cache_read_input_tokens + b.usage.cache_read_input_tokens,
    },
    costUsd: a.costUsd + b.costUsd,
  };
}

/**
 * The optional AI path, driven from the browser in three steps:
 * request to constraints (Claude), constraints to route (the worker, no
 * network), route facts to narration (Claude).
 *
 * Every step checks that this run is still the current one before going on.
 * Cancelling, or starting another request, aborts the in-flight fetch and
 * stops the chain, so an abandoned run makes no further model calls on the
 * visitor's key.
 */
export function usePlanner(options: {
  worker: TerrainWorker | null;
  apiKey: string | null;
  onPlan: (plan: PlanResponse) => void;
}) {
  const { worker, apiKey, onPlan } = options;
  const [state, setState] = useState<PlannerState>({ status: "idle" });
  const runRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    runRef.current++;
    abortRef.current?.abort();
    abortRef.current = null;
    setState({ status: "idle" });
  }, []);

  // Leaving the page abandons the run.
  useEffect(
    () => () => {
      runRef.current++;
      abortRef.current?.abort();
    },
    [],
  );

  const run = useCallback(
    async (input: PlannerInput) => {
      if (!worker) return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const runId = ++runRef.current;
      const current = () => runRef.current === runId;
      const { request } = input;
      const fail = (kind: ErrorKind, message: string, meta: ApiMeta | null = null) =>
        setState({ status: "error", request, kind, message, meta });

      setState({ status: "working", step: "reading", request, constraints: null });
      const first = await callApi<RouteConstraints>(
        "/api/plan-route",
        { demoId: input.demoId, request },
        apiKey,
        controller.signal,
      );
      if (!current()) return;
      if (!first.ok) return fail(first.error.kind, first.error.message, first.meta ?? null);

      // Whatever the source (model or fixture), constraints are validated before they are used.
      const checked = checkConstraints(first.data);
      if (!checked.ok) return fail("server", `The constraints were not usable. ${checked.error}`, first.meta);
      const constraints = checked.constraints;

      setState({ status: "working", step: "routing", request, constraints });
      let plan: PlanResponse;
      try {
        plan = await worker.call("plan", { constraints });
      } catch {
        if (current()) fail("server", "The router stopped unexpectedly. Reload the page.", first.meta);
        return;
      }
      if (!current()) return;
      onPlan(plan);

      const done = (
        narration: Narration | null,
        narrationError: string | null,
        meta: ApiMeta,
        rebuilt = false,
      ) =>
        setState({
          status: "done",
          request,
          constraints,
          constraintsMeta: first.meta,
          plan,
          narration,
          rebuilt,
          narrationError,
          meta,
        });

      if (!plan.found) return done(null, null, first.meta);

      const facts = buildFacts(plan, input.units);
      setState({ status: "working", step: "writing", request, constraints });
      const second = await callApi<Narration>(
        "/api/narrate-route",
        { demoId: input.demoId, request, facts },
        apiKey,
        controller.signal,
      );
      if (!current()) return;
      if (!second.ok) return done(null, second.error.message, addMeta(first.meta, second.meta));

      // Last line of defence: the text shown must only quote this route's own numbers.
      const parsed = NarrationDataSchema.safeParse(second.data);
      const trusted = parsed.success && checkNarration(parsed.data, facts).ok;
      done(
        trusted ? parsed.data : templateNarration(facts),
        null,
        addMeta(first.meta, second.meta),
        !trusted,
      );
    },
    [worker, apiKey, onPlan],
  );

  return { state, run, cancel };
}
