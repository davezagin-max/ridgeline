"use client";

import { useId } from "react";
import { gridToLonLat, type GridMeta } from "@/lib/terrain/grid";
import { LANDMARKS, type LandmarkKind } from "@/lib/terrain/landmarks";
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
import { Section, Segmented, Stat, Toggle } from "./ui";

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

function PointSelect({
  label,
  point,
  meta,
  onSelect,
}: {
  label: string;
  point: RoutePoint;
  meta: GridMeta;
  onSelect: (point: RoutePoint) => void;
}) {
  const id = useId();
  const position = gridToLonLat(meta, point.col, point.row);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-[11px] font-medium uppercase tracking-wide text-muted">
        {label}
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
    <Section title="Route" aside="A* on the elevation grid">
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

      <div className="flex flex-col gap-2">
        <div className="grid grid-cols-2 gap-2">
          <PointSelect
            label="From"
            point={spec.start}
            meta={meta}
            onSelect={(start) => onChange({ start })}
          />
          <PointSelect
            label="To"
            point={spec.goal}
            meta={meta}
            onSelect={(goal) => onChange({ goal })}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => onPick(picking ? null : "start")}
            aria-pressed={picking !== null}
            className={`rounded-md border px-2.5 py-1.5 text-xs font-medium ${
              picking ? "border-accent bg-accent text-accent-fg" : "border-border hover:bg-surface"
            }`}
          >
            {picking === "start"
              ? "Click the start…"
              : picking === "goal"
                ? "Now click the end…"
                : "Click two points on the map"}
          </button>
          <button
            type="button"
            onClick={() => onChange({ start: spec.goal, goal: spec.start })}
            className="rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-surface"
          >
            Swap ends
          </button>
        </div>
      </div>

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

      <div aria-live="polite">
        {failed ? (
          <p className="text-xs text-muted">
            The terrain did not load, so there is nothing to route on.
          </p>
        ) : !ready || !route ? (
          <p className="text-xs text-muted">Finding a route…</p>
        ) : stats ? (
          <>
            <dl className="grid grid-cols-3 gap-x-3 gap-y-2">
              <Stat label="Distance" value={formatDistance(stats.distanceM, units)} />
              <Stat label="Climb" value={formatHeight(stats.climbM, units)} />
              <Stat label="Descent" value={formatHeight(stats.descentM, units)} />
              <Stat
                label="Est. time"
                value={formatDuration(stats.minutes)}
                hint={`Naismith's rule: ${PACE[spec.activity].flatKmh} km/h plus an hour per ${PACE[spec.activity].climbMPerHour} m climbed`}
              />
              <Stat label="Steepest" value={formatGrade(stats.maxGradePct)} />
              <Stat label="High point" value={formatHeight(stats.maxElevationM, units)} />
            </dl>
            <p className="mt-2 text-[11px] text-muted">
              {route.planned
                ? "Route from the request below."
                : `Optimal for this cost: ${route.expanded.toLocaleString("en-US")} cells searched in ${Math.max(1, Math.round(route.ms))} ms.`}
            </p>
          </>
        ) : (
          <div className="rounded-md border border-danger/40 bg-danger/10 p-3 text-xs">
            <p className="font-semibold text-danger">No route under a {spec.maxGradePct}% grade.</p>
            <p className="mt-1 text-muted">
              Every way through crosses ground steeper than the limit. Raise the limit, or pick ends
              on the same side of the ridge.
            </p>
          </div>
        )}
      </div>
    </Section>
  );
}
