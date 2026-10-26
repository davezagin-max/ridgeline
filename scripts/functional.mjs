#!/usr/bin/env node
/**
 * Functional pass against a running production server (default http://localhost:3190).
 *
 *   pnpm build && pnpm exec next start -p 3190    # in one shell
 *   pnpm functional                              # in another
 *
 * Drives headless Chromium through every control in the app and asserts a visible outcome
 * after each action: text, element state, a pixel change on the map, or a route's numbers.
 * Fails on console errors, uncaught page errors, and any phone-width horizontal overflow.
 *
 * No Claude call is made. The live planner states use Playwright route stubs for
 * /api/plan-route and /api/narrate-route, so those requests never reach the server.
 * Set FUNCTIONAL_OUT to a directory to keep screenshots and a JSON summary.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:3190";
const OUT = process.env.FUNCTIONAL_OUT ?? null;
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
/** A made-up key in the right shape. It only ever reaches route stubs, never the server. */
const FAKE_KEY = "sk-ant-local-test-0000000000000000";

const fixtures = {
  plan: JSON.parse(readFileSync("fixtures/plan-route.json", "utf8")),
  narrate: JSON.parse(readFileSync("fixtures/narrate-route.json", "utf8")),
  presets: JSON.parse(readFileSync("fixtures/presets.json", "utf8")),
};
const wasatch = JSON.parse(readFileSync("public/data/wasatch.json", "utf8"));

const results = [];
const problems = [];
let allowFailedLoads = false;

function record(id, name, ok, detail = "") {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} ${name}${detail ? ` :: ${detail}` : ""}`);
}

async function step(id, name, fn) {
  try {
    const detail = await fn();
    record(id, name, true, typeof detail === "string" ? detail : "");
  } catch (error) {
    record(id, name, false, String(error?.message ?? error).split("\n")[0]);
    if (OUT && lastPage) {
      mkdirSync(OUT, { recursive: true });
      await lastPage.screenshot({ path: path.join(OUT, `fail-${id}.png`) }).catch(() => {});
    }
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const num = (s) => Number(String(s).replace(/,/g, "").match(/\d+(\.\d+)?/)[0]);

async function waitFor(fn, desc, timeout = 20000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error.message;
    }
    await sleep(150);
  }
  const tail = typeof last === "string" ? ` (last: ${last.split("\n")[0]})` : "";
  throw new Error(`timed out waiting for ${desc}${tail}`);
}

function watch(page, label) {
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (allowFailedLoads && /Failed to load resource/.test(text)) return;
    problems.push(`${label} console: ${text}`);
  });
  page.on("pageerror", (error) => problems.push(`${label} pageerror: ${error.message}`));
}

const root = (page) => page.locator("[data-terrain]");
const attr = (page, name) => root(page).getAttribute(name);
const canvas3d = (page) => page.locator("[data-terrain-root] canvas");
const frame2d = (page) => page.locator('[role="img"][aria-label^="Shaded relief"]');
const captionLocator = (page) => page.locator("p", { hasText: /(Route|No route|Finding a route) from A / });
const startSelect = (page) => page.getByRole("combobox", { name: "Start", exact: true });
const endSelect = (page) => page.getByRole("combobox", { name: "End", exact: true });
/** Route results arrive from the worker a few ms after a control changes. */
const settle = () => sleep(450);

let lastPage = null;
/** The default route's distance, recorded in F06 and waited for again after the slider sequence. */
let defaultDistance = null;

async function ready(page) {
  await page.waitForSelector('[data-terrain="ready"]', { timeout: 60000 });
  await waitFor(async () => (await attr(page, "data-shaded")) === "true", "terrain shading baked");
}

async function routeState(page, expected) {
  await waitFor(async () => (await attr(page, "data-route")) === expected, `route ${expected}`);
}

async function statText(page, label) {
  const dt = page.locator("dt").filter({ hasText: new RegExp(`^${esc(label)}$`) }).first();
  return norm(await dt.locator("xpath=following-sibling::dd[1]").innerText());
}

async function caption(page) {
  return norm(await captionLocator(page).first().innerText());
}

function minutesOf(text) {
  const h = /(\d+) h/.exec(text);
  const m = /(\d+) min/.exec(text);
  return (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
}

async function choose(page, text) {
  await page
    .locator("label")
    .filter({ hasText: new RegExp(`^\\s*${esc(text)}\\s*$`) })
    .first()
    .click();
}

async function noOverflow(page, label, width) {
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
  assert(scroll <= width, `${label}: scrollWidth ${scroll} exceeds ${width}`);
  return scroll;
}

async function baseHash(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('[role="img"][aria-label^="Shaded relief"] canvas');
    const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let h = 2166136261;
    for (let i = 0; i < data.length; i += 4) {
      h ^= data[i] ^ (data[i + 1] << 8) ^ (data[i + 2] << 16);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  });
}

async function routePixels(page) {
  return page.evaluate(() => {
    const canvas = document.querySelectorAll('[role="img"][aria-label^="Shaded relief"] canvas')[1];
    const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let n = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) n++;
    return n;
  });
}

/** Captures the 3D canvas at its own size, after bringing it fully into view. */
async function snapCanvas(locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  assert(box && box.width > 600 && box.height > 400, `canvas box too small: ${JSON.stringify(box)}`);
  return locator.screenshot();
}

async function shotHash(locator) {
  return createHash("sha1").update(await locator.screenshot()).digest("hex");
}

async function diffFraction(page, a, b) {
  const url = (buf) => `data:image/png;base64,${buf.toString("base64")}`;
  return page.evaluate(
    async ([ua, ub]) => {
      const load = (src) =>
        new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = reject;
          image.src = src;
        });
      const [ia, ib] = await Promise.all([load(ua), load(ub)]);
      const w = Math.min(ia.width, ib.width);
      const h = Math.min(ia.height, ib.height);
      const read = (image) => {
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const x = c.getContext("2d");
        x.drawImage(image, 0, 0, w, h);
        return x.getImageData(0, 0, w, h).data;
      };
      const d1 = read(ia);
      const d2 = read(ib);
      let diff = 0;
      for (let i = 0; i < d1.length; i += 4) {
        if (Math.abs(d1[i] - d2[i]) + Math.abs(d1[i + 1] - d2[i + 1]) + Math.abs(d1[i + 2] - d2[i + 2]) > 40) diff++;
      }
      return diff / (w * h);
    },
    [url(a), url(b)],
  );
}

async function shot(page, name) {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
}

/** Runs one planner preset (demo mode) and returns what the page shows. */
async function runPreset(page, demoId) {
  const preset = fixtures.presets.find((p) => p.body?.demoId === demoId && p.route === "/api/plan-route");
  assert(preset, `no preset ${demoId}`);
  const button = page.getByRole("button", { name: preset.body.request, exact: true });
  await button.click();
  await waitFor(
    () => page.getByText(/(One search|\d+ searches) in \d+ ms\./).count().then((n) => n > 0),
    `preset ${demoId} result`,
    30000,
  );
  return {
    chips: norm(await page.locator("li").filter({ hasText: /^(From|To|Out and back|Climb under|Grade under|About|Shortest|Climb-friendly|Ride|Hike)/ }).allInnerTexts().then((x) => x.join(" | "))),
    figcaption: norm(await page.locator("figcaption").first().innerText().catch(() => "")),
    title: norm(await page.locator("figure p.font-semibold").first().innerText().catch(() => "")),
    checks: await page.locator("li").filter({ hasText: /(Met|Close|Not met|Off target)$/ }).allInnerTexts(),
    pressed: await button.getAttribute("aria-pressed"),
  };
}

// ---------------------------------------------------------------------------

async function main() {
  const probe = await fetch(BASE).catch(() => null);
  if (!probe || !probe.ok) {
    console.error(`No server at ${BASE}. Run pnpm build and pnpm exec next start -p 3190 first.`);
    process.exit(2);
  }

  const browser = await chromium.launch({
    headless: true,
    args: ["--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });

  // ---------- Desktop, WebGL, light theme ----------
  const desktop = await browser.newContext({ viewport: DESKTOP, colorScheme: "light" });
  const page = await desktop.newPage();
  lastPage = page;
  watch(page, "desktop");
  let webgl = false;

  await step("F01", "Heightmap loads, shading baked, default route found", async () => {
    await page.goto(BASE, { waitUntil: "load" });
    await ready(page);
    await routeState(page, "found");
    return `route found, data-view ${await attr(page, "data-view")}`;
  });

  await step("F02", "Header, pitch line and footer attribution match the data", async () => {
    assert(await page.getByRole("heading", { name: "Ridgeline", exact: true }).isVisible(), "no h1 Ridgeline");
    const pitch = page.locator("p", { hasText: "Real elevation data of the Wasatch mountains in 3D" });
    const visiblePitch = await waitFor(async () => {
      for (let i = 0; i < (await pitch.count()); i++) if (await pitch.nth(i).isVisible()) return true;
      return false;
    }, "pitch visible");
    assert(visiblePitch, "pitch not visible");
    const footer = norm(await page.locator("footer").innerText());
    assert(footer.includes(norm(wasatch.source.attribution)), "footer lacks the elevation attribution");
    assert(footer.includes("Built with Claude Code and Claude Opus 5.5"), "footer lacks build credit");
    return "footer carries the Terrain Tiles and 3DEP credit";
  });

  await step("F03", "Persistent disclaimer names the Utah Avalanche Center with a safe link", async () => {
    const note = page.getByRole("note");
    assert(await note.isVisible(), "disclaimer not visible");
    assert(norm(await note.innerText()).includes("Not for backcountry navigation or avalanche decisions."), "disclaimer text");
    const link = note.getByRole("link", { name: "Utah Avalanche Center" });
    assert((await link.getAttribute("href")) === "https://utahavalanchecenter.org", "link href");
    assert((await link.getAttribute("target")) === "_blank", "link target");
    assert((await link.getAttribute("rel"))?.includes("noreferrer"), "link rel");
    return "href, target and rel as expected";
  });

  await step("F04", "3D terrain renders (WebGL) or 2D fallback shows", async () => {
    webgl = await page.evaluate(() => Boolean(document.createElement("canvas").getContext("webgl2")));
    const view = await attr(page, "data-view");
    if (webgl) {
      assert(view === "3d", `expected 3d, got ${view}`);
      await canvas3d(page).first().waitFor({ state: "visible", timeout: 30000 });
      await sleep(800);
      const hash = await shotHash(canvas3d(page).first());
      assert(hash.length > 0, "canvas screenshot failed");
      return "3D (WebGL2 canvas drawn)";
    }
    assert(view === "2d", `expected 2d, got ${view}`);
    return "2D fallback (WebGL2 unavailable)";
  });

  await step("F05", "Route caption names A, B and how to move the view", async () => {
    const text = await caption(page);
    assert(text.includes("A Alta") && text.includes("B Park City Old Town"), `caption was: ${text}`);
    const how = await page.locator("p", { hasText: /Drag to move|Flat map, north up/ }).first().innerText();
    assert(norm(how).length > 0, "no how-to line");
    return text;
  });

  await step("F06", "Route stats: distance, climb, time, descent, steepest, highest, footnote", async () => {
    const distance = await statText(page, "Distance");
    const climb = await statText(page, "Climb");
    const time = await statText(page, "Time, hiking");
    const descent = await statText(page, "Descent");
    const steepest = await statText(page, "Steepest");
    const highest = await statText(page, "Highest");
    assert(/mi$/.test(distance) && num(distance) > 5, `distance ${distance}`);
    defaultDistance = distance;
    assert(/ft$/.test(climb) && num(climb) > 0, `climb ${climb}`);
    assert(minutesOf(time) > 60, `time ${time}`);
    assert(/ft$/.test(descent) && /ft$/.test(highest) && /%$/.test(steepest), "secondary stats");
    const note = page.getByText(/Best route for these settings, found in \d+ ms after checking/);
    assert((await note.count()) === 1, "search footnote missing");
    return `distance ${distance}, climb ${climb}, ${time}`;
  });

  await step("F07", "Elevation profile heading, readout and axis present", async () => {
    assert(await page.getByRole("heading", { name: /Elevation profile/ }).first().isVisible(), "no profile heading");
    const readout = page.locator("p", { hasText: /^At / }).first();
    assert(/^At [\d.,]+ mi: [\d,]+ ft, [+-]\d+% grade$/.test(norm(await readout.innerText())), "readout shape");
    return norm(await readout.innerText());
  });

  // ---------- Layers, in the 2D view where the pixels can be read ----------
  await step("F08", "2D view switches on; hillshade toggle changes the baked pixels", async () => {
    await choose(page, "2D map");
    await routeState(page, "found");
    await waitFor(async () => (await attr(page, "data-view")) === "2d", "2d view");
    const before = await baseHash(page);
    await page.getByLabel("Hillshade", { exact: true }).uncheck();
    const off = await waitFor(async () => {
      const h = await baseHash(page);
      return h !== before ? h : null;
    }, "hillshade off changes pixels");
    await page.getByLabel("Hillshade", { exact: true }).check();
    await waitFor(async () => (await baseHash(page)) === before, "hillshade back on restores pixels");
    assert(off !== before, "hillshade toggle did not change pixels");
    return "pixels change with hillshade and come back";
  });

  await step("F09", "Slope-angle bands: legend appears, pixels change, caveat shown", async () => {
    const hillshadeOnly = await baseHash(page);
    await page.getByLabel("Slope angle", { exact: true }).check();
    await page.locator('ul[aria-label="Slope angle colours"]').waitFor({ state: "visible" });
    const bands = await page.locator('ul[aria-label="Slope angle colours"] li').count();
    assert(bands >= 4, `only ${bands} band labels`);
    await waitFor(async () => (await baseHash(page)) !== hillshadeOnly, "slope bands change pixels");
    assert(
      await page.getByText("not an avalanche assessment").isVisible(),
      "slope caveat missing",
    );
    return `${bands} band swatches, pixels change`;
  });

  await step("F10", "Contours: lines drawn, select enabled, level count falls as interval rises", async () => {
    const select = page.getByLabel("Contour interval");
    assert(await select.isEnabled(), "interval select disabled while contours on");
    const onPixels = await routePixels(page);
    await page.getByLabel("Contours", { exact: true }).uncheck();
    assert(await select.isDisabled(), "interval select not disabled with contours off");
    await waitFor(async () => (await routePixels(page)) < onPixels, "contour pixels removed");
    await page.getByLabel("Contours", { exact: true }).check();
    const levelsText = () => page.getByText(/\d+ levels, marching squares/).innerText();
    const levels = async (value) => {
      const before = await levelsText();
      await select.selectOption(String(value));
      await sleep(600);
      await waitFor(async () => (await levelsText()) !== before || value === 50, `levels change at ${value} m`);
      return num(await levelsText());
    };
    await select.selectOption("50");
    const l50 = await levels(50);
    const l25 = await levels(25);
    const l100 = await levels(100);
    assert(l25 > l50 && l50 > l100, `levels not falling: ${l25}, ${l50}, ${l100}`);
    return `levels ${l25} at 25 m, ${l50} at 50 m, ${l100} at 100 m`;
  });

  await step("F11", "Place names: 32 labels when on, none when off (2D)", async () => {
    const count = () => frame2d(page).locator("div[data-crowded]").count();
    await waitFor(async () => (await count()) === 32, "32 labels on");
    await page.getByLabel("Place names", { exact: true }).uncheck();
    await waitFor(async () => (await count()) === 0, "labels off");
    await page.getByLabel("Place names", { exact: true }).check();
    return "32 on, 0 off, 32 on again";
  });

  await step("F12", "Units switch between mi/ft and km/m", async () => {
    await choose(page, "km / m");
    await waitFor(async () => /km$/.test(await statText(page, "Distance")), "distance in km");
    const climb = await statText(page, "Climb");
    assert(/ m$/.test(climb), `climb not in metres: ${climb}`);
    await choose(page, "mi / ft");
    await waitFor(async () => /mi$/.test(await statText(page, "Distance")), "distance back in mi");
    return `km and m shown, then mi and ft`;
  });

  // ---------- Route controls ----------
  await step("F13", "Start select lists 32 named places in 3 groups", async () => {
    const options = await startSelect(page).locator("option").count();
    const groups = await startSelect(page).locator("optgroup").count();
    assert(options === 32, `start has ${options} options`);
    assert(groups === 3, `start has ${groups} groups`);
    return `${options} places in ${groups} groups`;
  });

  await step("F14", "Picking on the 2D map: snaps to a landmark, then sets the end", async () => {
    await page.getByRole("button", { name: "Pick two points on the map" }).click();
    await page.getByText("Pick the start (A) on the map.").waitFor({ state: "visible" });
    assert(
      (await page.getByRole("button", { name: /Pick the start on the map/ }).getAttribute("aria-pressed")) === "true",
      "pick button not pressed",
    );
    const snowbird = frame2d(page).locator("div[data-crowded]", { hasText: "Snowbird" }).first();
    const box = await snowbird.boundingBox();
    assert(box, "no Snowbird label on the map");
    await page.mouse.click(box.x + 0.5, box.y + 0.5);
    await page.getByText("Now pick the end (B).").waitFor({ state: "visible" });
    assert((await startSelect(page).inputValue()) === "snowbird", "start did not snap to Snowbird");
    const canyons = frame2d(page).locator("div[data-crowded]", { hasText: "Canyons Village" }).first();
    const box2 = await canyons.boundingBox();
    await page.mouse.click(box2.x + 0.5, box2.y + 0.5);
    await waitFor(async () => (await endSelect(page).inputValue()) === "canyons-village", "end snapped");
    await routeState(page, "found");
    assert(
      (await page.getByText("Now pick the end (B).").count()) === 0,
      "pick mode still active after the end point",
    );
    assert((await caption(page)).includes("A Snowbird to B Canyons Village"), `caption ${await caption(page)}`);
    return "Snowbird and Canyons Village snapped and routed";
  });

  await step("F15", "Cancel on the pick hint clears pick mode", async () => {
    await page.getByRole("button", { name: "Pick two points on the map" }).click();
    await page.getByText("Pick the start (A) on the map.").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await waitFor(async () => (await page.getByText("Pick the start (A) on the map.").count()) === 0, "hint gone");
    return "hint removed";
  });

  await step("F16", "Restore default ends with the two selects", async () => {
    await startSelect(page).selectOption("alta");
    await endSelect(page).selectOption("park-city");
    await waitFor(async () => (await caption(page)).includes("A Alta to B Park City Old Town"), "default caption");
    await settle();
    await routeState(page, "found");
    return "Alta to Park City Old Town";
  });

  await step("F17", "Swap ends reverses the selects and the caption", async () => {
    await page.getByRole("button", { name: "Swap start and end" }).click();
    await waitFor(async () => (await startSelect(page).inputValue()) === "park-city", "swapped start");
    assert((await endSelect(page).inputValue()) === "alta", "swapped end");
    await waitFor(async () => (await caption(page)).includes("A Park City Old Town to B Alta"), "swapped caption");
    await page.getByRole("button", { name: "Swap start and end" }).click();
    await waitFor(async () => (await startSelect(page).inputValue()) === "alta", "swapped back");
    await settle();
    return "swapped twice, back to Alta to Park City Old Town";
  });

  await step("F18", "Climb-friendly climbs no more than Shortest; Shortest is no longer", async () => {
    await routeState(page, "found");
    const cfClimb = num(await statText(page, "Climb"));
    const cfDistance = num(await statText(page, "Distance"));
    assert(
      norm(await page.locator("p", { hasText: /Counts each foot climbed/ }).innerText()).includes("30 ft of extra distance"),
      "climb-friendly hint",
    );
    await choose(page, "Shortest");
    await waitFor(
      async () => norm(await page.locator("p").filter({ hasText: /most direct line/ }).innerText()).length > 0,
      "shortest hint",
    );
    await settle();
    const sClimb = num(await statText(page, "Climb"));
    const sDistance = num(await statText(page, "Distance"));
    assert(cfClimb <= sClimb, `climb-friendly climbed ${cfClimb} ft, shortest ${sClimb} ft`);
    assert(sDistance <= cfDistance, `shortest ${sDistance} mi longer than ${cfDistance} mi`);
    await choose(page, "Climb-friendly");
    await settle();
    await waitFor(async () => num(await statText(page, "Climb")) === cfClimb, "back to climb-friendly");
    return `climb-friendly ${cfClimb} ft and ${cfDistance} mi; shortest ${sClimb} ft and ${sDistance} mi`;
  });

  await step("F19", "Route options open; out and back adds a return leg", async () => {
    const summary = page.locator("summary").filter({ hasText: "Route options" });
    await summary.click();
    assert((await page.locator("details").first().getAttribute("open")) !== null, "details not open");
    const oneWay = num(await statText(page, "Distance"));
    await page.getByLabel("Out and back", { exact: true }).check();
    await waitFor(async () => (await caption(page)).includes("and back"), "caption says and back");
    await routeState(page, "found");
    await waitFor(async () => num(await statText(page, "Distance")) !== oneWay, "distance changes for out and back");
    const loop = num(await statText(page, "Distance"));
    await page.getByLabel("Out and back", { exact: true }).uncheck();
    await waitFor(async () => !(await caption(page)).includes("and back"), "back to one way");
    await settle();
    return `one way ${oneWay} mi, out and back ${loop} mi`;
  });

  await step("F20", "Hike and Ride pace change the time and its label", async () => {
    const hikeMinutes = minutesOf(await statText(page, "Time, hiking"));
    await choose(page, "Ride");
    await waitFor(async () => (await page.locator("dt", { hasText: "Time, riding" }).count()) === 1, "riding label");
    await settle();
    const rideMinutes = minutesOf(await statText(page, "Time, riding"));
    assert(rideMinutes < hikeMinutes, `ride ${rideMinutes} min not faster than hike ${hikeMinutes} min`);
    await choose(page, "Hike");
    await waitFor(async () => (await page.locator("dt", { hasText: "Time, hiking" }).count()) === 1, "hiking label");
    await settle();
    return `hike ${hikeMinutes} min, ride ${rideMinutes} min`;
  });

  await step("F21", "Steepest grade slider: 8 percent respects the wall; 45 percent finds a route", async () => {
    const slider = page.getByLabel("Steepest grade allowed");
    await slider.focus();
    await page.keyboard.press("Home");
    await waitFor(async () => (await page.locator("output").filter({ hasText: /^8%$/ }).count()) === 1, "output 8%");
    await settle();
    const outcome = await waitFor(async () => {
      const state = await attr(page, "data-route");
      return state === "found" || state === "none" ? state : null;
    }, "route result at 8%");
    if (outcome === "found") {
      const steepest = num(await statText(page, "Steepest"));
      assert(steepest <= 8, `steepest ${steepest}% exceeds the 8% limit`);
    } else {
      await page.getByText("No route under a 8% grade.").waitFor({ state: "visible" });
      assert((await caption(page)).startsWith("No route from"), "caption should say No route");
    }
    await page.keyboard.press("End");
    await waitFor(async () => (await page.locator("output").filter({ hasText: /^45%$/ }).count()) === 1, "output 45%");
    await settle();
    await routeState(page, "found");
    for (let i = 0; i < 15; i++) await page.keyboard.press("ArrowLeft");
    await waitFor(async () => (await page.locator("output").filter({ hasText: /^30%$/ }).count()) === 1, "output 30%");
    // The router answers each move in turn and the latest answer wins, so wait for the 30 percent route to land.
    await waitFor(async () => (await statText(page, "Distance")) === defaultDistance, `route back to ${defaultDistance}`, 30000);
    await routeState(page, "found");
    return `at 8% the route is ${outcome}; at 45% found; back to 30%`;
  });

  await step("F22", "Profile scrubber: keys and pointer move the readout along the route", async () => {
    const readout = page.locator("p", { hasText: /^At / }).first();
    const scrub = page.locator('input[aria-label="Position along the route"]');
    const total = num(await page.locator("span.font-mono", { hasText: /mi$/ }).last().innerText());
    await scrub.focus();
    await page.keyboard.press("End");
    await waitFor(async () => num(norm(await readout.innerText()).split(":")[0].replace("At ", "")) >= total * 0.97, "readout at end");
    await page.keyboard.press("Home");
    await waitFor(async () => norm(await readout.innerText()).startsWith("At 0.0 mi"), "readout at start");
    for (let i = 0; i < 250; i++) await page.keyboard.press("ArrowRight");
    const keyText = norm(await readout.innerText());
    const keyDistance = await waitFor(async () => {
      const d = num(norm(await readout.innerText()).replace("At ", ""));
      return d > total * 0.2 && d < total * 0.3 ? d : null;
    }, `readout near 25 percent of ${total} mi (readout was "${keyText}")`);
    const box = await page.locator("div.touch-none").first().boundingBox();
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
    const pointerDistance = await waitFor(async () => {
      const d = num(norm(await readout.innerText()).replace("At ", ""));
      return d > total * 0.45 && d < total * 0.55 ? d : null;
    }, "readout near 50 percent by pointer");
    return `keys to ${keyDistance} mi, pointer to ${pointerDistance} mi of ${total} mi`;
  });

  // ---------- 3D view and camera ----------
  await step("F23", "3D view: exaggeration slider changes the scale", async () => {
    if (!webgl) return "skipped: no WebGL here, the 2D view has no exaggeration slider";
    await choose(page, "3D");
    await waitFor(async () => (await attr(page, "data-view")) === "3d", "3d view");
    await canvas3d(page).first().waitFor({ state: "visible", timeout: 30000 });
    const slider = page.getByLabel("Vertical exaggeration");
    await slider.focus();
    await page.keyboard.press("End");
    await waitFor(async () => (await page.locator("output").filter({ hasText: /^2\.5x$/ }).count()) === 1, "2.5x");
    await page.keyboard.press("Home");
    await waitFor(async () => (await page.locator("output").filter({ hasText: /^1\.0x$/ }).count()) === 1, "1.0x");
    for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowRight");
    await waitFor(async () => (await page.locator("output").filter({ hasText: /^1\.6x$/ }).count()) === 1, "1.6x");
    return "2.5x, 1.0x and back to 1.6x";
  });

  await step("F24", "Camera buttons: zoom in, zoom out, rotate, and reset return to the start view", async () => {
    if (!webgl) return "skipped: no WebGL";
    const canvas = canvas3d(page).first();
    const start = await snapCanvas(canvas);
    await page.getByRole("button", { name: "Zoom in" }).click();
    await sleep(700);
    const zoomed = await snapCanvas(canvas);
    assert(createHash("sha1").update(zoomed).digest("hex") !== createHash("sha1").update(start).digest("hex"), "zoom in did not change the view");
    await page.getByRole("button", { name: "Zoom out" }).click();
    await page.getByRole("button", { name: "Zoom out" }).click();
    await sleep(700);
    const out = await snapCanvas(canvas);
    assert(await diffFraction(page, out, start) > 0.001 || await diffFraction(page, out, zoomed) > 0.001, "zoom out did not change the view");
    await page.getByRole("button", { name: "Rotate left" }).click();
    await sleep(700);
    const rotated = await snapCanvas(canvas);
    assert((await diffFraction(page, rotated, start)) > 0.01, "rotate left did not change the view");
    await page.getByRole("button", { name: "Rotate right" }).click();
    await page.getByRole("button", { name: "Rotate right" }).click();
    await sleep(700);
    await page.getByRole("button", { name: "Reset view" }).click();
    await sleep(900);
    const reset = await snapCanvas(canvas);
    if (OUT) {
      mkdirSync(OUT, { recursive: true });
      writeFileSync(path.join(OUT, "f24-start.png"), start);
      writeFileSync(path.join(OUT, "f24-reset.png"), reset);
    }
    const drift = await diffFraction(page, reset, start);
    assert(drift < 0.02, `reset differs from the start view by ${(drift * 100).toFixed(2)} percent of pixels`);
    return `zoom, rotate changed the view; reset matches start within ${(drift * 100).toFixed(2)}%`;
  });

  await step("F25", "Mouse wheel zooms and drag turns the 3D view", async () => {
    if (!webgl) return "skipped: no WebGL";
    const canvas = canvas3d(page).first();
    const box = await canvas.boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const before = await canvas.screenshot();
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -400);
    await sleep(800);
    const wheel = await canvas.screenshot();
    assert((await diffFraction(page, wheel, before)) > 0.005, "wheel did not change the view");
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 140, cy + 50, { steps: 12 });
    await page.mouse.up();
    await sleep(800);
    const dragged = await canvas.screenshot();
    assert((await diffFraction(page, dragged, wheel)) > 0.005, "drag did not change the view");
    await page.getByRole("button", { name: "Reset view" }).click();
    await sleep(600);
    return "wheel zoom and drag both change the picture";
  });

  await step("F26", "3D place names: 32 overlay labels when on, none when off", async () => {
    if (!webgl) return "skipped: no WebGL";
    const count = () => page.locator('[data-overlay] > div[data-key^="landmark:"]').count();
    assert((await count()) === 32, `expected 32 labels, saw ${await count()}`);
    await page.getByLabel("Place names", { exact: true }).uncheck();
    await waitFor(async () => (await count()) === 0, "3D labels off");
    await page.getByLabel("Place names", { exact: true }).check();
    await waitFor(async () => (await count()) === 32, "3D labels back");
    return "32, 0, 32";
  });

  await step("F27", "3D route marker follows the profile scrubber", async () => {
    if (!webgl) return "skipped: no WebGL";
    const marker = page.locator('[data-overlay] > div[data-key="marker"]');
    const scrub = page.locator('input[aria-label="Position along the route"]');
    await scrub.focus();
    await page.keyboard.press("Home");
    for (let i = 0; i < 100; i++) await page.keyboard.press("ArrowRight");
    await sleep(300);
    const first = await marker.getAttribute("style");
    for (let i = 0; i < 400; i++) await page.keyboard.press("ArrowRight");
    await sleep(300);
    const second = await marker.getAttribute("style");
    assert(first && second && first !== second, "marker style did not change");
    return "marker moves on the terrain as the scrubber moves";
  });

  await step("F28", "3D pick: first click sets A, second click sets B, pick mode ends", async () => {
    if (!webgl) return "skipped: no WebGL";
    await choose(page, "3D");
    await canvas3d(page).first().waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Pick two points on the map" }).click();
    await page.getByText("Pick the start (A) on the map.").waitFor({ state: "visible" });
    const box = await canvas3d(page).first().boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.getByText("Now pick the end (B).").waitFor({ state: "visible", timeout: 5000 });
    const startValue = await startSelect(page).inputValue();
    await page.mouse.click(box.x + box.width / 2 + 90, box.y + box.height / 2 + 70);
    await waitFor(async () => (await page.getByText("Now pick the end (B).").count()) === 0, "pick ended");
    await waitFor(async () => (await page.getByRole("button", { name: "Pick two points on the map" }).count()) === 1, "pick button reset");
    const endValue = await endSelect(page).inputValue();
    await startSelect(page).selectOption("alta");
    await endSelect(page).selectOption("park-city");
    await routeState(page, "found");
    return `start became ${startValue}, end became ${endValue}; restored defaults`;
  });

  await step("F29", "Dark theme: toggle flips, persists after reload, colours change", async () => {
    const toggle = page.getByRole("button", { name: "Switch to dark theme" });
    const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await toggle.click();
    await waitFor(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === "dark", "dark attr");
    const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert(darkBg !== lightBg, `body background unchanged (${lightBg})`);
    await page.reload({ waitUntil: "load" });
    await ready(page);
    assert((await page.evaluate(() => document.documentElement.dataset.theme)) === "dark", "dark not persisted");
    assert(await page.getByRole("button", { name: "Switch to light theme" }).isVisible(), "toggle label not flipped");
    await shot(page, "desktop-dark");
    return `background ${lightBg} to ${darkBg}, persisted across reload`;
  });

  // ---------- Sample requests (demo mode, dark theme) ----------
  await step("F30", "Sample request: park city loop replays with checks and an uncut narration", async () => {
    const result = await runPreset(page, "park-city-loop");
    assert(result.pressed === "true", "preset not pressed");
    assert(result.chips.includes("From Park City Old Town") && result.chips.includes("Out and back"), `chips ${result.chips}`);
    assert(result.figcaption.startsWith("Sample text (hand-written, not a model run)"), `narration caption: ${result.figcaption}`);
    assert(result.title.length > 0, "no narration title");
    assert(result.checks.length >= 1, "no checks rows");
    await page.getByText("Sample (not a real run):").waitFor({ state: "visible" });
    await routeState(page, "found");
    assert((await caption(page)).includes("and back"), "map caption lacks and back");
    await shot(page, "preset-park-city");
    return `${result.title} | ${result.checks.join(" ; ")}`;
  });

  await step("F31", "Sample request: alta to brighton replays and reroutes the map", async () => {
    const result = await runPreset(page, "alta-to-brighton");
    assert(result.chips.includes("From Alta") && result.chips.includes("To Brighton"), `chips ${result.chips}`);
    assert(result.chips.includes("Grade under 20%"), "grade chip missing");
    assert(result.figcaption.startsWith("Sample text (hand-written, not a model run)"), `narration caption: ${result.figcaption}`);
    await waitFor(async () => (await caption(page)).includes("B Brighton"), "map to Brighton");
    return `${result.title}`;
  });

  await step("F32", "Sample request: big cottonwood capped is shortest and under 4,000 ft", async () => {
    const result = await runPreset(page, "big-cottonwood-capped");
    assert(result.chips.includes("Shortest") && result.chips.includes("Climb under 4,000 ft"), `chips ${result.chips}`);
    assert(result.figcaption.startsWith("Sample text (hand-written, not a model run)"), `narration caption: ${result.figcaption}`);
    assert(result.checks.some((c) => /met$/i.test(c)), `no met check: ${result.checks.join(" ; ")}`);
    return result.checks.join(" ; ");
  });

  await step("F33", "A manual change clears the sample write-up", async () => {
    await page.getByRole("button", { name: "Swap start and end" }).click();
    await waitFor(async () => (await page.locator("figure").count()) === 0, "write-up cleared");
    await page.getByRole("button", { name: "Swap start and end" }).click();
    return "write-up removed on the first manual change";
  });

  await step("F34", "AI box without a key explains itself and opens the key dialog", async () => {
    const input = page.getByPlaceholder("Needs your Anthropic key");
    assert(await input.isDisabled(), "request box should be disabled without a key");
    assert(await page.getByRole("button", { name: "Plan", exact: true }).isDisabled(), "Plan should be disabled");
    assert(await page.getByText("The three requests above work without a key.").isVisible(), "explanation missing");
    await page.locator("aside").getByRole("button", { name: "Add key", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ state: "visible" });
    assert(await dialog.getByRole("heading", { name: "Add your Anthropic key" }).isVisible(), "dialog heading");
    return "disabled box, explanation, dialog opens";
  });

  await step("F35", "Key dialog rejects a malformed key and closes on Escape", async () => {
    const dialog = page.getByRole("dialog");
    await dialog.locator('input[name="key"]').fill("not-a-key");
    await dialog.getByRole("button", { name: "Use this key" }).click();
    await dialog.getByRole("alert").waitFor({ state: "visible" });
    assert(
      norm(await dialog.getByRole("alert").innerText()).startsWith("Anthropic keys start with sk-ant-"),
      "format error text",
    );
    await page.keyboard.press("Escape");
    await waitFor(async () => !(await page.evaluate(() => document.querySelector("dialog")?.open)), "dialog closed");
    assert(await page.getByPlaceholder("Needs your Anthropic key").isDisabled(), "still no key");
    return "format error shown, Escape closes, still no key";
  });

  await step("F36", "Demo banner Add key opens the dialog and Cancel closes it", async () => {
    await page.getByRole("status").getByRole("button", { name: "Add key", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ state: "visible" });
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await waitFor(async () => !(await page.evaluate(() => document.querySelector("dialog")?.open)), "closed by cancel");
    return "opens and cancels";
  });

  await step("F37", "Landmark groups and place names are the 32 from the data", async () => {
    const labels = await startSelect(page).locator("optgroup").evaluateAll((list) => list.map((g) => g.label));
    assert(JSON.stringify(labels) === JSON.stringify(["Resorts and town", "Passes, trailheads, lakes", "Peaks"]), `groups ${labels}`);
    return labels.join(" | ");
  });

  await step("F38", "Keyboard: skip link moves focus to the main content", async () => {
    await page.goto(BASE, { waitUntil: "load" });
    await ready(page);
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => document.activeElement?.textContent?.trim());
    assert(focused === "Skip to content", `first Tab focused: ${focused}`);
    await page.keyboard.press("Enter");
    await waitFor(async () => (await page.evaluate(() => location.hash)) === "#main", "hash #main");
    return "Tab then Enter moves to #main";
  });

  await step("F39", "Keyboard: arrow keys move between the routing mode radios", async () => {
    await page.getByRole("radio", { name: "Climb-friendly" }).focus();
    await page.keyboard.press("ArrowRight");
    await waitFor(async () => (await page.getByRole("radio", { name: "Shortest" }).isChecked()), "shortest via arrow");
    await page.keyboard.press("ArrowLeft");
    await waitFor(async () => (await page.getByRole("radio", { name: "Climb-friendly" }).isChecked()), "back via arrow");
    return "ArrowRight and ArrowLeft switch the mode";
  });

  await step("F40", "Desktop console is clean across the whole pass", async () => {
    const mine = problems.filter((p) => p.startsWith("desktop"));
    assert(mine.length === 0, mine.slice(0, 3).join(" || "));
    return "no console or page errors";
  });

  await desktop.close();

  // ---------- No WebGL: the 2D fallback ----------
  const nowebgl = await browser.newContext({ viewport: DESKTOP, colorScheme: "light" });
  await nowebgl.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function getContext(type, ...rest) {
      if (type === "webgl2" || type === "webgl" || type === "experimental-webgl") return null;
      return original.call(this, type, ...rest);
    };
  });
  const flat = await nowebgl.newPage();
  lastPage = flat;
  watch(flat, "nowebgl");

  await step("F41", "No WebGL: 2D map is the only view, with the note, route and picking", async () => {
    await flat.goto(BASE, { waitUntil: "load" });
    await ready(flat);
    await routeState(flat, "found");
    assert((await attr(flat, "data-view")) === "2d", "view should be 2d");
    assert(await flat.getByText("This browser has no WebGL").isVisible(), "no-WebGL note missing");
    assert((await flat.getByRole("radio", { name: "3D", exact: true }).count()) === 0, "3D option offered");
    assert((await flat.locator("[data-terrain-root]").count()) === 0, "3D root rendered");
    const pixels = await routePixels(flat);
    assert(pixels > 1000, `route pixels ${pixels}`);
    const before = await baseHash(flat);
    await flat.getByLabel("Slope angle", { exact: true }).check();
    await waitFor(async () => (await baseHash(flat)) !== before, "slope on 2D");
    await flat.getByLabel("Slope angle", { exact: true }).uncheck();
    await flat.getByRole("button", { name: "Pick two points on the map" }).click();
    await flat.getByText("Pick the start (A) on the map.").waitFor({ state: "visible" });
    const box = await frame2d(flat).boundingBox();
    await flat.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.5);
    await flat.getByText("Now pick the end (B).").waitFor({ state: "visible" });
    await flat.getByRole("button", { name: "Cancel", exact: true }).click();
    await shot(flat, "no-webgl-2d");
    return `2D only, ${pixels} route pixels, slope bands and picking work`;
  });

  await step("F42", "No WebGL console is clean", async () => {
    const mine = problems.filter((p) => p.startsWith("nowebgl"));
    assert(mine.length === 0, mine.slice(0, 3).join(" || "));
    return "no console or page errors";
  });
  await nowebgl.close();

  // ---------- Phone, 390 px, touch ----------
  const phone = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true, colorScheme: "light" });
  const mobile = await phone.newPage();
  lastPage = mobile;
  watch(mobile, "phone");

  const phoneNoScroll = async (label) => noOverflow(mobile, label, PHONE.width);

  await step("F43", "Phone: loads, no horizontal scroll, pick button in the first screen", async () => {
    await mobile.goto(BASE, { waitUntil: "load" });
    await ready(mobile);
    await routeState(mobile, "found");
    await phoneNoScroll("load");
    const box = await mobile.getByRole("button", { name: "Pick two points on the map" }).boundingBox();
    assert(box && box.y + box.height <= PHONE.height, `pick button below the fold (${box?.y})`);
    assert(await mobile.getByRole("note").getByText("Check the").isVisible(), "short disclaimer missing");
    assert(await mobile.getByText("two fingers to zoom").first().isVisible(), "touch caption missing");
    await shot(mobile, "phone-first");
    return "pick button at y " + Math.round(box.y);
  });

  await step("F44", "Phone: profile follows the route panel; scrubber moves on a drag", async () => {
    const heading = await mobile.getByRole("heading", { name: /Elevation profile/ }).first().boundingBox();
    const panel = await mobile.getByRole("heading", { name: "Plan a route" }).boundingBox();
    assert(heading && panel && heading.y > panel.y, "profile should come after the route panel");
    const readout = mobile.locator("p", { hasText: /^At / }).first();
    const before = norm(await readout.innerText());
    await mobile.locator("div.touch-none").first().scrollIntoViewIfNeeded();
    const chart = await mobile.locator("div.touch-none").first().boundingBox();
    await mobile.mouse.move(chart.x + chart.width * 0.1, chart.y + chart.height / 2);
    await mobile.mouse.down();
    await mobile.mouse.move(chart.x + chart.width * 0.8, chart.y + chart.height / 2, { steps: 10 });
    await mobile.mouse.up();
    await waitFor(async () => norm(await readout.innerText()) !== before, "readout changed by drag");
    await phoneNoScroll("profile drag");
    return `readout moved from ${before}`;
  });

  await step("F45", "Phone: every control keeps the page inside 390 px", async () => {
    await choose(mobile, "Shortest");
    await phoneNoScroll("mode shortest");
    await choose(mobile, "Climb-friendly");
    await mobile.getByLabel("Slope angle", { exact: true }).check();
    await phoneNoScroll("slope on");
    await mobile.getByLabel("Slope angle", { exact: true }).uncheck();
    await mobile.locator("summary").filter({ hasText: "Route options" }).click();
    await phoneNoScroll("route options open");
    await choose(mobile, "2D map");
    await waitFor(async () => (await attr(mobile, "data-view")) === "2d", "phone 2d");
    await phoneNoScroll("2d view");
    if (webgl) {
      await choose(mobile, "3D");
      await waitFor(async () => (await attr(mobile, "data-view")) === "3d", "phone 3d");
      await canvas3d(mobile).first().waitFor({ state: "visible", timeout: 30000 });
      await phoneNoScroll("3d view");
    }
    await choose(mobile, "km / m");
    await phoneNoScroll("units");
    await choose(mobile, "mi / ft");
    return "modes, layers, options, views and units all fit";
  });

  await step("F46", "Phone: a sample request replays and the page still fits", async () => {
    const button = mobile.getByRole("button", { name: fixtures.presets.find((p) => p.body?.demoId === "alta-to-brighton").body.request, exact: true });
    await button.scrollIntoViewIfNeeded();
    const result = await runPreset(mobile, "alta-to-brighton");
    assert(result.figcaption.startsWith("Sample text (hand-written, not a model run)"), `caption ${result.figcaption}`);
    await phoneNoScroll("sample request");
    await shot(mobile, "phone-sample");
    return "replayed and fits";
  });

  await step("F47", "Phone: dark theme fits and the camera buttons are reachable", async () => {
    await mobile.getByRole("button", { name: "Switch to dark theme" }).click();
    await waitFor(async () => (await mobile.evaluate(() => document.documentElement.dataset.theme)) === "dark", "phone dark");
    await phoneNoScroll("dark");
    if (webgl) {
      assert(await mobile.getByRole("button", { name: "Zoom in" }).isVisible(), "zoom button hidden");
      await shot(mobile, "phone-dark");
    }
    return "dark theme fits";
  });

  await step("F48", "Phone console is clean across the pass", async () => {
    const mine = problems.filter((p) => p.startsWith("phone"));
    assert(mine.length === 0, mine.slice(0, 3).join(" || "));
    return "no console or page errors";
  });
  await phone.close();

  // ---------- Live planner states, with the API routes stubbed (no Claude call) ----------
  // The stubbed 401, 422, 429 and 500 replies are deliberate, so their browser log lines are expected.
  allowFailedLoads = true;
  const live = await browser.newContext({ viewport: DESKTOP, colorScheme: "light" });
  const liveTab = await live.newPage();
  lastPage = liveTab;
  watch(liveTab, "live");
  const calls = { plan: [], narrate: [] };
  const mode = { plan: "ok", narrate: "ok" };
  const meta = (model, cost) => ({
    mode: "live",
    placeholder: false,
    recordedAt: null,
    model,
    usage: { input_tokens: 812, output_tokens: 96, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    costUsd: cost,
  });
  const reply = (route, status, body) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

  await live.route("**/api/plan-route", async (route) => {
    const request = route.request();
    calls.plan.push({ key: request.headers()["x-anthropic-key"] ?? null, body: request.postDataJSON() });
    const planMode = mode.plan;
    if (planMode === "refusal")
      return reply(route, 422, { ok: false, error: { kind: "refusal", message: "Claude declined this request. Try rephrasing it." }, meta: meta("claude-opus-5-5", 0.0009) });
    if (planMode === "auth") return reply(route, 401, { ok: false, error: { kind: "auth", message: "Invalid API key." } });
    if (planMode === "rate") return reply(route, 429, { ok: false, error: { kind: "rate_limit", message: "Too many requests. Wait a moment and try again." } });
    if (planMode === "delay") {
      await sleep(4000);
      try {
        return reply(route, 200, { ok: true, data: fixtures.plan["alta-to-brighton"].data, meta: meta("claude-opus-5-5", 0.0061) });
      } catch {
        return undefined;
      }
    }
    return reply(route, 200, { ok: true, data: fixtures.plan["alta-to-brighton"].data, meta: meta("claude-opus-5-5", 0.0061) });
  });
  await live.route("**/api/narrate-route", async (route) => {
    const request = route.request();
    calls.narrate.push({ key: request.headers()["x-anthropic-key"] ?? null, body: request.postDataJSON() });
    if (mode.narrate === "fail") return reply(route, 500, { ok: false, error: { kind: "server", message: "Upstream error from Claude." } });
    if (mode.narrate === "invented")
      return reply(route, 200, { ok: true, data: { title: "Alta to Brighton", narration: "A 12.5 mi hike with 3,000 ft of climbing.", source: "model" }, meta: meta("claude-opus-5-5", 0.0042) });
    return reply(route, 200, { ok: true, data: fixtures.narrate["alta-to-brighton"].data, meta: meta("claude-opus-5-5", 0.0042) });
  });

  await step("L01", "Add key: the key goes to the API route header, and the live banner shows", async () => {
    await liveTab.goto(BASE, { waitUntil: "load" });
    await ready(liveTab);
    await liveTab.getByRole("status").getByRole("button", { name: "Add key", exact: true }).click();
    const dialog = liveTab.getByRole("dialog");
    await dialog.locator('input[name="key"]').fill(FAKE_KEY);
    await dialog.getByRole("button", { name: "Use this key" }).click();
    await waitFor(async () => (await liveTab.getByText("Live — calling Claude Opus 5.5 with your key.").count()) === 1, "live banner");
    const input = liveTab.getByPlaceholder("Easy hike from Brighton, about 90 minutes");
    assert(await input.isEnabled(), "request box should be enabled with a key");
    return "live banner shown, request box enabled";
  });

  await step("L02", "Live planner: constraints, route, check rows, narration and cost", async () => {
    await liveTab.getByPlaceholder("Easy hike from Brighton, about 90 minutes").fill("Hike from Alta to Brighton, easy");
    await liveTab.getByRole("button", { name: "Plan", exact: true }).click();
    await waitFor(async () => (await liveTab.locator("figure").count()) === 1, "narration shown", 30000);
    const figcaption = norm(await liveTab.locator("figcaption").first().innerText());
    assert(figcaption === "Written by Claude Opus 5.5 from the router's numbers", `narration caption: ${figcaption}`);
    const constraints = norm(await liveTab.locator("p", { hasText: "How Claude Opus 5.5 read the request" }).first().innerText());
    assert(constraints.includes("How Claude Opus 5.5 read the request"), "constraints caption");
    assert(await liveTab.getByText("This run:").isVisible(), "cost meter missing");
    await waitFor(async () => (await liveTab.evaluate(() => document.querySelectorAll("li").length)) > 0, "list");
    assert(calls.plan.length === 1 && calls.narrate.length === 1, `calls plan ${calls.plan.length}, narrate ${calls.narrate.length}`);
    assert(calls.plan[0].key === FAKE_KEY, "plan request lacked the key header");
    assert(calls.narrate[0].key === FAKE_KEY, "narrate request lacked the key header");
    assert(String(calls.narrate[0].body.facts.distance).endsWith(" mi"), "facts not sent");
    await routeState(liveTab, "found");
    await shot(liveTab, "live-done");
    return `narration trusted; two calls, key header sent; facts distance ${calls.narrate[0].body.facts.distance}`;
  });

  await step("L03", "Live refusal (422) shows the refusal title and message", async () => {
    mode.plan = "refusal";
    await liveTab.getByPlaceholder("Easy hike from Brighton, about 90 minutes").fill("Something else entirely");
    await liveTab.getByRole("button", { name: "Plan", exact: true }).click();
    try {
      await liveTab.getByText("Claude declined this request", { exact: true }).waitFor({ state: "visible" });
      assert(await liveTab.getByText("Claude declined this request. Try rephrasing it.").isVisible(), "refusal message");
      return "refusal title and message shown";
    } finally {
      mode.plan = "ok";
    }
  });

  await step("L04", "Live auth (401) offers Change key, and Change key opens the dialog", async () => {
    mode.plan = "auth";
    try {
      await liveTab.getByPlaceholder("Easy hike from Brighton, about 90 minutes").fill("Hike from Alta to Brighton, easy");
      await liveTab.getByRole("button", { name: "Plan", exact: true }).click();
      await liveTab.getByText("There is a problem with the key").waitFor({ state: "visible" });
      await liveTab.locator("aside").getByRole("button", { name: "Change key", exact: true }).click();
      await liveTab.getByRole("dialog").waitFor({ state: "visible" });
      await liveTab.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
      return "auth title, Change key opens and closes the dialog";
    } finally {
      mode.plan = "ok";
    }
  });

  await step("L05", "Live rate limit (429) shows Too many requests", async () => {
    mode.plan = "rate";
    try {
      await liveTab.getByPlaceholder("Easy hike from Brighton, about 90 minutes").fill("Hike from Alta to Brighton, easy");
      await liveTab.getByRole("button", { name: "Plan", exact: true }).click();
      await liveTab.getByText("Too many requests", { exact: true }).waitFor({ state: "visible" });
      return "rate-limit title shown";
    } finally {
      mode.plan = "ok";
    }
  });

  await step("L06", "A failed write-up keeps the route and says so", async () => {
    mode.narrate = "fail";
    try {
      await liveTab.getByPlaceholder("Easy hike from Brighton, about 90 minutes").fill("Hike from Alta to Brighton, easy");
      await liveTab.getByRole("button", { name: "Plan", exact: true }).click();
      await liveTab.getByText("The route is drawn, but the write-up failed: Upstream error from Claude.").waitFor({ state: "visible" });
      await routeState(liveTab, "found");
      return "route kept, failure stated";
    } finally {
      mode.narrate = "ok";
    }
  });

  await step("L07", "An untrusted write-up is replaced by the code summary", async () => {
    mode.narrate = "invented";
    try {
      await liveTab.getByPlaceholder("Easy hike from Brighton, about 90 minutes").fill("Hike from Alta to Brighton, easy");
      await liveTab.getByRole("button", { name: "Plan", exact: true }).click();
      await waitFor(async () => (await liveTab.locator("figcaption").count()) > 0, "summary shown");
      const caption = norm(await liveTab.locator("figcaption").first().innerText());
      assert(caption === "Summary assembled by code from this route's numbers", `caption: ${caption}`);
      const text = norm(await liveTab.locator("figure p").last().innerText());
      assert(!text.includes("12.5"), "invented figure was shown");
      return "code summary shown, invented 12.5 mi not shown";
    } finally {
      mode.narrate = "ok";
    }
  });

  await step("L08", "Cancel during a live run stops the chain: no write-up call", async () => {
    mode.plan = "delay";
    try {
      const narrateBefore = calls.narrate.length;
      await liveTab.getByPlaceholder("Easy hike from Brighton, about 90 minutes").fill("Hike from Alta to Brighton, easy");
      await liveTab.getByRole("button", { name: "Plan", exact: true }).click();
      await liveTab.getByText("Reading the request").waitFor({ state: "visible" });
      await liveTab.locator("aside").getByRole("button", { name: "Cancel", exact: true }).click();
      await waitFor(async () => (await liveTab.getByText("Reading the request").count()) === 0, "run cleared");
      await sleep(4500);
      assert(calls.narrate.length === narrateBefore, "a write-up call was made after cancel");
      assert((await liveTab.locator("figure").count()) === 0, "a result appeared after cancel");
      return "run cleared, no write-up call after cancel";
    } finally {
      mode.plan = "ok";
    }
  });

  await step("L09", "Change key then Remove key returns to demo mode", async () => {
    await liveTab.getByRole("button", { name: "Change key", exact: true }).first().click();
    const dialog = liveTab.getByRole("dialog");
    await dialog.waitFor({ state: "visible" });
    await dialog.getByRole("button", { name: "Remove key", exact: true }).click();
    await waitFor(async () => (await liveTab.getByPlaceholder("Needs your Anthropic key").count()) === 1, "demo again");
    assert(await liveTab.getByPlaceholder("Needs your Anthropic key").isDisabled(), "still enabled");
    return "back to demo, request box disabled";
  });

  await step("L10", "Live console is clean across the stubbed states", async () => {
    const mine = problems.filter((p) => p.startsWith("live"));
    assert(mine.length === 0, mine.slice(0, 3).join(" || "));
    return "no console or page errors (failed-load logs from the stubbed errors are expected)";
  });
  await live.close();

  // ---------- Heightmap failure ----------
  const broken = await browser.newContext({ viewport: DESKTOP, colorScheme: "light" });
  const brokenTab = await broken.newPage();
  lastPage = brokenTab;
  watch(brokenTab, "broken");
  let heightmapCalls = 0;
  await brokenTab.route("**/data/wasatch.u16", async (route) => {
    heightmapCalls++;
    if (heightmapCalls === 1) return route.fulfill({ status: 500, body: "boom" });
    return route.continue();
  });

  await step("E01", "Heightmap failure shows an alert and Try again recovers", async () => {
    allowFailedLoads = true;
    await brokenTab.goto(BASE, { waitUntil: "load" });
    await brokenTab.getByRole("alert").filter({ hasText: "The heightmap did not load (HTTP 500)." }).waitFor({ state: "visible" });
    assert(await brokenTab.getByRole("button", { name: "Try again" }).isVisible(), "no Try again button");
    await brokenTab.getByRole("button", { name: "Try again" }).click();
    await ready(brokenTab);
    await routeState(brokenTab, "found");
    allowFailedLoads = false;
    return "HTTP 500 message, then Try again loads the map";
  });
  await broken.close();

  await browser.close();

  // ---------- Summary ----------
  const failed = results.filter((r) => !r.ok);
  if (OUT) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(path.join(OUT, "functional.json"), JSON.stringify({ results, problems }, null, 2));
  }
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed, ${problems.length} console or page errors`);
  if (problems.length) console.log(problems.slice(0, 10).join("\n"));
  process.exit(failed.length || problems.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
