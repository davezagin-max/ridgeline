import numpy as np
import pytest

from terrain.build import WASATCH
from terrain.tiles import Bounds, decode_terrarium, lonlat_to_pixel, tile_range, tile_url


def test_origin_of_the_world_is_the_middle_pixel() -> None:
    x, y = lonlat_to_pixel(0.0, 0.0, 0)
    assert float(x) == pytest.approx(128.0)
    assert float(y) == pytest.approx(128.0)


def test_pixel_coordinates_double_with_each_zoom_level() -> None:
    x3, y3 = lonlat_to_pixel(-111.6, 40.6, 3)
    x4, y4 = lonlat_to_pixel(-111.6, 40.6, 4)
    assert float(x4) == pytest.approx(2 * float(x3))
    assert float(y4) == pytest.approx(2 * float(y3))


def test_north_is_up_and_east_is_right() -> None:
    x_west, y_south = lonlat_to_pixel(-111.83, 40.52, 12)
    x_east, y_north = lonlat_to_pixel(-111.45, 40.70, 12)
    assert float(x_east) > float(x_west)
    assert float(y_north) < float(y_south)


def test_mercator_limit_maps_to_the_top_edge() -> None:
    _, y = lonlat_to_pixel(0.0, 85.0511287798066, 0)
    assert float(y) == pytest.approx(0.0, abs=1e-6)


def test_tile_range_for_the_wasatch_box() -> None:
    tiles = tile_range(WASATCH, 12)
    assert (tiles.x_min, tiles.x_max) == (775, 779)
    assert (tiles.y_min, tiles.y_max) == (1540, 1542)
    assert tiles.columns * tiles.rows == len(tiles.tiles()) == 15
    assert tiles.tiles()[0] == (775, 1540)


def test_tile_range_of_a_point_sized_box_is_one_tile() -> None:
    tiles = tile_range(Bounds(-111.6001, 40.6, -111.6, 40.6001), 12)
    assert len(tiles.tiles()) == 1


def test_bounds_must_be_ordered() -> None:
    with pytest.raises(ValueError):
        Bounds(west=-111.0, south=40.0, east=-112.0, north=41.0)


def test_terrarium_decoding_matches_the_published_formula() -> None:
    rgb = np.array(
        [[[128, 0, 0], [134, 164, 128]], [[127, 255, 0], [140, 0, 64]]],
        dtype=np.uint8,
    )
    metres = decode_terrarium(rgb)
    assert metres.dtype == np.float32
    assert metres[0, 0] == pytest.approx(0.0)
    assert metres[0, 1] == pytest.approx(1700.5)
    assert metres[1, 0] == pytest.approx(-1.0)
    assert metres[1, 1] == pytest.approx(3072.25)


def test_terrarium_decoding_ignores_an_alpha_channel() -> None:
    rgba = np.array([[[134, 164, 128, 255]]], dtype=np.uint8)
    assert decode_terrarium(rgba)[0, 0] == pytest.approx(1700.5)


def test_terrarium_decoding_rejects_a_flat_array() -> None:
    with pytest.raises(ValueError):
        decode_terrarium(np.zeros((4, 4), dtype=np.uint8))


def test_tile_url_points_at_the_public_bucket() -> None:
    assert (
        tile_url(12, 775, 1540)
        == "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/12/775/1540.png"
    )
