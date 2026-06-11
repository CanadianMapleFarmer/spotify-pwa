// Procedural Scene: seeded silhouette layers, particle canvas, orchestration.

import { SCENE_CATEGORIES, SCENE_CATEGORY_LABELS, SCENE_FLAVORS, storageKeys } from "../config.js";
import { log } from "../diagnostics.js";
import { elements } from "../dom.js";
import { state } from "../state.js";
import { mulberry32 } from "../utils.js";
import { mixRgb, parseRgbColor, rgbCss } from "./palette.js";

// === Procedural Scene =========================================================
// Scene is a Roku-City-style layered illustration, generated entirely on the
// client — no video, no network, no Firestore. The TV firmware pauses Spotify
// whenever a <video> engages its decoder, so the old clip pipeline (silent MP4s,
// Pexels, image sequences) was removed outright. Structure, back to front:
//   #sceneSky        gradient sky + sun/moon glow (one static paint, palette-tinted)
//   #sceneCanvas     30fps-capped particles: twinkling stars, drifting clouds
//   #sceneLayerFar/Mid  silhouette SVGs with very slow CSS parallax drift
//   #sceneFgCanvas   skyline only: car-light streaks between mid and near layers
//   #sceneLayerNear  closest silhouette (treeline / lit buildings)
//   #sceneMist       nature only: a slow-drifting haze band
// Geometry is seeded (mulberry32) so Skip re-rolls a genuinely different scene;
// palette/track changes re-tint colors in place without rebuilding geometry, so
// the slow parallax never visibly jumps.



function newSceneSeed() {
  return (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
}

// Entry follows the local clock; Skip re-rolls the flavor for variety.
function sceneFlavorFromClock() {
  const hour = new Date().getHours();
  if (hour >= 21 || hour < 5) return "night";
  if (hour < 10) return "dawn";
  return "evening";
}

// Base sky stops per flavor (top → mid → horizon), glow tint, star strength.
const SCENE_FLAVOR_COLORS = {
  dawn: { top: [18, 28, 58], mid: [104, 74, 104], horizon: [222, 138, 92], glow: [255, 214, 170], stars: 0.35 },
  evening: { top: [10, 18, 44], mid: [56, 52, 96], horizon: [204, 104, 72], glow: [255, 190, 130], stars: 0.6 },
  night: { top: [4, 8, 18], mid: [14, 22, 46], horizon: [38, 48, 82], glow: [196, 210, 255], stars: 1 },
};

// Full color set for the current flavor + album palette. Mix weights stay low so
// the scene reads as a dusk illustration that leans toward the record, never neon.
function computeSceneColors() {
  const flavor = SCENE_FLAVOR_COLORS[state.sceneFlavor] || SCENE_FLAVOR_COLORS.evening;
  const palette = state.paletteCache.palette || [];
  const accentA = parseRgbColor(palette[0]) || [30, 215, 96];
  const accentB = parseRgbColor(palette[1] || palette[0]) || [112, 166, 255];
  const baseDark = [7, 11, 20];
  const horizon = mixRgb(flavor.horizon, accentA, 0.3);
  return {
    top: mixRgb(flavor.top, accentB, 0.16),
    mid: mixRgb(flavor.mid, accentA, 0.22),
    horizon,
    glow: mixRgb(flavor.glow, accentA, 0.2),
    starStrength: flavor.stars,
    // Far layers sit in the haze (closest to the horizon color), near is darkest.
    far: mixRgb(baseDark, horizon, 0.38),
    midLayer: mixRgb(baseDark, horizon, 0.18),
    near: mixRgb(baseDark, horizon, 0.06),
  };
}

// --- geometry builders --------------------------------------------------------
// Silhouettes render into a fixed viewBox stretched to the layer box
// (preserveAspectRatio="none") so the paths can think in simple units.
const SCENE_VB_W = 1200;
const SCENE_VB_H = 320;

function svgEl(tag) {
  return document.createElementNS("http://www.w3.org/2000/svg", tag);
}

function buildLayerSvg(container) {
  if (!container) return null;
  container.replaceChildren();
  const svg = svgEl("svg");
  svg.setAttribute("viewBox", `0 0 ${SCENE_VB_W} ${SCENE_VB_H}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  container.appendChild(svg);
  return svg;
}

function appendPath(svg, d) {
  const path = svgEl("path");
  path.setAttribute("d", d);
  svg.appendChild(path);
  return path;
}

// Random-walk mountain ridge across the viewBox; straight segments read fine at
// silhouette scale and keep the path tiny.
function ridgePath(rand, peaks, minY, maxY) {
  let y = minY + rand() * (maxY - minY);
  let d = `M0 ${SCENE_VB_H} L0 ${Math.round(y)}`;
  const step = SCENE_VB_W / peaks;
  for (let i = 1; i <= peaks; i += 1) {
    y += (rand() - 0.5) * (maxY - minY) * 0.9;
    y = Math.max(minY, Math.min(maxY, y));
    d += ` L${Math.round(i * step)} ${Math.round(y)}`;
  }
  d += ` L${SCENE_VB_W} ${SCENE_VB_H} Z`;
  return d;
}

// Jagged pine treeline for the near nature layer: overlapping triangles.
function treelinePath(rand) {
  const baseY = 150 + rand() * 40;
  let d = `M0 ${SCENE_VB_H} L0 ${Math.round(baseY)}`;
  let x = 0;
  while (x < SCENE_VB_W) {
    const w = 16 + rand() * 30;
    const treeH = 36 + rand() * 78;
    const y = baseY + (rand() - 0.5) * 28;
    d += ` L${Math.round(x + w / 2)} ${Math.round(y - treeH)} L${Math.round(x + w)} ${Math.round(y)}`;
    x += w * (0.7 + rand() * 0.4); // overlap trees a little
  }
  d += ` L${SCENE_VB_W} ${SCENE_VB_H} Z`;
  return d;
}

// Skyline silhouette: flat-topped buildings with optional antenna masts (masts
// fill as part of the same path). Returns window/antenna positions so the
// decorator can light them.
function buildSkyline(rand, opts) {
  let d = `M0 ${SCENE_VB_H}`;
  let masts = "";
  const windows = [];
  const antennas = [];
  let x = 0;
  while (x < SCENE_VB_W) {
    const w = opts.minW + rand() * (opts.maxW - opts.minW);
    const x2 = Math.min(SCENE_VB_W, x + w);
    const h = opts.minH + rand() * (opts.maxH - opts.minH);
    const top = Math.round(SCENE_VB_H - h);
    d += ` L${Math.round(x)} ${top} L${Math.round(x2)} ${top}`;
    if (opts.windowChance && windows.length < 420) {
      const cols = Math.floor((x2 - x - 8) / 13);
      const rows = Math.floor((SCENE_VB_H - top - 12) / 17);
      for (let r = 0; r < rows; r += 1) {
        for (let c = 0; c < cols; c += 1) {
          if (rand() < opts.windowChance) {
            windows.push({ x: Math.round(x + 6 + c * 13), y: top + 8 + r * 17 });
          }
        }
      }
    }
    if (opts.antennaChance && h > (opts.minH + opts.maxH) / 2 && rand() < opts.antennaChance) {
      const ax = Math.round(x + (x2 - x) / 2);
      const ah = 16 + Math.round(rand() * 20);
      masts += ` M${ax - 1} ${top} h3 v${-ah} h-3 Z`;
      antennas.push({ x: ax, y: top - ah });
    }
    x = x2 + (rand() < 0.14 ? 6 + rand() * 24 : 0); // occasional alley gap
  }
  d += ` L${SCENE_VB_W} ${SCENE_VB_H} Z${masts}`;
  return { path: d, windows, antennas };
}

// Light a skyline layer: static lit windows batched into two path nodes (warm +
// cool shades), a handful of twinkling windows, and blinking antenna tips. All
// animation is opacity-only CSS keyframes — TV-safe.
function decorateSkyline(svg, build, rand, intensity) {
  const warm = [];
  const cool = [];
  for (const win of build.windows) {
    (rand() < 0.82 ? warm : cool).push(win);
  }
  const size = intensity >= 1 ? { w: 5, h: 7 } : { w: 4, h: 6 };
  appendWindowsPath(svg, warm, size, `rgba(255, 214, 138, ${(0.5 * intensity + 0.18).toFixed(2)})`);
  appendWindowsPath(svg, cool, size, `rgba(170, 206, 255, ${(0.4 * intensity + 0.14).toFixed(2)})`);
  const twinkles = build.windows.filter(() => rand() < 0.04).slice(0, 12);
  for (const win of twinkles) {
    const rect = svgEl("rect");
    rect.setAttribute("x", win.x);
    rect.setAttribute("y", win.y);
    rect.setAttribute("width", size.w);
    rect.setAttribute("height", size.h);
    rect.setAttribute("fill", "rgba(255, 226, 160, 0.9)");
    rect.setAttribute("class", "scene-twinkle");
    rect.style.animationDelay = `${(rand() * 8).toFixed(1)}s`;
    rect.style.animationDuration = `${(6 + rand() * 8).toFixed(1)}s`;
    svg.appendChild(rect);
  }
  for (const ant of build.antennas.slice(0, 4)) {
    const dot = svgEl("circle");
    dot.setAttribute("cx", ant.x);
    dot.setAttribute("cy", ant.y);
    dot.setAttribute("r", 2.4);
    dot.setAttribute("fill", "#ff5a52");
    dot.setAttribute("class", "scene-blink");
    dot.style.animationDelay = `${(rand() * 2.4).toFixed(1)}s`;
    svg.appendChild(dot);
  }
}

function appendWindowsPath(svg, wins, size, fill) {
  if (!wins.length) return;
  let d = "";
  for (const win of wins) d += `M${win.x} ${win.y}h${size.w}v${size.h}h${-size.w}Z`;
  const path = svgEl("path");
  path.setAttribute("d", d);
  path.setAttribute("fill", fill);
  svg.appendChild(path);
}

function buildNatureLayers(rand, tintables) {
  const far = buildLayerSvg(elements.sceneLayerFar);
  const mid = buildLayerSvg(elements.sceneLayerMid);
  const near = buildLayerSvg(elements.sceneLayerNear);
  if (!far || !mid || !near) return;
  tintables.paths.far.push(appendPath(far, ridgePath(rand, 6, 60, 200)));
  tintables.paths.mid.push(appendPath(mid, ridgePath(rand, 9, 120, 250)));
  tintables.paths.near.push(appendPath(near, treelinePath(rand)));
}

function buildSkylineLayers(rand, tintables) {
  const far = buildLayerSvg(elements.sceneLayerFar);
  const mid = buildLayerSvg(elements.sceneLayerMid);
  const near = buildLayerSvg(elements.sceneLayerNear);
  if (!far || !mid || !near) return;
  const farBuild = buildSkyline(rand, { minW: 28, maxW: 60, minH: 60, maxH: 170, windowChance: 0 });
  const midBuild = buildSkyline(rand, { minW: 36, maxW: 80, minH: 90, maxH: 215, windowChance: 0.14, antennaChance: 0.2 });
  const nearBuild = buildSkyline(rand, { minW: 52, maxW: 112, minH: 110, maxH: 280, windowChance: 0.26, antennaChance: 0.45 });
  tintables.paths.far.push(appendPath(far, farBuild.path));
  tintables.paths.mid.push(appendPath(mid, midBuild.path));
  tintables.paths.near.push(appendPath(near, nearBuild.path));
  decorateSkyline(mid, midBuild, rand, 0.55);
  decorateSkyline(near, nearBuild, rand, 1);
}

// Re-tint the live scene from the current flavor + album palette. Touches only
// inline colors (sky background, silhouette fills, mist) — geometry and the CSS
// drift animations are untouched, so nothing jumps on track change.
function applySceneTint() {
  const t = state.sceneTintables;
  const sky = elements.sceneSky;
  if (!t || !sky) return;
  const colors = computeSceneColors();
  sky.style.background =
    `radial-gradient(circle at ${t.glowX}% ${t.glowY}%, ${rgbCss(colors.glow, 0.85)} 0%, ${rgbCss(colors.glow, 0.32)} 4%, ${rgbCss(colors.glow, 0.12)} 16%, rgba(0, 0, 0, 0) 40%), ` +
    `linear-gradient(180deg, ${rgbCss(colors.top)} 0%, ${rgbCss(colors.mid)} 58%, ${rgbCss(colors.horizon)} 100%)`;
  const fills = { far: colors.far, mid: colors.midLayer, near: colors.near };
  for (const depth of ["far", "mid", "near"]) {
    for (const node of t.paths[depth]) node.setAttribute("fill", rgbCss(fills[depth]));
  }
  if (elements.sceneMist) {
    elements.sceneMist.style.background =
      `linear-gradient(180deg, rgba(0, 0, 0, 0), ${rgbCss(colors.horizon, 0.16)} 45%, rgba(0, 0, 0, 0))`;
  }
}

// --- particle canvas ----------------------------------------------------------
// One full-bleed canvas behind the silhouettes (stars + clouds) and, for the
// skyline, a short band canvas between mid and near layers (car streaks). Both
// share a single 30fps-capped rAF loop, mirroring the visualizer's budget.

// Cloud sprites are pre-rendered once per build — the frame loop only ever
// drawImages them, never rebuilds gradients.
function makeCloudSprite(rand) {
  const w = 320;
  const h = 130;
  const sprite = document.createElement("canvas");
  sprite.width = w;
  sprite.height = h;
  const ctx = sprite.getContext("2d");
  if (!ctx) return sprite;
  const blobs = 5 + Math.floor(rand() * 3);
  for (let i = 0; i < blobs; i += 1) {
    const bx = w * (0.18 + rand() * 0.64);
    const by = h * (0.35 + rand() * 0.3);
    const br = 30 + rand() * 52;
    const g = ctx.createRadialGradient(bx, by, 0, bx, by, br);
    g.addColorStop(0, "rgba(226, 231, 245, 0.55)");
    g.addColorStop(1, "rgba(226, 231, 245, 0)");
    ctx.fillStyle = g;
    ctx.fillRect(bx - br, by - br, br * 2, br * 2);
  }
  return sprite;
}

function buildSceneParticles(rand, colors) {
  const cat = state.sceneCategory || "nature";
  const night = state.sceneFlavor === "night";
  const starCount = Math.round((cat === "skyline" ? 90 : 130) * (0.4 + 0.6 * colors.starStrength));
  const stars = [];
  for (let i = 0; i < starCount; i += 1) {
    stars.push({
      u: rand(),
      v: rand() * rand() * 0.62, // bias toward the top of the sky
      // 2–3px reads as a star from couch distance at 1080p; 1px vanishes.
      r: rand() < 0.8 ? 2 : 3,
      base: 0.3 + rand() * 0.55,
      speed: 0.4 + rand() * 1.2,
      phase: rand() * Math.PI * 2,
    });
  }
  const clouds = [];
  const cloudCount = night ? 2 : 3 + Math.floor(rand() * 3);
  for (let i = 0; i < cloudCount; i += 1) {
    clouds.push({
      sprite: makeCloudSprite(rand),
      u: rand(),
      v: 0.06 + rand() * 0.3,
      scale: 0.7 + rand() * 0.9,
      speed: (0.004 + rand() * 0.006) * (rand() < 0.5 ? 1 : -1), // u-units/second
      alpha: night ? 0.05 + rand() * 0.05 : 0.08 + rand() * 0.08,
    });
  }
  const cars = [];
  if (cat === "skyline") {
    for (let i = 0; i < 7; i += 1) {
      const toward = rand() < 0.5;
      cars.push({
        u: rand() * 1.2 - 0.1,
        lane: toward ? 0 : 1,
        dir: toward ? 1 : -1,
        speed: 0.05 + rand() * 0.05, // u-units/second
        len: 0.02 + rand() * 0.025,
        white: toward,
      });
    }
  }
  state.sceneParticles = {
    stars,
    clouds,
    cars,
    starStrength: colors.starStrength,
    starColor: "#dce6ff",
    shoot: null,
    nextShootAt: (typeof performance !== "undefined" ? performance.now() : 0) + 20000,
  };
}

// Measure both canvases once (and on resize) — never inside the frame loop.
// DPR is pinned to 1 on purpose: the particles are soft dots/glows, and halving
// the fill budget matters far more on the VIDAA GPU than retina stars.
function measureSceneCanvas() {
  const canvas = elements.sceneCanvas;
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width));
  const h = Math.max(1, Math.floor(rect.height));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const fg = elements.sceneFgCanvas;
  if (fg) {
    const fr = fg.getBoundingClientRect();
    const fw = Math.max(1, Math.floor(fr.width));
    const fh = Math.max(1, Math.floor(fr.height));
    if (fg.width !== fw || fg.height !== fh) {
      fg.width = fw;
      fg.height = fh;
    }
  }
  state.sceneRect = { w, h };
}

function startSceneCanvas() {
  if (state.sceneRaf) return;
  const canvas = elements.sceneCanvas;
  const ctx = canvas ? canvas.getContext("2d") : null;
  if (!ctx || !state.sceneParticles) return;
  const fg = elements.sceneFgCanvas;
  const fgCtx = fg ? fg.getContext("2d") : null;
  const prefersReduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  measureSceneCanvas();
  if (!state.sceneResizeHandler) {
    state.sceneResizeHandler = () => measureSceneCanvas();
    window.addEventListener("resize", state.sceneResizeHandler);
  }
  // Same budget as the visualizer: 30fps cap keeps the canvas work cheap.
  const frameInterval = 1000 / 30;
  let lastFrame = 0;
  let lastDraw = 0;
  const draw = (ts) => {
    if (state.ambientMode !== "screensaver" || state.currentView !== "ambient") {
      stopSceneCanvas();
      return;
    }
    state.sceneRaf = prefersReduced ? 0 : window.requestAnimationFrame(draw);
    if (!prefersReduced && ts - lastFrame < frameInterval) return;
    lastFrame = ts || 0;
    const dt = prefersReduced || !lastDraw ? 0 : Math.min(0.2, (ts - lastDraw) / 1000);
    lastDraw = ts || 0;
    drawSceneFrame(ctx, fgCtx, ts || 0, dt);
  };
  state.sceneRaf = window.requestAnimationFrame(draw);
}

function stopSceneCanvas() {
  if (state.sceneRaf) {
    window.cancelAnimationFrame(state.sceneRaf);
    state.sceneRaf = 0;
  }
  if (state.sceneResizeHandler) {
    window.removeEventListener("resize", state.sceneResizeHandler);
    state.sceneResizeHandler = null;
  }
  state.sceneRect = null;
}

function drawSceneFrame(ctx, fgCtx, ts, dt) {
  const rect = state.sceneRect;
  const p = state.sceneParticles;
  if (!rect || !p) return;
  const { w, h } = rect;
  const t = ts / 1000;
  ctx.clearRect(0, 0, w, h);

  // Stars: tiny rects, sine twinkle. fillStyle stays constant — only globalAlpha
  // varies per star, which is cheap on 2D canvas.
  ctx.fillStyle = p.starColor;
  for (const star of p.stars) {
    const tw = 0.55 + 0.45 * Math.sin(t * star.speed + star.phase);
    ctx.globalAlpha = star.base * tw * p.starStrength;
    ctx.fillRect(star.u * w, star.v * h, star.r, star.r);
  }

  // The occasional shooting star, night skies only.
  if (p.starStrength > 0.8) drawShootingStar(ctx, p, w, h, ts);

  // Clouds drift horizontally and wrap around with margin.
  for (const cloud of p.clouds) {
    cloud.u += cloud.speed * dt;
    if (cloud.u > 1.25) cloud.u = -0.25;
    if (cloud.u < -0.25) cloud.u = 1.25;
    const cw = cloud.sprite.width * cloud.scale * (w / 1280);
    const ch = cloud.sprite.height * cloud.scale * (w / 1280);
    ctx.globalAlpha = cloud.alpha;
    ctx.drawImage(cloud.sprite, cloud.u * w - cw / 2, cloud.v * h, cw, ch);
  }
  ctx.globalAlpha = 1;

  if (fgCtx && p.cars.length) drawSceneCars(fgCtx, p, dt);
}

function drawShootingStar(ctx, p, w, h, ts) {
  if (!p.shoot && ts >= p.nextShootAt) {
    p.shoot = { x: 0.15 + Math.random() * 0.6, y: 0.05 + Math.random() * 0.2, start: ts };
  }
  if (!p.shoot) return;
  const life = (ts - p.shoot.start) / 900; // ~0.9s streak
  if (life >= 1) {
    p.shoot = null;
    p.nextShootAt = ts + 25000 + Math.random() * 35000;
    return;
  }
  const slide = 0.18 * life;
  const x = (p.shoot.x + slide) * w;
  const y = (p.shoot.y + slide * 0.45) * h;
  const fade = life < 0.2 ? life / 0.2 : 1 - (life - 0.2) / 0.8;
  ctx.globalAlpha = 0.7 * fade;
  ctx.strokeStyle = "#dfe8ff";
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(x - 26, y - 12);
  ctx.lineTo(x, y);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

// Car-light streaks on the elevated-road band: bright head, two stepped tail
// rects standing in for a gradient (no per-frame gradient builds). The near
// buildings overlap this canvas, so cars pass "behind" the foreground.
function drawSceneCars(fgCtx, p, dt) {
  const fw = fgCtx.canvas.width;
  const fh = fgCtx.canvas.height;
  fgCtx.clearRect(0, 0, fw, fh);
  for (const car of p.cars) {
    car.u += car.speed * car.dir * dt;
    if (car.dir > 0 && car.u > 1.15) car.u = -0.15;
    if (car.dir < 0 && car.u < -0.15) car.u = 1.15;
    const y = (car.lane === 0 ? 0.42 : 0.66) * fh;
    const len = car.len * fw;
    const head = car.u * fw;
    fgCtx.fillStyle = car.white ? "#e8ecff" : "#ff5a4a";
    fgCtx.globalAlpha = 0.85;
    fgCtx.fillRect(head, y, 3, 2);
    fgCtx.globalAlpha = 0.4;
    fgCtx.fillRect(Math.min(head, head - car.dir * len * 0.5), y, len * 0.5, 2);
    fgCtx.globalAlpha = 0.16;
    fgCtx.fillRect(Math.min(head, head - car.dir * len), y, len, 2);
  }
  fgCtx.globalAlpha = 1;
}

// --- orchestration -------------------------------------------------------------

// Debug-only status badge on the Scene now-playing card: which renderer is live.
function setSceneStatus(stateName, detail) {
  const el = elements.sceneNpStatus;
  if (!el) return;
  el.dataset.state = stateName;
  const labels = {
    idle: "Scene: idle",
    procedural: `Procedural scene${detail ? " · " + detail : ""}`,
    error: `Scene error${detail ? " · " + detail : ""}`,
  };
  el.textContent = labels[stateName] || stateName;
}

// Build (or rebuild) the procedural scene. reseed=true rolls a new seed AND a
// new flavor so Skip/category changes produce a genuinely different picture;
// reseed=false (first entry) keeps any existing seed and follows the clock.
function buildProceduralScene(reseed) {
  const screensaver = elements.ambientScreensaver;
  const sky = elements.sceneSky;
  if (!screensaver || !sky) return;
  stopSceneCanvas();
  try {
    if (reseed || !state.sceneSeed) {
      state.sceneSeed = newSceneSeed();
      state.sceneFlavor = reseed
        ? SCENE_FLAVORS[Math.floor(Math.random() * SCENE_FLAVORS.length)]
        : sceneFlavorFromClock();
    }
    if (!state.sceneFlavor) state.sceneFlavor = sceneFlavorFromClock();
    const cat = state.sceneCategory || "nature";
    const rand = mulberry32(state.sceneSeed);

    const tintables = {
      // Sun/moon position is part of the seed: low near the horizon for
      // dawn/evening sun, higher in the sky for the night moon.
      glowX: 18 + Math.round(rand() * 64),
      glowY: state.sceneFlavor === "night" ? 12 + Math.round(rand() * 22) : 58 + Math.round(rand() * 18),
      paths: { far: [], mid: [], near: [] },
    };
    if (cat === "skyline") {
      buildSkylineLayers(rand, tintables);
    } else {
      buildNatureLayers(rand, tintables);
    }
    state.sceneTintables = tintables;
    screensaver.dataset.category = cat;
    applySceneTint();
    buildSceneParticles(rand, computeSceneColors());
    state.sceneBuiltKey = `${cat}:${state.sceneSeed}`;
    setSceneStatus("procedural", SCENE_CATEGORY_LABELS[cat]);
    log(`Scene: procedural ${cat} (${state.sceneFlavor}, seed ${state.sceneSeed}).`, "success");
    startSceneCanvas();
  } catch (err) {
    const msg = err?.message || String(err);
    setSceneStatus("error", msg);
    log(`Scene: procedural build failed: ${msg}`, "error");
  }
}

// Called by setAmbientMode + setView. Decides whether the procedural Scene
// should be live. Pausing drops .is-live (CSS parallax/twinkle animations stop
// costing the compositor) and cancels the particle rAF; the built DOM stays so
// returning to Scene resumes instantly.
function syncAmbientScene() {
  const screensaver = elements.ambientScreensaver;
  if (!screensaver) return;
  const shouldPlay = state.currentView === "ambient" && state.ambientMode === "screensaver";
  if (!shouldPlay) {
    stopSceneCanvas();
    screensaver.classList.remove("is-live");
    setSceneStatus("idle");
    return;
  }
  screensaver.classList.add("is-live");
  if (!state.sceneSeed || state.sceneBuiltKey !== `${state.sceneCategory}:${state.sceneSeed}`) {
    buildProceduralScene(false);
  } else {
    setSceneStatus("procedural", SCENE_CATEGORY_LABELS[state.sceneCategory]);
    startSceneCanvas();
  }
}

// Skip = "show me another one": re-roll seed + flavor and rebuild.
function skipSceneClip() {
  if (state.ambientMode !== "screensaver" || state.currentView !== "ambient") return;
  log("Scene: skip — reseeding the procedural scene.");
  buildProceduralScene(true);
}

// Segmented control: pick a category directly. No-op if already active, otherwise
// persist it, reflect the active segment, and build fresh scenery for it.
function selectSceneCategory(event) {
  const category = event?.currentTarget?.dataset?.category || event?.target?.dataset?.category;
  if (!category || !SCENE_CATEGORIES.includes(category)) return;
  if (category === state.sceneCategory) return;
  state.sceneCategory = category;
  try {
    localStorage.setItem(storageKeys.sceneCategory, state.sceneCategory);
  } catch {}
  reflectSceneCategory();
  log(`Scene category set to ${SCENE_CATEGORY_LABELS[state.sceneCategory]}.`);
  if (state.currentView === "ambient" && state.ambientMode === "screensaver") {
    buildProceduralScene(true); // fresh seed — a new category deserves new scenery
  }
}

// Reflect which segment is active across both Nature/City buttons (class + a11y).
function reflectSceneCategory() {
  const segments = [
    [elements.sceneNatureBtn, "nature"],
    [elements.sceneSkylineBtn, "skyline"],
  ];
  for (const [btn, category] of segments) {
    if (!btn) continue;
    const isActive = state.sceneCategory === category;
    btn.classList.toggle("is-active", isActive);
    btn.setAttribute("aria-pressed", isActive ? "true" : "false");
  }
}

export { applySceneTint, reflectSceneCategory, selectSceneCategory, skipSceneClip, syncAmbientScene };
