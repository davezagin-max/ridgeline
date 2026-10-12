"""Resampling a tile mosaic onto the app's grid, and the on-disk heightmap format.

The grid is regular in longitude and latitude ("node registered": the first and last
samples sit exactly on the box edges). Over a box this small that is, to within a few
tenths of a percent, a regular grid in metres, so the app treats each cell as a
`cell_x` by `cell_y` metre rectangle measured at the box's middle latitude.

On disk: `<name>.u16` is `height * width` little-endian unsigned 16-bit integers, row 0
at the north edge, and `elevation_m = offset_m + value * scale_m`. `<name>.json`
carries everything needed to read it.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import numpy.typing as npt

from .tiles import Bounds, lonlat_to_pixel

EARTH_RADIUS_M = 6_371_008.8  # IUGG mean radius
SCALE_M = 0.1  # one stored unit is 10 cm

Elevation = npt.NDArray[np.float32]


@dataclass(frozen=True)
class Mosaic:
    """Decoded elevation for a block of tiles, with the global pixel of its top-left corner."""

    elevation: Elevation
    zoom: int
    origin_x: int
    origin_y: int


def cell_size_m(bounds: Bounds, width: int, height: int) -> tuple[float, float]:
    """East-west and north-south spacing between neighbouring samples, in metres."""
    mid_lat = math.radians((bounds.south + bounds.north) / 2.0)
    span_x = math.radians(bounds.east - bounds.west) * EARTH_RADIUS_M * math.cos(mid_lat)
    span_y = math.radians(bounds.north - bounds.south) * EARTH_RADIUS_M
    return span_x / (width - 1), span_y / (height - 1)


def resample(mosaic: Mosaic, bounds: Bounds, width: int, height: int) -> Elevation:
    """Bilinear resample of the mosaic onto a `height` by `width` lon/lat grid.

    A tile pixel's value belongs to the pixel centre, so global pixel coordinate
    `p` reads array index `p - 0.5`.
    """
    lons = np.linspace(bounds.west, bounds.east, width)
    lats = np.linspace(bounds.north, bounds.south, height)
    px, _ = lonlat_to_pixel(lons, bounds.north, mosaic.zoom)
    _, py = lonlat_to_pixel(bounds.west, lats, mosaic.zoom)
    cols = px - mosaic.origin_x - 0.5
    rows = py - mosaic.origin_y - 0.5

    rows_available, cols_available = mosaic.elevation.shape
    if (
        cols.min() < -0.5
        or rows.min() < -0.5
        or cols.max() > cols_available - 0.5
        or rows.max() > rows_available - 0.5
    ):
        raise ValueError("The mosaic does not cover the requested bounds.")
    cols = np.clip(cols, 0.0, cols_available - 1.0)
    rows = np.clip(rows, 0.0, rows_available - 1.0)

    c0 = np.minimum(np.floor(cols).astype(np.intp), cols_available - 2)
    r0 = np.minimum(np.floor(rows).astype(np.intp), rows_available - 2)
    tc = (cols - c0)[np.newaxis, :]
    tr = (rows - r0)[:, np.newaxis]
    source = mosaic.elevation.astype(np.float64)
    top = source[np.ix_(r0, c0)] * (1 - tc) + source[np.ix_(r0, c0 + 1)] * tc
    bottom = source[np.ix_(r0 + 1, c0)] * (1 - tc) + source[np.ix_(r0 + 1, c0 + 1)] * tc
    return (top * (1 - tr) + bottom * tr).astype(np.float32)


def quantize(elevation: Elevation) -> tuple[npt.NDArray[np.uint16], float]:
    """Pack metres into uint16 steps of `SCALE_M` above a whole-metre offset."""
    offset = float(math.floor(float(elevation.min())))
    steps = np.rint((elevation.astype(np.float64) - offset) / SCALE_M)
    if steps.max() > np.iinfo(np.uint16).max:
        raise ValueError("Elevation range does not fit in 16 bits at this scale.")
    return steps.astype("<u2"), offset


def dequantize(values: npt.NDArray[np.uint16], offset: float) -> Elevation:
    return (values.astype(np.float64) * SCALE_M + offset).astype(np.float32)


def write_heightmap(
    out_dir: Path,
    name: str,
    elevation: Elevation,
    bounds: Bounds,
    extra: dict[str, Any],
) -> dict[str, Any]:
    """Write `<name>.u16` and `<name>.json`; returns the metadata that was written."""
    height, width = elevation.shape
    values, offset = quantize(elevation)
    stored = dequantize(values, offset)
    cell_x, cell_y = cell_size_m(bounds, width, height)
    meta: dict[str, Any] = {
        "name": name,
        "width": width,
        "height": height,
        "bounds": {
            "west": bounds.west,
            "south": bounds.south,
            "east": bounds.east,
            "north": bounds.north,
        },
        "cellX": round(cell_x, 4),
        "cellY": round(cell_y, 4),
        "minElevation": round(float(stored.min()), 1),
        "maxElevation": round(float(stored.max()), 1),
        "encoding": {
            "file": f"{name}.u16",
            "type": "uint16-le",
            "offset": offset,
            "scale": SCALE_M,
            "rowOrder": "north-to-south",
        },
        **extra,
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / f"{name}.u16").write_bytes(values.tobytes())
    (out_dir / f"{name}.json").write_text(json.dumps(meta, indent=2) + "\n")
    return meta


def read_heightmap(out_dir: Path, name: str) -> tuple[Elevation, dict[str, Any]]:
    meta = json.loads((out_dir / f"{name}.json").read_text())
    raw = np.frombuffer((out_dir / f"{name}.u16").read_bytes(), dtype="<u2")
    values = raw.reshape(meta["height"], meta["width"])
    return dequantize(values, meta["encoding"]["offset"]), meta
