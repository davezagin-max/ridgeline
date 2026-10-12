"""Web Mercator tile maths and the Terrarium elevation encoding.

Terrain Tiles are 256 px PNGs addressed as z/x/y in the usual "slippy map" scheme:
x counts east from the antimeridian, y counts south from about 85.05 N.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import numpy.typing as npt

TILE_SIZE = 256
TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"

FloatArray = npt.NDArray[np.float64]


@dataclass(frozen=True)
class Bounds:
    """A latitude/longitude box in degrees."""

    west: float
    south: float
    east: float
    north: float

    def __post_init__(self) -> None:
        if not (self.west < self.east and self.south < self.north):
            raise ValueError("Bounds must have west < east and south < north.")


@dataclass(frozen=True)
class TileRange:
    """Inclusive tile indices covering a box at one zoom level."""

    zoom: int
    x_min: int
    y_min: int
    x_max: int
    y_max: int

    @property
    def columns(self) -> int:
        return self.x_max - self.x_min + 1

    @property
    def rows(self) -> int:
        return self.y_max - self.y_min + 1

    def tiles(self) -> list[tuple[int, int]]:
        return [
            (x, y)
            for y in range(self.y_min, self.y_max + 1)
            for x in range(self.x_min, self.x_max + 1)
        ]


def lonlat_to_pixel(
    lon: FloatArray | float, lat: FloatArray | float, zoom: int
) -> tuple[FloatArray, FloatArray]:
    """Longitude/latitude in degrees to global Web Mercator pixel coordinates.

    Pixel (0, 0) is the top-left corner of tile 0/0; one tile is 256 pixels.
    """
    world = TILE_SIZE * 2**zoom
    lon_arr = np.asarray(lon, dtype=np.float64)
    lat_rad = np.radians(np.asarray(lat, dtype=np.float64))
    x = (lon_arr + 180.0) / 360.0 * world
    y = (1.0 - np.arcsinh(np.tan(lat_rad)) / math.pi) / 2.0 * world
    return x, y


def tile_range(bounds: Bounds, zoom: int) -> TileRange:
    """The tiles needed to cover `bounds`, with no extra ring around them."""
    x_west, y_north = lonlat_to_pixel(bounds.west, bounds.north, zoom)
    x_east, y_south = lonlat_to_pixel(bounds.east, bounds.south, zoom)
    last = 2**zoom - 1

    def index(pixel: FloatArray) -> int:
        return min(max(int(math.floor(float(pixel) / TILE_SIZE)), 0), last)

    return TileRange(zoom, index(x_west), index(y_north), index(x_east), index(y_south))


def decode_terrarium(rgb: npt.NDArray[np.uint8]) -> npt.NDArray[np.float32]:
    """Terrarium RGB to metres: red * 256 + green + blue / 256 - 32768."""
    if rgb.ndim != 3 or rgb.shape[2] < 3:
        raise ValueError("Expected an (height, width, 3) RGB array.")
    channels = rgb[..., :3].astype(np.float64)
    metres = channels[..., 0] * 256.0 + channels[..., 1] + channels[..., 2] / 256.0 - 32768.0
    return metres.astype(np.float32)


def tile_url(zoom: int, x: int, y: int) -> str:
    return TILE_URL.format(z=zoom, x=x, y=y)
