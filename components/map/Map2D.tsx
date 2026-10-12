"use client";

/**
 * The 2D map: the same baked texture drawn flat on a canvas, with contours and
 * the route stroked on top. It is the fallback when WebGL is unavailable and a
 * view in its own right (north up, no perspective).
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { lonLatToGrid } from "@/lib/terrain/grid";
import { LABEL_PRIORITY, crowdedLabels, labelWidth } from "@/lib/terrain/labels";
import { LandmarkLabel, PointMarker } from "./Markers";
import type { MapViewProps } from "./types";

/** The overlay canvas has this many pixels per heightmap sample, so thin lines stay crisp. */
const OVERLAY_SCALE = 2;

export default function Map2D(props: MapViewProps) {
  const {
    grid,
    meta,
    pixels,
    contours,
    path,
    start,
    goal,
    marker,
    landmarks,
    showLabels,
    dark,
    picking,
  } = props;
  const frameRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  /** Width of the map on screen, in CSS pixels. Zero until measured. */
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  // The shaded terrain, one canvas pixel per heightmap sample.
  useEffect(() => {
    const canvas = baseRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context || !pixels) return;
    context.putImageData(new ImageData(pixels, grid.width, grid.height), 0, 0);
  }, [pixels, grid.width, grid.height]);

  // Contours and the route.
  useEffect(() => {
    const canvas = overlayRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context || width === 0) return;
    const scale = OVERLAY_SCALE;
    // Canvas pixels per CSS pixel, so line widths below are in screen pixels.
    const px = canvas.width / width;
    const halfX = ((grid.width - 1) / 2) * grid.cellX;
    const halfZ = ((grid.height - 1) / 2) * grid.cellY;
    context.clearRect(0, 0, canvas.width, canvas.height);

    const strokeSegments = (positions: Float32Array, lineWidth: number, alpha: number) => {
      context.beginPath();
      for (let i = 0; i < positions.length; i += 6) {
        context.moveTo(
          ((positions[i] + halfX) / grid.cellX) * scale,
          ((positions[i + 2] + halfZ) / grid.cellY) * scale,
        );
        context.lineTo(
          ((positions[i + 3] + halfX) / grid.cellX) * scale,
          ((positions[i + 5] + halfZ) / grid.cellY) * scale,
        );
      }
      context.lineWidth = lineWidth * px;
      context.globalAlpha = alpha;
      context.strokeStyle = dark ? "#d7b386" : "#6f4520";
      context.stroke();
      context.globalAlpha = 1;
    };
    if (contours) {
      strokeSegments(contours.minor, 0.5, dark ? 0.4 : 0.45);
      strokeSegments(contours.index, 0.9, dark ? 0.8 : 0.85);
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
      context.lineWidth = 6.5 * px;
      context.strokeStyle = dark ? "#0c0f0c" : "#ffffff";
      context.stroke();
      trace();
      context.lineWidth = 3.5 * px;
      context.strokeStyle = dark ? "#ff55ac" : "#d6006f";
      context.stroke();
    }
  }, [contours, path, grid, dark, width]);

  const ordered = useMemo(
    () => [...landmarks].sort((a, b) => LABEL_PRIORITY[a.kind] - LABEL_PRIORITY[b.kind]),
    [landmarks],
  );

  /** Names that would overlap a marker or a more important name at the current size. */
  const crowded = useMemo(() => {
    const height = (width * grid.height) / grid.width;
    const at = (point: { col: number; row: number }) => ({
      x: (point.col / (grid.width - 1)) * width,
      y: (point.row / (grid.height - 1)) * height,
    });
    const boxes = [
      ...(start ? [{ key: "start", ...at(start), width: 14 }] : []),
      ...(goal ? [{ key: "goal", ...at(goal), width: 14 }] : []),
      ...ordered.map((landmark) => ({
        key: landmark.id,
        ...at(lonLatToGrid(meta, landmark.lon, landmark.lat)),
        width: labelWidth(landmark.name),
      })),
    ];
    return crowdedLabels(boxes);
  }, [ordered, start, goal, width, grid.width, grid.height, meta]);

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
    // On wide screens the padding keeps the map clear of the floating panel and profile card.
    <div className="absolute inset-0 p-2 lg:pb-[196px] lg:pl-[364px] lg:pr-3 lg:pt-3">
      <div className="flex size-full items-center justify-center [container-type:size]">
        <div
          ref={frameRef}
          className="relative overflow-hidden rounded-md border border-border shadow-lg"
          style={{
            // The largest box of the map's aspect ratio that fits the free space.
            width: `min(100cqw, calc(100cqh * ${grid.width} / ${grid.height}))`,
            aspectRatio: `${grid.width} / ${grid.height}`,
            cursor: picking ? "crosshair" : "default",
          }}
          onPointerUp={handlePointerUp}
          role="img"
          aria-label="Shaded relief map of the central Wasatch with the current route"
        >
          <canvas
            ref={baseRef}
            width={grid.width}
            height={grid.height}
            className="absolute inset-0 size-full"
          />
          <canvas
            ref={overlayRef}
            width={grid.width * OVERLAY_SCALE}
            height={grid.height * OVERLAY_SCALE}
            className="absolute inset-0 size-full"
          />
          <div className="pointer-events-none absolute inset-0" aria-hidden>
            {showLabels &&
              ordered.map((landmark) => (
                <div
                  key={landmark.id}
                  data-crowded={crowded.has(landmark.id)}
                  className="group absolute"
                  style={place(lonLatToGrid(meta, landmark.lon, landmark.lat))}
                >
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
    </div>
  );
}
