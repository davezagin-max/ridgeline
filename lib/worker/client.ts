/** Promise wrapper around the terrain worker. Browser only. */
import type { CallName, Calls, WorkerRequest, WorkerResponse } from "./protocol";

interface Pending {
  resolve: (value: never) => void;
  reject: (error: Error) => void;
}

export class TerrainWorker {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;

  constructor() {
    this.worker = new Worker(new URL("./terrain.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.ok) entry.resolve(message.result as never);
      else entry.reject(new Error(message.error));
    };
    this.worker.onerror = () => {
      for (const entry of this.pending.values())
        entry.reject(new Error("The terrain worker crashed."));
      this.pending.clear();
    };
  }

  call<N extends CallName>(
    type: N,
    payload: Calls[N]["request"],
    transfer: Transferable[] = [],
  ): Promise<Calls[N]["response"]> {
    const id = this.nextId++;
    const message: WorkerRequest<N> = { id, type, payload };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as Pending["resolve"], reject });
      this.worker.postMessage(message, transfer);
    });
  }

  terminate(): void {
    this.worker.terminate();
    for (const entry of this.pending.values())
      entry.reject(new Error("The terrain worker was stopped."));
    this.pending.clear();
  }
}
