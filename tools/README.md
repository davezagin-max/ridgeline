# Ridgeline tools: heightmap preprocessing

One job: turn public elevation tiles into the compact heightmap the web app ships with.

```bash
uv sync
uv run python -m terrain.build              # downloads 15 tiles, writes ../public/data/wasatch.{u16,json}
uv run python -m terrain.build --synthetic  # offline stand-in, labelled synthetic in the metadata
```

Checks: `uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest -q`

## What it does

1. `tiles.py`: Web Mercator tile maths and the Terrarium decoding (`red * 256 + green + blue / 256 - 32768` metres).
2. `fetch.py`: downloads each tile once over HTTPS into `tools/.cache/` (git-ignored), checks that it is a 256 px PNG, and stitches the tiles into a mosaic.
3. `heightmap.py`: bilinear resample onto a 1024 x 640 grid that is regular in longitude and latitude, then packs it as little-endian `uint16` in 0.1 m steps above a whole-metre offset. Row 0 is the north edge.
4. `build.py`: the command line entry point and the bounding box (40.52 to 40.70 N, 111.83 to 111.45 W).

The output is 1,310,720 bytes. Each cell is about 31.36 m east-west by 31.32 m north-south, measured at the middle latitude of the box.

## Data source and terms (read 11 Oct 2026)

- **Source:** [Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Mapzen, built with Tilezen Joerd), served from the `elevation-tiles-prod` bucket in the AWS Open Data programme. Zoom 12, Terrarium encoding, about 29 m per pixel at this latitude.
- **Licence:** the registry entry's licence field points to the project's [attribution page](https://github.com/tilezen/joerd/blob/master/docs/attribution.md). The tiles are a blend of public datasets, each with its own terms, and attribution is required.
- **What applies here:** inside the United States the tiles are built from USGS 3DEP (formerly the National Elevation Dataset). The attribution page describes 3DEP as public domain, usable without restriction, with a request from USGS that credit be given when the data is redistributed or published. It also notes that anyone who modifies USGS data should describe the modifications, which the list above does.
- **Credit used in the app and the README:** "Elevation: Terrain Tiles by Mapzen, hosted by AWS Open Data. United States 3DEP (formerly NED) terrain data courtesy of the U.S. Geological Survey."

The same text is stored in `public/data/wasatch.json` under `source`, next to the access date.
