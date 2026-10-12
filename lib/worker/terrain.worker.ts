/// <reference lib="webworker" />
/**
 * Terrain worker: holds the heightmap and does the heavy lifting (shading the
 * texture, tracing contours, routing) off the main thread. One request at a
 * time, answered in order; large results are transferred, not copied.
 */
import { contourSegments, createState, plan, route, shade, type TerrainState } from "./handlers";
import type { Calls, WorkerRequest, WorkerResponse } from "./protocol";

declare const self: DedicatedWorkerGlobalScope;

let state: TerrainState | null = null;

function handle(message: WorkerRequest): {
  result: Calls[keyof Calls]["response"];
  transfer: Transferable[];
} {
  if (message.type === "init") {
    const { buffer, meta } = message.payload as Calls["init"]["request"];
    state = createState(buffer, meta);
    return { result: { nodes: state.grid.z.length }, transfer: [] };
  }
  if (!state) throw new Error("The terrain has not loaded yet.");
  switch (message.type) {
    case "shade": {
      const result = shade(state, message.payload as Calls["shade"]["request"]);
      return { result, transfer: [result.pixels.buffer] };
    }
    case "contours": {
      const { interval } = message.payload as Calls["contours"]["request"];
      const result = contourSegments(state, interval);
      return { result, transfer: [result.minor.buffer, result.index.buffer] };
    }
    case "route": {
      const result = route(state, message.payload as Calls["route"]["request"]);
      return { result, transfer: [result.path.buffer] };
    }
    case "plan": {
      const result = plan(state, message.payload as Calls["plan"]["request"]);
      return { result, transfer: [result.path.buffer] };
    }
    default:
      throw new Error("Unknown request.");
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  let response: WorkerResponse;
  let transfer: Transferable[] = [];
  try {
    const handled = handle(message);
    response = { id: message.id, ok: true, result: handled.result };
    transfer = handled.transfer;
  } catch (error) {
    response = {
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : "The terrain worker failed.",
    };
  }
  self.postMessage(response, transfer);
};
