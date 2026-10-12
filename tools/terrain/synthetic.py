"""A made-up mountain range, for when the real elevation source cannot be reached.

It keeps the app and its tests runnable offline. Anything built from it is marked
`"synthetic": true` in the metadata, and the app labels it as not real terrain.
"""

from __future__ import annotations

import numpy as np

from .heightmap import Elevation


def _value_noise(rng: np.random.Generator, width: int, height: int, cells: int) -> np.ndarray:
    """Smooth noise in [0, 1]: random values on a coarse lattice, eased between."""
    lattice = rng.random((cells + 2, cells + 2))
    xs = np.linspace(0, cells, width)
    ys = np.linspace(0, cells, height)
    x0 = np.minimum(xs.astype(np.intp), cells - 1)
    y0 = np.minimum(ys.astype(np.intp), cells - 1)
    tx = xs - x0
    ty = ys - y0
    tx = (tx * tx * (3 - 2 * tx))[np.newaxis, :]
    ty = (ty * ty * (3 - 2 * ty))[:, np.newaxis]
    top = lattice[np.ix_(y0, x0)] * (1 - tx) + lattice[np.ix_(y0, x0 + 1)] * tx
    bottom = lattice[np.ix_(y0 + 1, x0)] * (1 - tx) + lattice[np.ix_(y0 + 1, x0 + 1)] * tx
    result: np.ndarray = top * (1 - ty) + bottom * ty
    return result


def synthetic_terrain(width: int, height: int, seed: int = 7) -> Elevation:
    """Deterministic fractal terrain between roughly 1,400 m and 3,400 m."""
    rng = np.random.default_rng(seed)
    total = np.zeros((height, width))
    amplitude = 1.0
    weight = 0.0
    for octave in range(6):
        total += amplitude * _value_noise(rng, width, height, 3 * 2**octave)
        weight += amplitude
        amplitude *= 0.5
    total /= weight
    # A west-to-east ramp so there is a "valley" side and a "crest", like the real range.
    ramp = np.linspace(0.0, 1.0, width)[np.newaxis, :]
    shaped = 0.7 * total + 0.3 * np.sin(ramp * np.pi * 0.85) ** 1.5
    shaped = (shaped - shaped.min()) / (shaped.max() - shaped.min())
    return (1400.0 + 2000.0 * shaped**1.3).astype(np.float32)
