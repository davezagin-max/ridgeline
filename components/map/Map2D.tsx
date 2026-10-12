"use client";

/**
 * The 2D map: the same baked texture drawn flat on a canvas, with contours and
 * the route stroked on top. It is the fallback when WebGL is unavailable and a
 * view in its own right (north up, no perspective).
 */
import { useEffect, useRef, type PointerEvent } from "react";
import { lonLatToGrid } from "@/lib/terrain/grid";
import { LandmarkLabel, PointMarker } from "./Markers";
import type { MapViewProps } from "./types";

export default function Map2D(props: MapViewProps) {
  const { grid, meta, pixels, contours, path, start, goal, marker, landmarks, showLabels, dark, picking } = props;
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);

  // The shaded terrain, one canvas pixel per heightmap sample.
  useEffect(() => {
    const canvas = baseRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context || !pixels) return;
    context.putImageData(new ImageData(pixels, grid.width, grid.height), 0, 0);
  }, [pixels, grid.width, grid.height]);

  // Contours and the route, drawn at twice the resolution so thin lines stay crisp.
  useEffect(() => {
    const canvas = overlayRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const scale = canvas.width / grid.width;
    const halfX = ((grid.width - 1) / 2) * grid.cellX;
    const halfZ = ((grid.height - 1) / 2) * grid.cellY;
    context.clearRect(0, 0, canvas.width, canvas.height);

    const strokeSegments = (positions: Float32Array, width: number, alpha: number) => {
      context.beginPath();
      for (let i = 0; i < positions.length; i += 6) {
        context.moveTo(((positions[i] + halfX) / grid.cellX) * scale, ((positions[i + 2] + halfZ) / grid.cellY) * scale);
        context.lineTo(((positions[i + 3] + halfX) / grid.cellX) * scale, ((positions[i + 5] + halfZ) / grid.cellY) * scale);
      }
      context.lineWidth = width;
      context.globalAlpha = alpha;
      context.strokeStyle = dark ? "#d7b386" : "#6f4520";
      context.stroke();
      context.globalAlpha = 1;
    };
    if (contours) {
      strokeSegments(contours.minor, 0.8, dark ? 0.35 : 0.42);
      strokeSegments(contours.index, 1.5, dark ? 0.8 : 0.85);
    }

    if (path && path.length > 1) {
      const trace = () => {
        context.beginPath();
        for (let i = 0; i < path.length; i++) {
          const x = (path[i] % grid.width) * scale;
          const y = Math.floor(path[i] / grid.width) * scale;
          if (i === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        }
      };
      context.lineJoin = "round";
      context.lineCap = "round";
      trace();
      context.lineWidth = 9;
      context.strokeStyle = dark ? "#0c0f0c" : "#ffffff";
      context.stroke();
      trace();
      context.lineWidth = 5;
      context.strokeStyle = dark ? "#ff55ac" : "#d6006f";
      context.stroke();
    }
  }, [contours, path, grid, dark]);

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!picking) return;
    const rect = event.currentTarget.getBoundingClientRect();
    props.onPick(
      ((event.clientX - rect.left) / rect.width) * (grid.width - 1),
      ((event.clientY - rect.top) / rect.height) * (grid.height - 1),
    );
  };

  const place = (point: { col: number; row: number }) => ({
    left: `${(point.col / (grid.width - 1)) * 100}%`,
    top: `${(point.row / (grid.height - 1)) * 100}%`,
  });

  return (
    <div className="absolute inset-0 flex items-center justify-center p-2 sm:p-4">
      <div
        className="relative max-h-full w-full max-w-[calc((100svh-12rem)*1.6)] overflow-hidden rounded-md border border-border shadow-lg"
        style={{ aspectRatio: `${grid.width} / ${grid.height}`, cursor: picking ? "crosshair" : "default" }}
        onPointerUp={handlePointerUp}
        role="img"
        aria-label="Shaded relief map of the central Wasatch with the current route"
      >
        <canvas ref={baseRef} width={grid.width} height={grid.height} className="absolute inset-0 size-full" />
        <canvas
          ref={overlayRef}
          width={grid.width * 2}
          height={grid.height * 2}
          className="absolute inset-0 size-full"
        />
        <div className="pointer-events-none absolute inset-0" aria-hidden>
          {showLabels &&
            landmarks.map((landmark) => (
              <div key={landmark.id} className="absolute" style={place(lonLatToGrid(meta, landmark.lon, landmark.lat))}>
                <LandmarkLabel landmark={landmark} />
              </div>
            ))}
          {start && (
            <div className="absolute" style={place(start)}>
              <PointMarker kind="start" />
            </div>
          )}
          {goal && (
            <div className="absolute" style={place(goal)}>
              <PointMarker kind="goal" />
            </div>
          )}
          {marker && (
            <div className="absolute" style={place(marker)}>
              <PointMarker kind="marker" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
