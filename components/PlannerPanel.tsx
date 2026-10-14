"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { CostMeter } from "@/components/kit/CostMeter";
import type { ApiMeta } from "@/lib/api";
import type { RouteConstraints } from "@/lib/plan/constraints";
import type { Narration } from "@/lib/plan/facts";
import type { PlanCheck } from "@/lib/plan/planner";
import { PLANNER_PRESETS } from "@/lib/plan/presets";
import { findLandmark } from "@/lib/terrain/landmarks";
import { formatDuration, formatGrade, formatHeight, type Units } from "@/lib/terrain/units";
import type { PlannerInput, PlannerState, PlannerStep } from "./usePlanner";
import { Section } from "./ui";

interface PlannerPanelProps {
  state: PlannerState;
  ready: boolean;
  isLive: boolean;
  units: Units;
  onRun: (input: PlannerInput) => void;
  onCancel: () => void;
  onAddKey: () => void;
}

const STEPS: { step: PlannerStep; label: string }[] = [
  { step: "reading", label: "Reading the request" },
  { step: "routing", label: "Routing in your browser" },
  { step: "writing", label: "Writing it up" },
];

/** Says where the constraints came from, driven by the response's own flags. */
function constraintsCaption(meta: ApiMeta): string {
  if (meta.mode === "live") return "How Claude Opus 5.5 read the request";
  return meta.placeholder
    ? "Sample reading of the request (hand-written, not a model run)"
    : "How Claude Opus 5.5 read the request (recorded run)";
}

/** Says who wrote the narration, driven by the response's own flags. */
function narrationCaption(meta: ApiMeta, narration: Narration, rebuilt: boolean): string {
  if (rebuilt) return "Summary assembled by code from this route's numbers";
  if (narration.source === "template") {
    return "Summary assembled by code: the model's draft used a figure the router did not produce";
  }
  if (meta.mode === "live") return "Written by Claude Opus 5.5 from the router's numbers";
  return meta.placeholder
    ? "Sample text (hand-written, not a model run) using the router's numbers"
    : "Recorded Claude Opus 5.5 run, using the router's numbers";
}

function chips(constraints: RouteConstraints, units: Units): string[] {
  const name = (id: string) => findLandmark(id)?.name ?? id;
  const list = [`From ${name(constraints.start)}`];
  list.push(constraints.end ? `To ${name(constraints.end)}` : "Out and back");
  if (constraints.maxClimbM !== null)
    list.push(`Climb under ${formatHeight(constraints.maxClimbM, units)}`);
  if (constraints.targetDurationMin !== null)
    list.push(`About ${formatDuration(constraints.targetDurationMin)}`);
  if (constraints.maxGradePct !== null)
    list.push(`Grade under ${formatGrade(constraints.maxGradePct)}`);
  list.push(constraints.mode === "shortest" ? "Shortest" : "Climb-friendly");
  list.push(constraints.activity === "ride" ? "Ride" : "Hike");
  return list;
}

function CheckRow({ check, units }: { check: PlanCheck; units: Units }) {
  const text =
    check.kind === "climb"
      ? `Climb ${formatHeight(check.actualM, units)} against a ${formatHeight(check.limitM, units)} limit`
      : check.kind === "duration"
        ? `About ${formatDuration(check.actualMin)} against a ${formatDuration(check.targetMin)} target`
        : `Steepest step ${formatGrade(check.actualPct)} against a ${formatGrade(check.limitPct)} limit`;
  const verdict = check.ok
    ? check.kind === "duration"
      ? "Close"
      : "Met"
    : check.kind === "duration"
      ? "Off target"
      : "Not met";
  return (
    <li className="flex items-start justify-between gap-2 text-xs">
      <span>{text}</span>
      <span
        className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
          check.ok ? "bg-success/15 text-success" : "bg-danger/15 text-danger"
        }`}
      >
        {verdict}
      </span>
    </li>
  );
}

export function PlannerPanel({
  state,
  ready,
  isLive,
  units,
  onRun,
  onCancel,
  onAddKey,
}: PlannerPanelProps) {
  const [text, setText] = useState("");
  const inputId = useId();
  const working = state.status === "working";
  const activeRequest = state.status === "idle" ? null : state.request;

  // The result lands below the buttons that started it; bring it into view when it changes.
  const resultRef = useRef<HTMLDivElement>(null);
  const status = state.status;
  useEffect(() => {
    if (status === "idle") return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    resultRef.current?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [status]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const request = text.trim();
    if (request.length >= 3 && isLive && !working) onRun({ request, units });
  };

  return (
    <Section title="Or ask for a route in words" aside="optional AI">
      <p className="text-xs leading-snug text-muted">
        Describe a trip the way you would say it. Claude Opus 5.5 turns it into route settings, the
        router above finds the route, and Claude describes it using only the router&apos;s numbers.
      </p>

      <div className="flex flex-col gap-1.5">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted">
          Try a sample request
        </p>
        {PLANNER_PRESETS.map((preset) => (
          <button
            key={preset.demoId}
            type="button"
            disabled={!ready || working}
            onClick={() => onRun(preset)}
            aria-pressed={activeRequest === preset.request}
            className={`rounded-md border px-2.5 py-2 text-left text-xs leading-snug disabled:opacity-50 ${
              activeRequest === preset.request
                ? "border-accent bg-accent/10"
                : "border-border hover:bg-surface"
            }`}
          >
            {preset.request}
          </button>
        ))}
      </div>

      <form onSubmit={submit} className="flex flex-col gap-1.5">
        <label
          htmlFor={inputId}
          className="text-[11px] font-medium uppercase tracking-wide text-muted"
        >
          Your own request
        </label>
        <div className="flex gap-1.5">
          <input
            id={inputId}
            value={text}
            onChange={(event) => setText(event.target.value)}
            maxLength={300}
            disabled={!isLive}
            placeholder={
              isLive ? "Easy hike from Brighton, about 90 minutes" : "Needs your Anthropic key"
            }
            className="min-w-0 flex-1 rounded-md border border-border bg-bg px-2 py-1.5 text-sm disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={!isLive || !ready || working || text.trim().length < 3}
            className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-accent-fg disabled:opacity-50"
          >
            Plan
          </button>
        </div>
        {!isLive && (
          <p className="text-[11px] leading-snug text-muted">
            The three requests above work without a key. Typing your own calls Claude, so it needs
            yours.{" "}
            <button
              type="button"
              onClick={onAddKey}
              className="font-medium text-accent underline underline-offset-2"
            >
              Add key
            </button>
          </p>
        )}
      </form>

      <div ref={resultRef} aria-live="polite" className="flex scroll-mb-3 flex-col gap-3">
        {state.status === "working" && (
          <div className="flex flex-col gap-2 rounded-md border border-border bg-bg p-3">
            <ol className="flex flex-col gap-1 text-xs">
              {STEPS.map(({ step, label }, index) => {
                const at = STEPS.findIndex((entry) => entry.step === state.step);
                return (
                  <li
                    key={step}
                    className={
                      index === at
                        ? "font-semibold"
                        : index < at
                          ? "text-muted line-through"
                          : "text-muted"
                    }
                  >
                    {index + 1}. {label}
                    {index === at ? "…" : ""}
                  </li>
                );
              })}
            </ol>
            <button
              type="button"
              onClick={onCancel}
              className="self-start rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-surface"
            >
              Cancel
            </button>
          </div>
        )}

        {state.status === "error" && (
          <div role="alert" className="rounded-md border border-danger/40 bg-danger/10 p-3 text-xs">
            <p className="font-semibold text-danger">
              {state.kind === "refusal"
                ? "Claude declined this request"
                : state.kind === "demo_miss"
                  ? "That request is not one of the samples"
                  : state.kind === "auth"
                    ? "There is a problem with the key"
                    : state.kind === "rate_limit"
                      ? "Too many requests"
                      : "That did not work"}
            </p>
            <p className="mt-1">{state.message}</p>
            {(state.kind === "auth" || state.kind === "demo_miss") && (
              <button
                type="button"
                onClick={onAddKey}
                className="mt-2 font-medium text-accent underline underline-offset-2"
              >
                {state.kind === "auth" ? "Change key" : "Add key"}
              </button>
            )}
          </div>
        )}

        {state.status === "done" && (
          <div className="flex flex-col gap-3 rounded-md border border-border bg-bg p-3">
            <div className="flex flex-col gap-1.5">
              <p className="text-[11px] font-medium text-muted">
                {constraintsCaption(state.constraintsMeta)}
              </p>
              <ul className="flex flex-wrap gap-1">
                {chips(state.constraints, units).map((chip) => (
                  <li
                    key={chip}
                    className="rounded border border-border bg-surface px-1.5 py-0.5 text-[11px]"
                  >
                    {chip}
                  </li>
                ))}
              </ul>
            </div>

            {!state.plan.found ? (
              <p className="text-xs text-danger">{state.plan.reason}</p>
            ) : (
              <>
                {state.plan.checks.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <p className="text-[11px] font-medium text-muted">
                      Checked by code against the route
                    </p>
                    <ul className="flex flex-col gap-1">
                      {state.plan.checks.map((check) => (
                        <CheckRow key={check.kind} check={check} units={units} />
                      ))}
                    </ul>
                  </div>
                )}
                {state.narration && (
                  <figure className="flex flex-col gap-1 border-l-2 border-route pl-2.5">
                    <figcaption className="text-[11px] font-medium text-muted">
                      {narrationCaption(state.meta, state.narration, state.rebuilt)}
                    </figcaption>
                    <p className="text-sm font-semibold">{state.narration.title}</p>
                    <p className="text-xs leading-relaxed">{state.narration.narration}</p>
                  </figure>
                )}
                {state.narrationError && (
                  <p role="alert" className="text-xs text-danger">
                    The route is drawn, but the write-up failed: {state.narrationError}
                  </p>
                )}
                <p className="text-[11px] text-muted">
                  {state.plan.searches === 1 ? "One search" : `${state.plan.searches} searches`} in{" "}
                  {Math.max(1, Math.round(state.plan.ms))} ms.
                </p>
              </>
            )}
            <CostMeter meta={state.meta} />
          </div>
        )}
      </div>
    </Section>
  );
}
