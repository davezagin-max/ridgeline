"use client";

import { useMemo, type PointerEvent } from "react";
import { sampleProfile, thinProfile, type Profile } from "@/lib/terrain/stats";
import { formatDistance, formatHeight, type Units } from "@/lib/terrain/units";

interface ProfileChartProps {
  profile: Profile;
  units: Units;
  /** Scrubber position, 0 to 1 along the route by distance. */
  position: number;
  onScrub: (position: number) => void;
}

const WIDTH = 1000;
const HEIGHT = 100;

/** Elevation against distance, with a scrubber that moves a marker along the route on the map. */
export function ProfileChart({ profile, units, position, onScrub }: ProfileChartProps) {
  const chart = useMemo(() => {
    const thin = thinProfile(profile, 320);
    const total = thin.distance[thin.distance.length - 1] || 1;
    let min = Infinity;
    let max = -Infinity;
    // The range comes from every sample, so the axis agrees with the route's high point.
    for (const value of profile.elevation) {
      if (value < min) min = value;
      if (value > max) max = value;
    }
    const pad = Math.max((max - min) * 0.1, 5);
    const low = min - pad;
    const span = max + pad - low;
    const points: string[] = [];
    for (let i = 0; i < thin.distance.length; i++) {
      const x = (thin.distance[i] / total) * WIDTH;
      const y = HEIGHT - ((thin.elevation[i] - low) / span) * HEIGHT;
      points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }
    const line = `M${points.join("L")}`;
    return { line, area: `${line}L${WIDTH},${HEIGHT}L0,${HEIGHT}Z`, min, max, low, span, total };
  }, [profile]);

  const sample = sampleProfile(profile, position);
  const markerTop = `${(1 - (sample.elevationM - chart.low) / chart.span) * 100}%`;
  const readout = `${formatDistance(sample.distanceM, units)}, ${formatHeight(sample.elevationM, units)}, ${
    sample.gradePct >= 0 ? "+" : "-"
  }${Math.abs(sample.gradePct).toFixed(0)}% grade`;

  const scrubFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.buttons === 0 && event.type !== "pointerdown")
      return;
    const rect = event.currentTarget.getBoundingClientRect();
    onScrub(Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1));
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <h3 className="font-semibold">Elevation profile</h3>
        <p className="truncate font-mono text-[11px] text-muted" aria-live="off">
          {readout}
        </p>
      </div>
      <div className="flex gap-2">
        <div className="flex w-14 shrink-0 flex-col justify-between text-right font-mono text-[10px] leading-none text-muted">
          <span>{formatHeight(chart.max, units)}</span>
          <span>{formatHeight(chart.min, units)}</span>
        </div>
        <div
          className="relative h-20 min-w-0 flex-1 touch-none select-none sm:h-24"
          onPointerDown={scrubFromPointer}
          onPointerMove={scrubFromPointer}
        >
          <svg
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            preserveAspectRatio="none"
            className="absolute inset-0 size-full"
            role="img"
            aria-label={`Elevation profile from ${formatHeight(chart.min, units)} to ${formatHeight(chart.max, units)} over ${formatDistance(chart.total, units)}`}
          >
            <path d={chart.area} fill="var(--accent)" opacity="0.2" />
            <path
              d={chart.line}
              fill="none"
              stroke="var(--accent)"
              strokeWidth="1.75"
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
            />
          </svg>
          <span
            className="pointer-events-none absolute bottom-0 top-0 w-px bg-route"
            style={{ left: `${position * 100}%` }}
          />
          <span
            className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-bg bg-route"
            style={{ left: `${position * 100}%`, top: markerTop }}
          />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="w-14 shrink-0 text-right font-mono text-[10px] text-muted">0</span>
        <input
          type="range"
          min={0}
          max={1000}
          step={1}
          value={Math.round(position * 1000)}
          onChange={(event) => onScrub(Number(event.target.value) / 1000)}
          className="scrubber min-w-0 flex-1"
          aria-label="Position along the route"
          aria-valuetext={readout}
        />
        <span className="shrink-0 font-mono text-[10px] text-muted">
          {formatDistance(chart.total, units)}
        </span>
      </div>
    </div>
  );
}
