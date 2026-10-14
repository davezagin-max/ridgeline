"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useKey } from "@/components/kit/KeyProvider";
import { LANDMARKS, findLandmark } from "@/lib/terrain/landmarks";
import { lonLatToGrid } from "@/lib/terrain/grid";
import { elevationProfile, sampleProfile } from "@/lib/terrain/stats";
import type { Units } from "@/lib/terrain/units";
import type { ContourResponse, PlanResponse } from "@/lib/worker/protocol";
import { LayersPanel, type Layers } from "./LayersPanel";
import { PlannerPanel } from "./PlannerPanel";
import { ProfileChart } from "./ProfileChart";
import { RoutePanel } from "./RoutePanel";
import Map2D from "./map/Map2D";
import type { CameraApi } from "./map/Terrain3D";
import {
  defaultSpec,
  landmarkPoint,
  pointNode,
  type PickTarget,
  type RoutePoint,
  type RouteSpec,
  type RouteView,
} from "./route-types";
import { usePlanner } from "./usePlanner";
import { TERRAIN_META, useDarkTheme, useTerrain, useWebgl, useWideLayout } from "./useTerrain";

// three.js and react-three-fiber load only in the browser, and only after the page shell is up.
const Terrain3D = dynamic(() => import("./map/Terrain3D"), {
  ssr: false,
  loading: () => <MapMessage>Starting the 3D view…</MapMessage>,
});

/** On wide screens the side panel and the profile card float over the map's left and bottom. */
const WIDE_INSET = { left: 352, bottom: 150 };
const NO_INSET = { left: 0, bottom: 0 };

/** A click this close to a landmark (in grid cells, about 190 m) snaps to it. */
const SNAP_CELLS = 6;

function MapMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted">
      {children}
    </div>
  );
}

const CAMERA_BUTTON =
  "flex size-8 items-center justify-center border-b border-border last:border-b-0 hover:bg-surface";

function Glyph({ d }: { d: string }) {
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
      <path d={d} />
    </svg>
  );
}

/** On-screen camera controls, so the 3D view can be driven from the keyboard. */
function CameraButtons({ api }: { api: RefObject<CameraApi | null> }) {
  return (
    <div className="absolute right-2 top-2 flex flex-col overflow-hidden rounded-md border border-border bg-panel text-fg shadow backdrop-blur">
      <button
        type="button"
        className={CAMERA_BUTTON}
        aria-label="Zoom in"
        title="Zoom in"
        onClick={() => api.current?.zoom(0.75)}
      >
        <Glyph d="M8 3v10M3 8h10" />
      </button>
      <button
        type="button"
        className={CAMERA_BUTTON}
        aria-label="Zoom out"
        title="Zoom out"
        onClick={() => api.current?.zoom(1.33)}
      >
        <Glyph d="M3 8h10" />
      </button>
      <button
        type="button"
        className={CAMERA_BUTTON}
        aria-label="Rotate left"
        title="Rotate left"
        onClick={() => api.current?.rotate(-Math.PI / 8)}
      >
        <Glyph d="M3.5 8a4.5 4.5 0 1 0 1.6-3.4M5 2v3H2" />
      </button>
      <button
        type="button"
        className={CAMERA_BUTTON}
        aria-label="Rotate right"
        title="Rotate right"
        onClick={() => api.current?.rotate(Math.PI / 8)}
      >
        <Glyph d="M12.5 8a4.5 4.5 0 1 1-1.6-3.4M11 2v3h3" />
      </button>
      <button
        type="button"
        className={CAMERA_BUTTON}
        aria-label="Reset view"
        title="Reset view"
        onClick={() => api.current?.reset()}
      >
        <Glyph d="M2.5 8 8 3l5.5 5M4.5 7v6h7V7" />
      </button>
    </div>
  );
}

function snapToLandmark(col: number, row: number): RoutePoint {
  let best: RoutePoint = { col: Math.round(col), row: Math.round(row), landmarkId: null };
  let bestDistance = SNAP_CELLS;
  for (const landmark of LANDMARKS) {
    const at = lonLatToGrid(TERRAIN_META, landmark.lon, landmark.lat);
    const distance = Math.hypot(at.col - col, at.row - row);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = landmarkPoint(TERRAIN_META, landmark.id);
    }
  }
  return best;
}

const PICK_HINT: Record<PickTarget, string> = {
  start: "Pick the start (A) on the map.",
  goal: "Now pick the end (B).",
};

function pointName(point: RoutePoint): string {
  return (point.landmarkId && findLandmark(point.landmarkId)?.name) || "a map point";
}

/**
 * "What am I looking at?" in one line over the map: what the pink line is, and how to move around.
 */
function MapCaption({
  spec,
  view,
  status,
}: {
  spec: RouteSpec;
  view: "3d" | "2d";
  status: "found" | "none" | "pending";
}) {
  const ends = (
    <>
      <span className="font-semibold">A</span> {pointName(spec.start)} to{" "}
      <span className="font-semibold">B</span> {pointName(spec.goal)}
      {spec.roundTrip && status === "found" ? " and back" : ""}
    </>
  );
  return (
    <div className="pointer-events-none absolute left-2 top-2 max-w-[calc(100%-4rem)] rounded-md border border-border bg-panel px-2.5 py-1.5 text-xs shadow-sm backdrop-blur lg:left-[364px] lg:max-w-md">
      <p className="flex items-center gap-2 font-medium">
        <span aria-hidden className="h-1 w-4 shrink-0 rounded-full bg-route" />
        <span className="min-w-0">
          {status === "found"
            ? "Route from "
            : status === "none"
              ? "No route from "
              : "Finding a route from "}
          {ends}
        </span>
      </p>
      <p className="mt-0.5 text-[11px] text-muted">
        {view === "3d" ? (
          <>
            <span className="pointer-coarse:hidden">
              Drag to move, right-drag to turn, scroll to zoom.
            </span>
            <span className="hidden pointer-coarse:inline">
              Drag to move, use two fingers to zoom and turn.
            </span>
          </>
        ) : (
          "Flat map, north up."
        )}
      </p>
    </div>
  );
}

export function Explorer() {
  const terrain = useTerrain();
  const dark = useDarkTheme();
  const webgl = useWebgl();
  const wide = useWideLayout();
  const { apiKey, isLive, openKeyModal } = useKey();
  const meta = TERRAIN_META;

  const [layers, setLayers] = useState<Layers>({
    hillshade: true,
    slopeBands: false,
    contours: true,
    interval: 50,
    labels: true,
  });
  const [exaggeration, setExaggeration] = useState(1.6);
  const [units, setUnits] = useState<Units>("imperial");
  const [wantedView, setWantedView] = useState<"3d" | "2d">("3d");
  const view = webgl ? wantedView : "2d";

  const [spec, setSpec] = useState<RouteSpec>(() => defaultSpec(TERRAIN_META));
  const [route, setRoute] = useState<RouteView | null>(null);
  const [position, setPosition] = useState(0.38);
  const [picking, setPicking] = useState<PickTarget | null>(null);
  const [pixels, setPixels] = useState<Uint8ClampedArray<ArrayBuffer> | null>(null);
  const [contours, setContours] = useState<ContourResponse | null>(null);

  /** The spec a plan produced. While it is current, the plan's own route is shown untouched. */
  const plannedSpec = useRef<RouteSpec | null>(null);
  const cameraApi = useRef<CameraApi | null>(null);

  const worker = terrain.status === "ready" ? terrain.worker : null;
  const grid = terrain.status === "ready" ? terrain.grid : null;

  // Bake the terrain texture whenever a shading layer or the theme changes.
  useEffect(() => {
    if (!worker) return;
    let stale = false;
    worker
      .call("shade", { hillshade: layers.hillshade, slopeBands: layers.slopeBands, dark })
      .then((result) => {
        if (!stale) setPixels(result.pixels);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [worker, layers.hillshade, layers.slopeBands, dark]);

  // Trace contours for the chosen interval.
  useEffect(() => {
    if (!worker || !layers.contours) return;
    let stale = false;
    worker
      .call("contours", { interval: layers.interval })
      .then((result) => {
        if (!stale) setContours(result);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [worker, layers.contours, layers.interval]);

  // Route whenever the controls change. Searches take milliseconds, so the latest request wins.
  useEffect(() => {
    if (!worker || plannedSpec.current === spec) return;
    let stale = false;
    worker
      .call("route", {
        start: pointNode(TERRAIN_META, spec.start),
        goal: pointNode(TERRAIN_META, spec.goal),
        mode: spec.mode,
        maxGrade: spec.maxGradePct / 100,
        roundTrip: spec.roundTrip,
        activity: spec.activity,
      })
      .then((result) => {
        if (stale) return;
        setRoute({
          spec,
          found: result.found,
          path: result.found ? result.path : null,
          stats: result.stats,
          expanded: result.expanded,
          ms: result.ms,
          planned: false,
        });
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [worker, spec]);

  /** Shows a planned route exactly as the planner computed it, and mirrors it in the controls. */
  const applyPlan = useCallback((plan: PlanResponse) => {
    const { constraints } = plan;
    const next: RouteSpec = {
      start: landmarkPoint(TERRAIN_META, constraints.start),
      goal: landmarkPoint(TERRAIN_META, plan.destination ?? constraints.start),
      mode: constraints.mode,
      maxGradePct: Math.round(plan.maxGrade * 100),
      roundTrip: plan.roundTrip,
      activity: constraints.activity,
    };
    plannedSpec.current = next;
    setSpec(next);
    setRoute({
      spec: next,
      found: plan.found,
      path: plan.found ? plan.path : null,
      stats: plan.stats,
      expanded: 0,
      ms: plan.ms,
      planned: true,
    });
    setPicking(null);
  }, []);

  const planner = usePlanner({ worker, apiKey, onPlan: applyPlan });
  const cancelPlanner = planner.cancel;

  /** Any manual change takes over from a planned route, so its write-up is cleared too. */
  const updateSpec = useCallback(
    (patch: Partial<RouteSpec>) => {
      plannedSpec.current = null;
      cancelPlanner();
      setSpec((previous) => ({ ...previous, ...patch }));
    },
    [cancelPlanner],
  );

  const handlePick = useCallback(
    (col: number, row: number) => {
      const point = snapToLandmark(col, row);
      if (picking === "start") updateSpec({ start: point });
      else if (picking === "goal") updateSpec({ goal: point });
      setPicking(picking === "start" ? "goal" : null);
    },
    [picking, updateSpec],
  );

  const path = route?.found ? route.path : null;
  const profile = useMemo(
    () => (grid && path && path.length > 1 ? elevationProfile(grid, path) : null),
    [grid, path],
  );
  const marker = useMemo(() => {
    if (!profile || !path) return null;
    const sample = sampleProfile(profile, position);
    const i0 = Math.floor(sample.index);
    const i1 = Math.min(i0 + 1, path.length - 1);
    const f = sample.index - i0;
    const width = TERRAIN_META.width;
    const colA = path[i0] % width;
    const colB = path[i1] % width;
    const rowA = Math.floor(path[i0] / width);
    const rowB = Math.floor(path[i1] / width);
    return { col: colA + (colB - colA) * f, row: rowA + (rowB - rowA) * f };
  }, [profile, path, position]);

  const stats = route?.found ? route.stats : null;
  /** Everything either map view draws. Callbacks are passed separately, at the JSX. */
  const mapData = grid
    ? {
        grid,
        meta,
        pixels,
        contours: layers.contours ? contours : null,
        path,
        start: spec.start,
        goal: spec.goal,
        marker,
        landmarks: LANDMARKS,
        showLabels: layers.labels,
        exaggeration,
        dark,
        picking: picking !== null,
      }
    : null;

  const profileBlock =
    profile && stats ? (
      <ProfileChart profile={profile} units={units} position={position} onScrub={setPosition} />
    ) : (
      <p className="py-4 text-center text-xs text-muted">
        {route && !route.found
          ? "No route to profile. Raise the grade limit or move an end."
          : "The elevation profile appears here once a route is found."}
      </p>
    );

  return (
    <div
      className="relative flex flex-1 flex-col lg:min-h-0"
      data-terrain={terrain.status}
      data-route={route ? (route.found ? "found" : "none") : "pending"}
      data-shaded={pixels ? "true" : "false"}
      data-view={view}
    >
      <div
        className="relative isolate h-[40svh] min-h-64 shrink-0 overflow-hidden lg:absolute lg:inset-0 lg:h-auto"
        style={{ background: "linear-gradient(var(--sky-top), var(--sky-bottom))" }}
      >
        {terrain.status === "loading" && (
          <MapMessage>Loading 1.3 MB of Wasatch elevation…</MapMessage>
        )}
        {terrain.status === "error" && (
          <MapMessage>
            <span role="alert" className="flex flex-col items-center gap-3">
              <span className="text-danger">{terrain.message}</span>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="rounded-md border border-border bg-bg px-3 py-1.5 text-xs font-medium text-fg"
              >
                Try again
              </button>
            </span>
          </MapMessage>
        )}
        {mapData &&
          (view === "3d" ? (
            <Terrain3D
              {...mapData}
              onPick={handlePick}
              apiRef={cameraApi}
              inset={wide ? WIDE_INSET : NO_INSET}
            />
          ) : (
            <Map2D {...mapData} onPick={handlePick} />
          ))}

        {mapData && view === "3d" && <CameraButtons api={cameraApi} />}

        {mapData && !picking && !meta.synthetic && (
          <MapCaption
            spec={spec}
            view={view}
            status={route ? (route.found ? "found" : "none") : "pending"}
          />
        )}

        {picking && (
          <div className="absolute left-1/2 top-2 flex w-max max-w-[calc(100%-4.5rem)] -translate-x-1/2 items-center gap-2 rounded-md border border-accent bg-panel px-3 py-1.5 text-xs font-medium shadow backdrop-blur">
            <span role="status">{PICK_HINT[picking]}</span>
            <button
              type="button"
              onClick={() => setPicking(null)}
              className="underline underline-offset-2"
            >
              Cancel
            </button>
          </div>
        )}

        {meta.synthetic && (
          <p className="absolute left-2 top-2 rounded-md border border-danger bg-panel px-2 py-1 text-xs font-semibold text-danger">
            Synthetic terrain: generated noise, not real elevation.
          </p>
        )}
        <p className="pointer-events-none absolute bottom-1 right-2 max-w-[70%] truncate rounded bg-panel px-1.5 py-0.5 text-[10px] text-muted lg:hidden">
          {meta.synthetic
            ? "Synthetic terrain"
            : "Elevation: Mapzen Terrain Tiles on AWS, USGS 3DEP"}
        </p>
      </div>

      <div className="flex flex-col lg:pointer-events-none lg:absolute lg:inset-0 lg:flex-row lg:gap-3 lg:p-3">
        {wide && (
          <div className="order-2 flex min-w-0 flex-1 flex-col justify-end">
            <div className="pointer-events-auto mr-10 rounded-lg border border-border bg-panel px-4 py-3 shadow-lg backdrop-blur">
              {profileBlock}
            </div>
          </div>
        )}

        <aside
          aria-label="Map controls"
          className="order-1 bg-bg lg:pointer-events-auto lg:w-[340px] lg:shrink-0 lg:overflow-y-auto lg:rounded-lg lg:border lg:border-border lg:bg-panel lg:shadow-lg lg:backdrop-blur"
        >
          <RoutePanel
            meta={meta}
            spec={spec}
            route={route}
            ready={terrain.status === "ready"}
            failed={terrain.status === "error"}
            units={units}
            picking={picking}
            onChange={updateSpec}
            onPick={setPicking}
          />
          {/* On phones the profile sits right under the route it describes. */}
          {!wide && <div className="border-b border-border px-4 py-4">{profileBlock}</div>}
          <PlannerPanel
            state={planner.state}
            ready={terrain.status === "ready"}
            isLive={isLive}
            units={units}
            onRun={planner.run}
            onCancel={planner.cancel}
            onAddKey={openKeyModal}
          />
          <LayersPanel
            layers={layers}
            onLayers={(patch) => setLayers((previous) => ({ ...previous, ...patch }))}
            exaggeration={exaggeration}
            onExaggeration={setExaggeration}
            units={units}
            onUnits={setUnits}
            view={view}
            onView={setWantedView}
            webgl={webgl}
            contourLevels={layers.contours && contours ? contours.levels : null}
          />
        </aside>
      </div>
    </div>
  );
}
