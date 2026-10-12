"use client";

/**
 * The 3D view: one terrain mesh textured with the baked shading, contour line
 * segments, a screen-space-thick route line, and DOM labels positioned by
 * projecting scene points each rendered frame.
 *
 * It renders on demand: nothing is drawn unless the camera or the data
 * changed. This file is loaded with `next/dynamic` so three.js stays out of
 * the first-load bundle.
 */
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, type RefObject } from "react";
import * as THREE from "three";
import { MapControls } from "three/addons/controls/MapControls.js";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { decimate, elevationAt, lonLatToGrid, type Grid } from "@/lib/terrain/grid";
import { LABEL_PRIORITY, crowdedLabels, labelWidth, type LabelBox } from "@/lib/terrain/labels";
import { pickTerrain } from "@/lib/terrain/pick";
import { MESH_STEP } from "@/lib/worker/protocol";
import { LandmarkLabel, PointMarker } from "./Markers";
import type { MapViewProps } from "./types";

/** Metres the route floats above the surface so it never sinks into the mesh. */
const ROUTE_LIFT = 18;
const CONTOUR_LIFT = 3;
const SKIRT_DEPTH = 260;

const OVERLAY_ITEM = "absolute left-0 top-0 opacity-0 will-change-transform";

interface SceneItem {
  key: string;
  x: number;
  /** Height above the base, before exaggeration. */
  y: number;
  z: number;
}

export interface CameraApi {
  zoom: (factor: number) => void;
  rotate: (radians: number) => void;
  reset: () => void;
}

function sceneX(grid: Grid, col: number): number {
  return (col - (grid.width - 1) / 2) * grid.cellX;
}

function sceneZ(grid: Grid, row: number): number {
  return (row - (grid.height - 1) / 2) * grid.cellY;
}

function buildTerrain(grid: Grid, base: number) {
  const coarse = decimate(grid, MESH_STEP);
  const { width, height } = coarse;
  const positions = new Float32Array(width * height * 3);
  const uvs = new Float32Array(width * height * 2);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const i = row * width + col;
      positions[i * 3] = sceneX(grid, col * MESH_STEP);
      positions[i * 3 + 1] = coarse.z[i] - base;
      positions[i * 3 + 2] = sceneZ(grid, row * MESH_STEP);
      // Sample the middle of the texel that belongs to this heightmap sample.
      uvs[i * 2] = (col * MESH_STEP + 0.5) / grid.width;
      uvs[i * 2 + 1] = (row * MESH_STEP + 0.5) / grid.height;
    }
  }
  const indices = new Uint32Array((width - 1) * (height - 1) * 6);
  let o = 0;
  for (let row = 0; row < height - 1; row++) {
    for (let col = 0; col < width - 1; col++) {
      const a = row * width + col;
      const b = a + 1;
      const c = a + width;
      const d = c + 1;
      indices[o++] = a;
      indices[o++] = c;
      indices[o++] = b;
      indices[o++] = b;
      indices[o++] = c;
      indices[o++] = d;
    }
  }
  const surface = new THREE.BufferGeometry();
  surface.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  surface.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  surface.setIndex(new THREE.BufferAttribute(indices, 1));

  // Side walls from the edge of the terrain down to a flat base, so it reads as a solid block.
  const rim: number[] = [];
  for (let col = 0; col < width; col++) rim.push(col);
  for (let row = 1; row < height; row++) rim.push(row * width + width - 1);
  for (let col = width - 2; col >= 0; col--) rim.push((height - 1) * width + col);
  for (let row = height - 2; row >= 1; row--) rim.push(row * width);
  const wall = new Float32Array(rim.length * 18);
  let w = 0;
  for (let i = 0; i < rim.length; i++) {
    const a = rim[i] * 3;
    const b = rim[(i + 1) % rim.length] * 3;
    const quad = [
      [positions[a], positions[a + 1], positions[a + 2]],
      [positions[b], positions[b + 1], positions[b + 2]],
      [positions[b], -SKIRT_DEPTH, positions[b + 2]],
      [positions[a], positions[a + 1], positions[a + 2]],
      [positions[b], -SKIRT_DEPTH, positions[b + 2]],
      [positions[a], -SKIRT_DEPTH, positions[a + 2]],
    ];
    for (const vertex of quad) {
      wall[w++] = vertex[0];
      wall[w++] = vertex[1];
      wall[w++] = vertex[2];
    }
  }
  const skirt = new THREE.BufferGeometry();
  skirt.setAttribute("position", new THREE.BufferAttribute(wall, 3));
  return { surface, skirt, coarse };
}

function Terrain({ grid, base, pixels, dark }: Pick<MapViewProps, "grid" | "pixels" | "dark"> & { base: number }) {
  const { surface, skirt } = useMemo(() => buildTerrain(grid, base), [grid, base]);
  const texture = useMemo(() => {
    if (!pixels) return null;
    const map = new THREE.DataTexture(pixels, grid.width, grid.height, THREE.RGBAFormat);
    map.colorSpace = THREE.SRGBColorSpace;
    map.magFilter = THREE.LinearFilter;
    map.minFilter = THREE.LinearMipmapLinearFilter;
    map.generateMipmaps = true;
    map.anisotropy = 8;
    map.needsUpdate = true;
    return map;
  }, [pixels, grid.width, grid.height]);
  const invalidate = useThree((state) => state.invalidate);

  useEffect(() => {
    invalidate();
    return () => texture?.dispose();
  }, [texture, invalidate]);
  useEffect(
    () => () => {
      surface.dispose();
      skirt.dispose();
    },
    [surface, skirt],
  );

  return (
    <>
      <mesh geometry={surface}>
        {/* Unlit: the hillshade is already in the texture. The offset keeps lines drawn on top. */}
        <meshBasicMaterial
          key={texture ? "textured" : "plain"}
          map={texture}
          color={texture ? "#ffffff" : dark ? "#2a3329" : "#b9c4a8"}
          polygonOffset
          polygonOffsetFactor={1}
          polygonOffsetUnits={2}
        />
      </mesh>
      <mesh geometry={skirt}>
        <meshBasicMaterial color={dark ? "#1c211a" : "#7d6a52"} side={THREE.DoubleSide} />
      </mesh>
    </>
  );
}

function ContourLines({ positions, color, opacity }: { positions: Float32Array<ArrayBuffer>; color: string; opacity: number }) {
  const geometry = useMemo(() => {
    const next = new THREE.BufferGeometry();
    next.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return next;
  }, [positions]);
  const invalidate = useThree((state) => state.invalidate);
  useEffect(() => {
    invalidate();
    return () => geometry.dispose();
  }, [geometry, invalidate]);
  return (
    <lineSegments geometry={geometry} position={[0, CONTOUR_LIFT, 0]}>
      <lineBasicMaterial color={color} transparent opacity={opacity} />
    </lineSegments>
  );
}

function RouteLine({
  points,
  color,
  width,
  casing,
}: {
  points: Float32Array;
  color: string;
  width: number;
  /** The wide outline drawn first; it must not write depth or it would hide the line inside it. */
  casing: boolean;
}) {
  const line = useMemo(() => {
    const geometry = new LineGeometry();
    geometry.setPositions(points);
    const material = new LineMaterial({
      color,
      linewidth: width,
      worldUnits: false,
      depthWrite: !casing,
    });
    const next = new Line2(geometry, material);
    next.renderOrder = casing ? 2 : 3;
    return next;
  }, [points, color, width, casing]);
  const invalidate = useThree((state) => state.invalidate);
  useEffect(() => {
    invalidate();
    return () => {
      line.geometry.dispose();
      line.material.dispose();
    };
  }, [line, invalidate]);
  return <primitive object={line} />;
}

/** Orbit, pan and zoom, with touch support; also exposes zoom/rotate/reset for the on-screen buttons. */
function Controls({
  apiRef,
  home,
  inset,
}: {
  apiRef: RefObject<CameraApi | null>;
  home: { position: THREE.Vector3; target: THREE.Vector3 };
  inset: { left: number; bottom: number };
}) {
  const get = useThree((state) => state.get);
  const controlsRef = useRef<MapControls | null>(null);

  useEffect(() => {
    const { camera, gl, invalidate } = get();
    const controls = new MapControls(camera, gl.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.14;
    controls.screenSpacePanning = false;
    controls.minDistance = 2500;
    controls.maxDistance = 90000;
    controls.maxPolarAngle = Math.PI * 0.46;
    controls.zoomToCursor = true;
    /** The home view, pulled back when the free part of the view is narrow (phones). */
    const goHome = () => {
      const { size } = get();
      const aspect = Math.max(size.width - inset.left, 1) / Math.max(size.height - inset.bottom, 1);
      const pullBack = aspect >= 1.7 ? 1 : 1 + (1.7 - aspect) * 0.55;
      controls.target.copy(home.target);
      camera.position.copy(home.position).sub(home.target).multiplyScalar(pullBack).add(home.target);
      controls.update();
    };
    goHome();
    const onChange = () => invalidate();
    controls.addEventListener("change", onChange);
    controlsRef.current = controls;

    const offset = new THREE.Vector3();
    apiRef.current = {
      zoom(factor) {
        offset.copy(camera.position).sub(controls.target).multiplyScalar(factor);
        const length = Math.min(Math.max(offset.length(), controls.minDistance), controls.maxDistance);
        camera.position.copy(controls.target).add(offset.setLength(length));
        controls.update();
        invalidate();
      },
      rotate(radians) {
        offset.copy(camera.position).sub(controls.target).applyAxisAngle(THREE.Object3D.DEFAULT_UP, radians);
        camera.position.copy(controls.target).add(offset);
        controls.update();
        invalidate();
      },
      reset() {
        goHome();
        invalidate();
      },
    };
    invalidate();
    return () => {
      controls.removeEventListener("change", onChange);
      controls.dispose();
      controlsRef.current = null;
      apiRef.current = null;
    };
  }, [get, apiRef, home, inset.left, inset.bottom]);

  useFrame(() => {
    controlsRef.current?.update();
  });
  return null;
}

/** Turns a click (not a drag) into a grid position by intersecting the view ray with the heightfield. */
function Picker({ grid, base, exaggeration, picking, onPick }: Pick<MapViewProps, "grid" | "exaggeration" | "picking" | "onPick"> & { base: number }) {
  const get = useThree((state) => state.get);
  useEffect(() => {
    if (!picking) return;
    const { gl, camera } = get();
    const element = gl.domElement;
    const raycaster = new THREE.Raycaster();
    let down: { x: number; y: number } | null = null;
    const onDown = (event: PointerEvent) => {
      down = { x: event.clientX, y: event.clientY };
    };
    const onUp = (event: PointerEvent) => {
      if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 6) return;
      const rect = element.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      const { origin, direction } = raycaster.ray;
      const hit = pickTerrain(
        grid,
        { baseElevation: base, exaggeration },
        [origin.x, origin.y, origin.z],
        [direction.x, direction.y, direction.z],
      );
      if (hit) onPick(hit.col, hit.row);
    };
    element.addEventListener("pointerdown", onDown);
    element.addEventListener("pointerup", onUp);
    return () => {
      element.removeEventListener("pointerdown", onDown);
      element.removeEventListener("pointerup", onUp);
    };
  }, [get, grid, base, exaggeration, picking, onPick]);
  return null;
}

/**
 * Moves the DOM labels and markers to follow their scene points. The overlay
 * sits beside the canvas inside the same `data-terrain-root` element; each of
 * its children carries a `data-key` naming the scene point it tracks. Runs
 * only on rendered frames.
 *
 * Labels are placed greedily in priority order (the overlay lists them that
 * way): a name that would overlap one already placed is hidden and only its
 * symbol stays, so the map never turns into a pile of text.
 */
function Projector({ items, exaggeration }: { items: SceneItem[]; exaggeration: number }) {
  const invalidate = useThree((state) => state.invalidate);
  const scratch = useMemo(() => new THREE.Vector3(), []);
  const byKey = useMemo(() => new Map(items.map((item) => [item.key, item])), [items]);
  useEffect(() => invalidate(), [byKey, exaggeration, invalidate]);
  useFrame(({ camera, size, gl }) => {
    const container = gl.domElement
      .closest("[data-terrain-root]")
      ?.querySelector<HTMLElement>("[data-overlay]");
    if (!container) return;
    const boxes: LabelBox[] = [];
    const labelled: HTMLElement[] = [];
    for (const element of container.children as HTMLCollectionOf<HTMLElement>) {
      const item = byKey.get(element.dataset.key ?? "");
      if (!item) continue;
      scratch.set(item.x, item.y * exaggeration, item.z).project(camera);
      const visible = scratch.z < 1 && Math.abs(scratch.x) < 1.02 && Math.abs(scratch.y) < 1.02;
      element.style.opacity = visible ? "1" : "0";
      if (!visible) continue;
      const x = (scratch.x * 0.5 + 0.5) * size.width;
      const y = (-scratch.y * 0.5 + 0.5) * size.height;
      element.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      const width = Number(element.dataset.labelWidth ?? 0);
      if (width > 0) {
        boxes.push({ key: item.key, x, y, width });
        labelled.push(element);
      }
    }
    const crowded = crowdedLabels(boxes);
    for (let i = 0; i < labelled.length; i++) {
      labelled[i].dataset.crowded = crowded.has(boxes[i].key) ? "true" : "false";
    }
  });
  return null;
}

/** Shifts the picture so the map is centred in the part of the view the panels leave free. */
function ViewOffset({ left, bottom }: { left: number; bottom: number }) {
  const get = useThree((state) => state.get);
  const size = useThree((state) => state.size);
  useEffect(() => {
    const { camera, invalidate } = get();
    if (!(camera instanceof THREE.PerspectiveCamera)) return;
    if (left > 0 || bottom > 0) {
      camera.setViewOffset(size.width, size.height, -left / 2, bottom / 2, size.width, size.height);
    } else {
      camera.clearViewOffset();
    }
    invalidate();
  }, [get, size, left, bottom]);
  return null;
}

interface Terrain3DProps extends MapViewProps {
  apiRef: RefObject<CameraApi | null>;
  /** Screen pixels covered by floating panels on the left and bottom edges. */
  inset: { left: number; bottom: number };
}

export default function Terrain3D(props: Terrain3DProps) {
  const { grid, meta, pixels, contours, path, start, goal, marker, landmarks, showLabels, exaggeration, dark } = props;
  const base = meta.minElevation;
  const coarse = useMemo(() => decimate(grid, MESH_STEP), [grid]);

  const home = useMemo(() => {
    // From above the Salt Lake valley, looking east-north-east up the canyons.
    const target = new THREE.Vector3(2000, 1200, 500);
    return { target, position: new THREE.Vector3(-19500, 15500, 17500).add(target) };
  }, []);

  /** Height of the drawn surface (the coarse mesh), so overlays sit on what is visible. */
  const surfaceY = useMemo(
    () => (col: number, row: number) =>
      Math.max(elevationAt(coarse, col / MESH_STEP, row / MESH_STEP), elevationAt(grid, col, row)) - base,
    [coarse, grid, base],
  );

  const routePoints = useMemo(() => {
    if (!path || path.length < 2) return null;
    const points = new Float32Array(path.length * 3);
    for (let i = 0; i < path.length; i++) {
      const col = path[i] % grid.width;
      const row = Math.floor(path[i] / grid.width);
      points[i * 3] = sceneX(grid, col);
      points[i * 3 + 1] = surfaceY(col, row) + ROUTE_LIFT;
      points[i * 3 + 2] = sceneZ(grid, row);
    }
    return points;
  }, [path, grid, surfaceY]);

  const items = useMemo(() => {
    const list: SceneItem[] = [];
    const add = (key: string, point: { col: number; row: number } | null, lift: number) => {
      if (!point) return;
      list.push({
        key,
        x: sceneX(grid, point.col),
        y: surfaceY(point.col, point.row) + lift,
        z: sceneZ(grid, point.row),
      });
    };
    if (showLabels) {
      for (const landmark of landmarks) {
        add(`landmark:${landmark.id}`, lonLatToGrid(meta, landmark.lon, landmark.lat), 30);
      }
    }
    add("start", start, ROUTE_LIFT);
    add("goal", goal, ROUTE_LIFT);
    add("marker", marker, ROUTE_LIFT);
    return list;
  }, [grid, meta, landmarks, showLabels, start, goal, marker, surfaceY]);

  const labelOrder = useMemo(
    () => [...landmarks].sort((a, b) => LABEL_PRIORITY[a.kind] - LABEL_PRIORITY[b.kind]),
    [landmarks],
  );

  const routeColor = dark ? "#ff55ac" : "#d6006f";
  const contourColor = dark ? "#d7b386" : "#6f4520";

  return (
    <div
      className="absolute inset-0"
      data-terrain-root
      role="img"
      aria-label="3D terrain of the central Wasatch with the current route. Drag to pan, scroll or pinch to zoom, or use the camera buttons."
    >
      <Canvas
        frameloop="demand"
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
        camera={{ fov: 38, near: 200, far: 400000, position: home.position.toArray() }}
        style={{ cursor: props.picking ? "crosshair" : "grab" }}
      >
        <group scale={[1, exaggeration, 1]}>
          <Terrain grid={grid} base={base} pixels={pixels} dark={dark} />
          {contours && contours.minor.length > 0 && (
            <ContourLines positions={contours.minor} color={contourColor} opacity={dark ? 0.3 : 0.38} />
          )}
          {contours && contours.index.length > 0 && (
            <ContourLines positions={contours.index} color={contourColor} opacity={dark ? 0.75 : 0.85} />
          )}
          {routePoints && (
            <>
              <RouteLine points={routePoints} color={dark ? "#0c0f0c" : "#ffffff"} width={8} casing />
              <RouteLine points={routePoints} color={routeColor} width={4.5} casing={false} />
            </>
          )}
        </group>
        <Controls apiRef={props.apiRef} home={home} inset={props.inset} />
        <Picker grid={grid} base={base} exaggeration={exaggeration} picking={props.picking} onPick={props.onPick} />
        <Projector items={items} exaggeration={exaggeration} />
        <ViewOffset left={props.inset.left} bottom={props.inset.bottom} />
      </Canvas>

      {/* Labels and markers are DOM, positioned by the Projector above. Order is priority. */}
      <div data-overlay className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        {start && (
          <div data-key="start" data-label-width="14" className={`${OVERLAY_ITEM} z-10`}>
            <PointMarker kind="start" />
          </div>
        )}
        {goal && (
          <div data-key="goal" data-label-width="14" className={`${OVERLAY_ITEM} z-10`}>
            <PointMarker kind="goal" />
          </div>
        )}
        {marker && (
          <div data-key="marker" className={`${OVERLAY_ITEM} z-10`}>
            <PointMarker kind="marker" />
          </div>
        )}
        {showLabels &&
          labelOrder.map((landmark) => (
            <div
              key={landmark.id}
              data-key={`landmark:${landmark.id}`}
              data-label-width={labelWidth(landmark.name)}
              className={`${OVERLAY_ITEM} group`}
            >
              <LandmarkLabel landmark={landmark} />
            </div>
          ))}
      </div>
    </div>
  );
}
