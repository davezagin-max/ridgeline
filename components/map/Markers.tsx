import type { Landmark } from "@/lib/terrain/landmarks";
import { LABEL_KINDS_ALWAYS } from "./types";

const HALO =
  "0 0 2px var(--bg), 0 0 2px var(--bg), 0 0 3px var(--bg), 0 1px 3px var(--bg), 0 -1px 3px var(--bg)";

/** A map label anchored at its symbol: the symbol sits on the point, the name to its right. */
export function LandmarkLabel({ landmark }: { landmark: Landmark }) {
  const major = LABEL_KINDS_ALWAYS.has(landmark.kind);
  return (
    <span className="absolute flex -translate-x-[5px] -translate-y-1/2 items-center gap-1 whitespace-nowrap group-data-[crowded=true]:[&>span]:hidden">
      {landmark.kind === "peak" ? (
        <svg width="10" height="10" viewBox="0 0 10 10" className="shrink-0">
          <path d="M5 1 9.2 9H.8z" fill="var(--contour)" stroke="var(--bg)" strokeWidth="1" />
        </svg>
      ) : (
        <svg width="10" height="10" viewBox="0 0 10 10" className="shrink-0">
          <circle
            cx="5"
            cy="5"
            r="3.4"
            fill={major ? "var(--fg)" : landmark.kind === "lake" ? "var(--water)" : "var(--accent)"}
            stroke="var(--bg)"
            strokeWidth="1.2"
          />
        </svg>
      )}
      <span
        className={
          major
            ? "text-[11px] font-semibold leading-none text-fg sm:text-xs"
            : "hidden text-[10px] font-medium leading-none text-fg/85 md:inline"
        }
        style={{ textShadow: HALO }}
      >
        {landmark.name}
      </span>
    </span>
  );
}

/** Start (A), end (B), and the scrubber's position along the route. */
export function PointMarker({ kind }: { kind: "start" | "goal" | "marker" }) {
  if (kind === "marker") {
    return (
      <span className="absolute block size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-bg bg-route shadow-[0_0_0_2px_var(--route)]" />
    );
  }
  return (
    <span className="absolute flex size-[22px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-bg bg-fg text-[11px] font-bold leading-none text-bg shadow">
      {kind === "start" ? "A" : "B"}
    </span>
  );
}
