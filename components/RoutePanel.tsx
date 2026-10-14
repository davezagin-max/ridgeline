"use client";

import { useId } from "react";
import { gridToLonLat, type GridMeta } from "@/lib/terrain/grid";
import { LANDMARKS, type LandmarkKind } from "@/lib/terrain/landmarks";
import { MODE_CLIMB_WEIGHT } from "@/lib/terrain/route";
import { PACE } from "@/lib/terrain/stats";
import {
  formatDistance,
  formatDuration,
  formatGrade,
  formatHeight,
  type Units,
} from "@/lib/terrain/units";
import {
  landmarkPoint,
  type PickTarget,
  type RoutePoint,
  type RouteSpec,
  type RouteView,
} from "./route-types";
import { InlineStat, Section, Segmented, Stat, Toggle } from "./ui";

const GROUPS: { kind: LandmarkKind[]; label: string }[] = [
  { kind: ["resort", "town"], label: "Resorts and town" },
  { kind: ["pass", "trailhead", "lake"], label: "Passes, trailheads, lakes" },
  { kind: ["peak"], label: "Peaks" },
];

const MAP_POINT = "__map-point";

interface RoutePanelProps {
  meta: GridMeta;
  spec: RouteSpec;
  route: RouteView | null;
  ready: boolean;
  /** True when the heightmap could not be loaded. */
  failed: boolean;
  units: Units;
  picking: PickTarget | null;
  onChange: (patch: Partial<RouteSpec>) => void;
  onPick: (target: PickTarget | null) => void;
}

/** One end of the route: the same A or B badge as the map marker, then the place list. */
function PointSelect({
  label,
  marker,
  point,
  meta,
  onSelect,
}: {
  label: string;
  marker: "A" | "B";
  point: RoutePoint;
  meta: GridMeta;
  onSelect: (point: RoutePoint) => void;
}) {
  const id = useId();
  const position = gridToLonLat(meta, point.col, point.row);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <label htmlFor={id} className="shrink-0">
        <span
          aria-hidden
          className="flex size-[22px] items-center justify-center rounded-full bg-fg text-[11px] font-bold leading-none text-bg"
        >
          {marker}
        </span>
        <span className="sr-only">{label}</span>
      </label>
      <select
        id={id}
        value={point.landmarkId ?? MAP_POINT}
        onChange={(event) => {
          if (event.target.value !== MAP_POINT) onSelect(landmarkPoint(meta, event.target.value));
        }}
        className="w-full min-w-0 rounded-md border border-border bg-bg px-2 py-1.5 text-sm"
      >
        {point.landmarkId === null && (
          <option value={MAP_POINT}>
            Map point ({position.lat.toFixed(3)}, {position.lon.toFixed(3)})
          </option>
        )}
        {GROUPS.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {LANDMARKS.filter((landmark) => group.kind.includes(landmark.kind)).map((landmark) => (
              <option key={landmark.id} value={landmark.id}>
                {landmark.name}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}

/** One plain sentence on what the current mode trades off, so the switch explains itself. */
function modeHint(mode: RouteSpec["mode"], units: Units): string {
  const weight = MODE_CLIMB_WEIGHT["climb-friendly"];
  return mode === "climb-friendly"
    ? units === "imperial"
      ? `Counts each foot climbed like ${weight} ft of extra distance, so it detours to save climbing.`
      : `Counts each metre climbed like ${weight} m of extra distance, so it detours to save climbing.`
    : "The most direct line the grade limit allows, however much it climbs.";
}

function SwapIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M5 2.5v11M2.5 11 5 13.5 7.5 11M11 13.5v-11M8.5 5 11 2.5 13.5 5" />
    </svg>
  );
}

export function RoutePanel({
  meta,
  spec,
  route,
  ready,
  failed,
  units,
  picking,
  onChange,
  onPick,
}: RoutePanelProps) {
  const gradeId = useId();
  const stats = route?.found ? route.stats : null;

  return (
    <Section title="Plan a route">
      <button
        type="button"
        onClick={() => onPick(picking ? null : "start")}
        aria-pressed={picking !== null}
        title={picking ? "Press again to cancel" : undefined}
        disabled={!ready}
        className={`flex items-center justify-center gap-2 rounded-md px-3 py-2.5 text-sm font-semibold shadow-sm disabled:opacity-50 ${
          picking
            ? "border border-accent bg-bg text-fg"
            : "bg-accent text-accent-fg hover:opacity-90"
        }`}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          aria-hidden
        >
          <circle cx="8" cy="8" r="5.2" />
          <path d="M8 1v2.4M8 12.6V15M1 8h2.4M12.6 8H15" />
        </svg>
        {picking === "start"
          ? "Pick the start on the map…"
          : picking === "goal"
            ? "Now pick the end on the map…"
            : "Pick two points on the map"}
      </button>

      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <PointSelect
            label="Start"
            marker="A"
            point={spec.start}
            meta={meta}
            onSelect={(start) => onChange({ start })}
          />
          <PointSelect
            label="End"
            marker="B"
            point={spec.goal}
            meta={meta}
            onSelect={(goal) => onChange({ goal })}
          />
        </div>
        <button
          type="button"
          onClick={() => onChange({ start: spec.goal, goal: spec.start })}
          aria-label="Swap start and end"
          title="Swap start and end"
          className="flex size-[34px] shrink-0 items-center justify-center rounded-md border border-border text-muted hover:bg-surface hover:text-fg"
        >
          <SwapIcon />
        </button>
      </div>

      <div className="flex flex-col gap-1.5">
        <Segmented
          label="Routing mode"
          name="mode"
          value={spec.mode}
          onChange={(mode) => onChange({ mode })}
          options={[
            { value: "climb-friendly", label: "Climb-friendly" },
            { value: "shortest", label: "Shortest" },
          ]}
        />
        <p className="text-[11px] leading-snug text-muted">{modeHint(spec.mode, units)}</p>
      </div>

      <div aria-live="polite">
        {failed ? (
          <p className="text-xs text-muted">
            The terrain did not load, so there is nothing to route on.
          </p>
        ) : !ready || !route ? (
          <p className="text-xs text-muted">Finding a route…</p>
        ) : stats ? (
          <div className="flex flex-col gap-2 rounded-md border border-border bg-bg/60 p-3">
            <dl className="flex justify-between gap-3">
              <Stat big label="Distance" value={formatDistance(stats.distanceM, units)} />
              <Stat big label="Climb" value={formatHeight(stats.climbM, units)} />
              <Stat
                big
                label={spec.activity === "ride" ? "Time, riding" : "Time, hiking"}
                value={formatDuration(stats.minutes)}
                hint={`Naismith's rule: ${PACE[spec.activity].flatKmh} km/h plus an hour per ${PACE[spec.activity].climbMPerHour} m climbed`}
              />
            </dl>
            <dl className="flex flex-wrap gap-x-2.5 gap-y-0.5 text-[11px] text-muted">
              <InlineStat label="Descent" value={formatHeight(stats.descentM, units)} />
              <InlineStat label="Steepest" value={formatGrade(stats.maxGradePct)} />
              <InlineStat label="Highest" value={formatHeight(stats.maxElevationM, units)} />
            </dl>
            <p className="border-t border-border pt-2 text-[11px] leading-snug text-muted">
              {route.planned
                ? "Route from the request below."
                : `Best route for these settings, found in ${Math.max(1, Math.round(route.ms))} ms after checking ${route.expanded.toLocaleString("en-US")} map cells.`}
            </p>
          </div>
        ) : (
          <div className="rounded-md border border-danger/40 bg-danger/10 p-3 text-xs">
            <p className="font-semibold text-danger">No route under a {spec.maxGradePct}% grade.</p>
            <p className="mt-1 text-muted">
              Every way through crosses ground steeper than the limit. Raise the steepest grade
              under Route options, or pick ends on the same side of the ridge.
            </p>
          </div>
        )}
      </div>

      <details className="group rounded-md border border-border">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-md px-3 py-2 text-xs [&::-webkit-details-marker]:hidden">
          <span className="font-medium">Route options</span>
          <span className="flex items-center gap-1.5 text-muted">
            <span>
              {spec.maxGradePct}% max grade, {spec.roundTrip ? "out and back, " : ""}
              {PACE[spec.activity].label.toLowerCase()}
            </span>
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              aria-hidden
              className="transition-transform group-open:rotate-180"
            >
              <path
                d="M2.5 4.5 6 8l3.5-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        </summary>
        <div className="flex flex-col gap-3 border-t border-border px-3 pb-3 pt-2.5">
          <div className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between text-xs">
              <label htmlFor={gradeId} className="font-medium">
                Steepest grade allowed
              </label>
              <output htmlFor={gradeId} className="font-mono tabular-nums">
                {spec.maxGradePct}%
              </output>
            </div>
            <input
              id={gradeId}
              type="range"
              min={8}
              max={45}
              step={1}
              value={spec.maxGradePct}
              onChange={(event) => onChange({ maxGradePct: Number(event.target.value) })}
              className="w-full accent-[var(--accent)]"
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <Toggle
              label="Out and back"
              checked={spec.roundTrip}
              onChange={(roundTrip) => onChange({ roundTrip })}
            />
            <div className="w-36">
              <Segmented
                label="Pace"
                name="activity"
                value={spec.activity}
                onChange={(activity) => onChange({ activity })}
                options={[
                  { value: "hike", label: PACE.hike.label },
                  { value: "ride", label: PACE.ride.label },
                ]}
              />
            </div>
          </div>
        </div>
      </details>
    </Section>
  );
}
