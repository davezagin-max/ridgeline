"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import metaJson from "@/public/data/wasatch.json";
import { decodeHeightmap, type Grid, type GridMeta } from "@/lib/terrain/grid";
import { TerrainWorker } from "@/lib/worker/client";

export const TERRAIN_META = metaJson as GridMeta;

export type TerrainState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; grid: Grid; meta: GridMeta; worker: TerrainWorker };

/** Fetches the heightmap, decodes it for the page, and hands a copy to the worker. */
export function useTerrain(): TerrainState {
  const [state, setState] = useState<TerrainState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    let worker: TerrainWorker | null = null;
    (async () => {
      try {
        const response = await fetch(`/data/${TERRAIN_META.encoding.file}`);
        if (!response.ok) throw new Error(`The heightmap did not load (HTTP ${response.status}).`);
        const buffer = await response.arrayBuffer();
        const grid = decodeHeightmap(buffer, TERRAIN_META);
        worker = new TerrainWorker();
        // The page has its decoded copy, so the raw bytes can be moved to the worker.
        await worker.call("init", { buffer, meta: TERRAIN_META }, [buffer]);
        if (cancelled) return;
        setState({ status: "ready", grid, meta: TERRAIN_META, worker });
      } catch (error) {
        if (cancelled) return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "The terrain could not be loaded.",
        });
      }
    })();
    return () => {
      cancelled = true;
      worker?.terminate();
    };
  }, []);

  return state;
}

function subscribeTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

/** True while the page is in its dark theme. */
export function useDarkTheme(): boolean {
  return useSyncExternalStore(
    subscribeTheme,
    () => document.documentElement.dataset.theme === "dark",
    () => false,
  );
}

let webglSupport: boolean | null = null;

function detectWebgl(): boolean {
  if (webglSupport === null) {
    try {
      webglSupport = Boolean(document.createElement("canvas").getContext("webgl2"));
    } catch {
      webglSupport = false;
    }
  }
  return webglSupport;
}

const noSubscription = () => () => {};

/** Whether this browser can create a WebGL 2 context. Assumed true until checked on the client. */
export function useWebgl(): boolean {
  return useSyncExternalStore(noSubscription, detectWebgl, () => true);
}

const WIDE_QUERY = "(min-width: 1024px)";

function subscribeWide(onChange: () => void): () => void {
  const query = window.matchMedia(WIDE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** True at the breakpoint where the panels float over the map instead of stacking under it. */
export function useWideLayout(): boolean {
  return useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia(WIDE_QUERY).matches,
    () => false,
  );
}
