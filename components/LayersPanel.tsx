"use client";

import { useId } from "react";
import { SLOPE_BANDS } from "@/lib/terrain/slope";
import type { Units } from "@/lib/terrain/units";
import { Section, Segmented, Toggle } from "./ui";

export interface Layers {
  hillshade: boolean;
  slopeBands: boolean;
  contours: boolean;
  /** Contour interval in metres. */
  interval: number;
  labels: boolean;
}

export const CONTOUR_INTERVALS = [25, 50, 100] as const;

interface LayersPanelProps {
  layers: Layers;
  onLayers: (patch: Partial<Layers>) => void;
  exaggeration: number;
  onExaggeration: (value: number) => void;
  units: Units;
  onUnits: (units: Units) => void;
  view: "3d" | "2d";
  onView: (view: "3d" | "2d") => void;
  /** False when the browser cannot do WebGL, so only the 2D map is offered. */
  webgl: boolean;
  /** Contour lines drawn at the current interval, for the caption. */
  contourLevels: number | null;
}

export function LayersPanel(props: LayersPanelProps) {
  const { layers, onLayers, exaggeration, onExaggeration, units, onUnits, view, onView, webgl } =
    props;
  const intervalId = useId();
  const exaggerationId = useId();

  return (
    <Section title="Layers">
      <div className="flex flex-col gap-2">
        <Toggle
          label="Hillshade"
          checked={layers.hillshade}
          onChange={(hillshade) => onLayers({ hillshade })}
        />
        <Toggle
          label="Slope angle"
          checked={layers.slopeBands}
          onChange={(slopeBands) => onLayers({ slopeBands })}
        />
        {layers.slopeBands && (
          <div className="ml-6 flex flex-col gap-1.5">
            <ul className="flex flex-wrap gap-x-2 gap-y-1" aria-label="Slope angle colours">
              {SLOPE_BANDS.map((band) => (
                <li key={band.label} className="flex items-center gap-1 font-mono text-[10px]">
                  <span
                    className="inline-block size-2.5 rounded-sm border border-border"
                    style={{ background: `rgb(${band.color.join(" ")})` }}
                  />
                  {band.label}
                </li>
              ))}
            </ul>
            <p className="text-[11px] leading-snug text-muted">
              Angles are measured across 31 m cells, which smooths out short steep pitches. This is
              a picture of the terrain, not an avalanche assessment.
            </p>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Toggle
            label="Contours"
            checked={layers.contours}
            onChange={(contours) => onLayers({ contours })}
          />
          <label htmlFor={intervalId} className="sr-only">
            Contour interval
          </label>
          <select
            id={intervalId}
            value={layers.interval}
            disabled={!layers.contours}
            onChange={(event) => onLayers({ interval: Number(event.target.value) })}
            className="rounded-md border border-border bg-bg px-1.5 py-1 text-xs disabled:opacity-50"
          >
            {CONTOUR_INTERVALS.map((interval) => (
              <option key={interval} value={interval}>
                every {interval} m ({Math.round(interval / 0.3048)} ft)
              </option>
            ))}
          </select>
          {layers.contours && props.contourLevels !== null && (
            <span className="text-[11px] text-muted">
              {props.contourLevels} levels, marching squares
            </span>
          )}
        </div>
        <Toggle
          label="Place names"
          checked={layers.labels}
          onChange={(labels) => onLayers({ labels })}
        />
      </div>

      {view === "3d" && (
        <div className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between text-xs">
            <label htmlFor={exaggerationId} className="font-medium">
              Vertical exaggeration
            </label>
            <output htmlFor={exaggerationId} className="font-mono tabular-nums">
              {exaggeration.toFixed(1)}x
            </output>
          </div>
          <input
            id={exaggerationId}
            type="range"
            min={1}
            max={2.5}
            step={0.1}
            value={exaggeration}
            onChange={(event) => onExaggeration(Number(event.target.value))}
            className="w-full accent-[var(--accent)]"
          />
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Segmented
          label="View"
          name="view"
          value={view}
          onChange={onView}
          options={
            webgl
              ? [
                  { value: "3d", label: "3D" },
                  { value: "2d", label: "2D map" },
                ]
              : [{ value: "2d", label: "2D map" }]
          }
        />
        <Segmented
          label="Units"
          name="units"
          value={units}
          onChange={onUnits}
          options={[
            { value: "imperial", label: "mi / ft" },
            { value: "metric", label: "km / m" },
          ]}
        />
      </div>
      {!webgl && (
        <p className="text-[11px] text-muted">
          This browser has no WebGL, so the terrain is shown as a flat map. Everything else works
          the same.
        </p>
      )}
    </Section>
  );
}
