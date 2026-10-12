import io
import json
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from terrain.build import HEIGHT, WASATCH, WIDTH
from terrain.fetch import build_mosaic, decode_tile, http_get, load_tile
from terrain.heightmap import (
    SCALE_M,
    Mosaic,
    cell_size_m,
    dequantize,
    quantize,
    read_heightmap,
    resample,
    write_heightmap,
)
from terrain.synthetic import synthetic_terrain
from terrain.tiles import TILE_SIZE, Bounds, lonlat_to_pixel, tile_range

PUBLIC_DATA = Path(__file__).resolve().parents[2] / "public" / "data"


def encode_terrarium(metres: np.ndarray) -> bytes:
    """Inverse of the decoder, for building fake tiles."""
    value = metres.astype(np.float64) + 32768.0
    red = np.floor(value / 256.0)
    green = np.floor(value - red * 256.0)
    blue = np.floor((value - red * 256.0 - green) * 256.0)
    rgb = np.stack([red, green, blue], axis=-1).astype(np.uint8)
    buffer = io.BytesIO()
    Image.fromarray(rgb, "RGB").save(buffer, format="PNG")
    return buffer.getvalue()


def plane_mosaic(zoom: int = 12) -> Mosaic:
    """A mosaic whose elevation is a known linear function of global pixel position."""
    tiles = tile_range(WASATCH, zoom)
    rows, cols = tiles.rows * TILE_SIZE, tiles.columns * TILE_SIZE
    origin_x, origin_y = tiles.x_min * TILE_SIZE, tiles.y_min * TILE_SIZE
    px = origin_x + np.arange(cols) + 0.5
    py = origin_y + np.arange(rows) + 0.5
    elevation = (
        2.0 * (px[np.newaxis, :] - origin_x) + 3.0 * (py[:, np.newaxis] - origin_y)
    ).astype(np.float32)
    return Mosaic(elevation, zoom, origin_x, origin_y)


def test_cell_size_is_about_31_metres_and_nearly_square() -> None:
    cell_x, cell_y = cell_size_m(WASATCH, WIDTH, HEIGHT)
    assert cell_x == pytest.approx(31.36, abs=0.05)
    assert cell_y == pytest.approx(31.32, abs=0.05)


def test_cell_size_shrinks_east_west_at_higher_latitude() -> None:
    low, _ = cell_size_m(Bounds(-1, 0, 1, 1), 101, 101)
    high, _ = cell_size_m(Bounds(-1, 60, 1, 61), 101, 101)
    assert high == pytest.approx(low * np.cos(np.radians(60.5)) / np.cos(np.radians(0.5)), rel=1e-9)


def test_resample_reproduces_a_plane_exactly() -> None:
    mosaic = plane_mosaic()
    grid = resample(mosaic, WASATCH, 64, 40)
    assert grid.shape == (40, 64)
    lons = np.linspace(WASATCH.west, WASATCH.east, 64)
    lats = np.linspace(WASATCH.north, WASATCH.south, 40)
    px, _ = lonlat_to_pixel(lons, WASATCH.north, 12)
    _, py = lonlat_to_pixel(WASATCH.west, lats, 12)
    expected = 2.0 * (px[np.newaxis, :] - mosaic.origin_x) + 3.0 * (
        py[:, np.newaxis] - mosaic.origin_y
    )
    assert np.allclose(grid, expected, atol=0.01)


def test_resample_puts_north_in_row_zero() -> None:
    grid = resample(plane_mosaic(), WASATCH, 16, 10)
    # Elevation grows with pixel y (southward), so the last row is the highest.
    assert grid[-1, 0] > grid[0, 0]
    assert grid[0, -1] > grid[0, 0]


def test_resample_refuses_bounds_the_mosaic_does_not_cover() -> None:
    wider = Bounds(WASATCH.west - 1.0, WASATCH.south, WASATCH.east, WASATCH.north)
    with pytest.raises(ValueError):
        resample(plane_mosaic(), wider, 16, 10)


def test_quantize_round_trip_is_within_half_a_step() -> None:
    elevation = np.array([[1311.74, 2000.03], [3451.26, 2718.28]], dtype=np.float32)
    values, offset = quantize(elevation)
    assert values.dtype == np.dtype("<u2")
    assert offset == 1311.0
    assert np.abs(dequantize(values, offset) - elevation).max() <= SCALE_M / 2 + 1e-3


def test_quantize_rejects_a_range_too_tall_for_16_bits() -> None:
    with pytest.raises(ValueError):
        quantize(np.array([[0.0, 7000.0]], dtype=np.float32))


def test_write_then_read_round_trips(tmp_path: Path) -> None:
    elevation = synthetic_terrain(48, 30)
    meta = write_heightmap(tmp_path, "demo", elevation, WASATCH, {"synthetic": True})
    assert (tmp_path / "demo.u16").stat().st_size == 48 * 30 * 2
    assert meta["width"] == 48 and meta["height"] == 30
    assert meta["encoding"]["rowOrder"] == "north-to-south"
    read, read_meta = read_heightmap(tmp_path, "demo")
    assert read_meta == json.loads((tmp_path / "demo.json").read_text())
    assert np.abs(read - elevation).max() <= SCALE_M / 2 + 1e-3
    assert meta["minElevation"] == pytest.approx(float(read.min()), abs=0.05)


def test_synthetic_terrain_is_deterministic_and_plausible() -> None:
    first = synthetic_terrain(64, 40, seed=3)
    second = synthetic_terrain(64, 40, seed=3)
    other = synthetic_terrain(64, 40, seed=4)
    assert np.array_equal(first, second)
    assert not np.array_equal(first, other)
    assert 1390 <= first.min() < first.max() <= 3410


def test_tiles_are_decoded_cached_and_stitched_in_place(tmp_path: Path) -> None:
    tiles = tile_range(Bounds(-111.70, 40.58, -111.60, 40.62), 12)
    assert len(tiles.tiles()) > 1
    requested: list[str] = []

    def fake(url: str) -> bytes:
        requested.append(url)
        x = int(url.split("/")[-2])
        y = int(url.split("/")[-1].removesuffix(".png"))
        return encode_terrarium(np.full((TILE_SIZE, TILE_SIZE), 1000.0 + x + y / 4.0))

    mosaic = build_mosaic(tiles, tmp_path, fake)
    assert mosaic.elevation.shape == (tiles.rows * TILE_SIZE, tiles.columns * TILE_SIZE)
    assert len(requested) == len(tiles.tiles())
    for x, y in tiles.tiles():
        row = (y - tiles.y_min) * TILE_SIZE
        col = (x - tiles.x_min) * TILE_SIZE
        assert mosaic.elevation[row, col] == pytest.approx(1000.0 + x + y / 4.0, abs=0.01)

    # A second build is served entirely from the cache.
    def offline(url: str) -> bytes:
        raise AssertionError(f"unexpected download: {url}")

    again = build_mosaic(tiles, tmp_path, offline)
    assert np.array_equal(again.elevation, mosaic.elevation)


def test_a_bad_download_is_rejected_and_never_cached(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        load_tile(12, 1, 2, tmp_path, lambda url: b"<html>not a tile</html>")
    assert not (tmp_path / "12" / "1" / "2.png").exists()
    with pytest.raises(ValueError):
        decode_tile(encode_terrarium(np.zeros((8, 8))))


def test_only_https_is_fetched() -> None:
    with pytest.raises(ValueError):
        http_get("http://example.com/tile.png")


def test_the_committed_heightmap_matches_its_metadata() -> None:
    elevation, meta = read_heightmap(PUBLIC_DATA, "wasatch")
    assert elevation.shape == (meta["height"], meta["width"]) == (HEIGHT, WIDTH)
    assert (PUBLIC_DATA / "wasatch.u16").stat().st_size == WIDTH * HEIGHT * 2
    assert meta["minElevation"] == pytest.approx(float(elevation.min()), abs=0.05)
    assert meta["maxElevation"] == pytest.approx(float(elevation.max()), abs=0.05)
    cell_x, cell_y = cell_size_m(WASATCH, WIDTH, HEIGHT)
    assert meta["cellX"] == pytest.approx(cell_x, abs=1e-3)
    assert meta["cellY"] == pytest.approx(cell_y, abs=1e-3)
    assert meta["bounds"] == {"west": -111.83, "south": 40.52, "east": -111.45, "north": 40.70}
    assert isinstance(meta["synthetic"], bool)
    assert meta["source"]["attribution"]
    if not meta["synthetic"]:
        # Real Wasatch terrain: valley benches near 1,400 m, summits near 3,450 m.
        assert 1300 < meta["minElevation"] < 1700
        assert 3350 < meta["maxElevation"] < 3520
