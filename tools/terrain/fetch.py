"""Downloads Terrarium tiles into a local cache and assembles them into one mosaic.

Tiles are plain PNG images. They are decoded as pixel data only, checked for the
expected size, and never executed. The cache directory is git-ignored.
"""

from __future__ import annotations

import io
import ssl
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from pathlib import Path

import numpy as np
import truststore
from PIL import Image

from .heightmap import Mosaic
from .tiles import TILE_SIZE, TileRange, decode_terrarium, tile_url

USER_AGENT = "ridgeline-tools/0.1 (portfolio project; one-off heightmap build)"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

Fetcher = Callable[[str], bytes]


def http_get(url: str, *, attempts: int = 3, timeout: float = 30.0) -> bytes:
    """GET with a short retry. Raises the last error if every attempt fails."""
    if not url.startswith("https://"):
        raise ValueError("Only https URLs are fetched.")
    # Verify certificates against the operating system's trust store. A python.org build
    # on macOS ships without a CA bundle, and switching verification off is not an option.
    context = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    last: Exception | None = None
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=timeout, context=context) as response:
                data: bytes = response.read()
                return data
        except (urllib.error.URLError, TimeoutError) as error:
            last = error
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"Could not fetch {url}") from last


def decode_tile(png: bytes) -> np.ndarray:
    """PNG bytes to a 256 x 256 float32 array of metres."""
    if not png.startswith(PNG_SIGNATURE):
        raise ValueError("Tile is not a PNG image.")
    with Image.open(io.BytesIO(png)) as image:
        rgb = np.asarray(image.convert("RGB"), dtype=np.uint8)
    if rgb.shape[:2] != (TILE_SIZE, TILE_SIZE):
        raise ValueError(f"Expected a {TILE_SIZE} px tile, got {rgb.shape[1]} x {rgb.shape[0]}.")
    return decode_terrarium(rgb)


def load_tile(zoom: int, x: int, y: int, cache: Path, fetcher: Fetcher = http_get) -> np.ndarray:
    """One tile's elevation, read from the cache or downloaded and cached."""
    path = cache / str(zoom) / str(x) / f"{y}.png"
    if path.exists():
        return decode_tile(path.read_bytes())
    png = fetcher(tile_url(zoom, x, y))
    elevation = decode_tile(png)  # validate before caching
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png)
    return elevation


def build_mosaic(tiles: TileRange, cache: Path, fetcher: Fetcher = http_get) -> Mosaic:
    """Stitches every tile in the range into one array."""
    elevation = np.empty((tiles.rows * TILE_SIZE, tiles.columns * TILE_SIZE), dtype=np.float32)
    for x, y in tiles.tiles():
        row = (y - tiles.y_min) * TILE_SIZE
        col = (x - tiles.x_min) * TILE_SIZE
        elevation[row : row + TILE_SIZE, col : col + TILE_SIZE] = load_tile(
            tiles.zoom, x, y, cache, fetcher
        )
    return Mosaic(elevation, tiles.zoom, tiles.x_min * TILE_SIZE, tiles.y_min * TILE_SIZE)
