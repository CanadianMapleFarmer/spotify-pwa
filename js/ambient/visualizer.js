// Ambient visualizer: radial bars canvas renderer.

import { elements } from "../dom.js";
import { state } from "../state.js";
import { parseRgbColor, rgbCss } from "./palette.js";

// Measure the canvas once (and on resize) and resize the backing store to match,
// scaling for devicePixelRatio. getBoundingClientRect() forces a layout flush, so
// we keep it out of the per-frame draw loop — on the VIDAA GPU that per-frame
// measure was a real cost. The cached rect width/height (CSS pixels) is what the
// draw loop reads each frame.
function measureVisualizerCanvas(canvas, ctx) {
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width));
  const h = Math.max(1, Math.floor(rect.height));
  // Cap dpr at 2 so 4K-reported panels don't blow up the backing store.
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const bw = Math.floor(w * dpr);
  const bh = Math.floor(h * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
    // Reset the transform before re-applying dpr scale so it never compounds.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  state.visualizerRect = { width: w, height: h };
}

function startVisualizerIfNeeded() {
  if (state.ambientMode !== "visualizer") {
    stopVisualizer();
    return;
  }
  if (state.visualizerRaf) return;
  const canvas = elements.ambientVisualizerCanvas;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const prefersReduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  // Measure once on start, then only on resize — never per frame.
  measureVisualizerCanvas(canvas, ctx);
  if (!state.visualizerResizeHandler) {
    state.visualizerResizeHandler = () => measureVisualizerCanvas(canvas, ctx);
    window.addEventListener("resize", state.visualizerResizeHandler);
  }
  // TV-optimized: cap to ~30fps so the canvas work stays cheap on the VIDAA GPU.
  // Anything higher just dropped frames and lagged the whole UI.
  const frameInterval = 1000 / 30;
  let lastFrame = 0;
  const draw = (ts) => {
    if (state.ambientMode !== "visualizer" || state.currentView !== "ambient") {
      stopVisualizer();
      return;
    }
    state.visualizerRaf = prefersReduced ? 0 : window.requestAnimationFrame(draw);
    if (!prefersReduced && ts - lastFrame < frameInterval) return;
    lastFrame = ts || 0;
    const rect = state.visualizerRect;
    if (!rect) return;
    state.visualizerPhase += prefersReduced ? 0 : 0.06;
    drawVisualizerFrame(ctx, rect.width, rect.height, state.visualizerPhase, state.paletteCache.palette);
  };
  state.visualizerRaf = window.requestAnimationFrame(draw);
}

function stopVisualizer() {
  if (state.visualizerRaf) {
    window.cancelAnimationFrame(state.visualizerRaf);
    state.visualizerRaf = 0;
  }
  if (state.visualizerResizeHandler) {
    window.removeEventListener("resize", state.visualizerResizeHandler);
    state.visualizerResizeHandler = null;
  }
  state.visualizerRect = null;
}

// Pre-rendered visualizer assets, rebuilt only when the palette or canvas size
// changes — the per-frame loop never builds gradients or sprites. Glow comes
// from a radial-gradient sprite (canvas shadowBlur is unusably slow on the TV).
const VIZ_BARS = 56;
const _viz = {
  key: "",
  glow: null, // offscreen radial glow sprite, drawImage'd behind the art
  barGradient: null, // radial stroke gradient in the translated (center) space
  dust: null, // few dozen ambient motes, seeded once per session
  bars: new Float32Array(VIZ_BARS), // eased per-bar amplitudes (lerp, no jumps)
  peaks: new Float32Array(VIZ_BARS), // peak-cap lengths with slow falloff
  energy: 0.5, // eased 0..1 — relaxes when paused instead of snapping
};

function colorWithAlpha(color, alpha) {
  const c = parseRgbColor(color);
  return c ? rgbCss(c, alpha) : color;
}

function ensureVizAssets(ctx, w, h, accentA, accentB) {
  const key = `${w}x${h}|${accentA}|${accentB}`;
  if (_viz.key === key) return;
  _viz.key = key;
  const minDim = Math.min(w, h);
  const glowSize = Math.round(minDim * 0.95);
  const glow = document.createElement("canvas");
  glow.width = glowSize;
  glow.height = glowSize;
  const gctx = glow.getContext("2d");
  if (gctx) {
    const half = glowSize / 2;
    const grad = gctx.createRadialGradient(half, half, minDim * 0.12, half, half, half);
    grad.addColorStop(0, colorWithAlpha(accentA, 0.32));
    grad.addColorStop(0.55, colorWithAlpha(accentB, 0.12));
    grad.addColorStop(1, colorWithAlpha(accentB, 0));
    gctx.fillStyle = grad;
    gctx.fillRect(0, 0, glowSize, glowSize);
  }
  _viz.glow = glow;
  const innerR = minDim * 0.3;
  const bar = ctx.createRadialGradient(0, 0, innerR, 0, 0, innerR + minDim * 0.24);
  bar.addColorStop(0, accentA);
  bar.addColorStop(1, accentB);
  _viz.barGradient = bar;
  if (!_viz.dust) {
    const dust = [];
    for (let i = 0; i < 36; i += 1) {
      dust.push({
        u: Math.random(),
        v: Math.random(),
        r: Math.random() < 0.8 ? 1.5 : 2.5,
        speed: 0.005 + Math.random() * 0.012,
        phase: Math.random() * Math.PI * 2,
      });
    }
    _viz.dust = dust;
  }
}

// No FFT (DRM blocks audio taps) — derive a stable per-track tempo guess from
// the track id so each song at least *feels* different. Layered half/double-time
// bands below keep the pulse from being metronomic.
function vizBpmGuess(now) {
  const id = now?.id || now?.title || "";
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return 84 + (Math.abs(hash) % 48); // 84–131 bpm
}

function drawVisualizerFrame(ctx, w, h, phase, palette) {
  const accentA = (palette && palette[0]) || "rgb(30, 215, 96)";
  const accentB = (palette && palette[1]) || "rgb(112, 166, 255)";
  const accentC = (palette && palette[2]) || accentA;
  ensureVizAssets(ctx, w, h, accentA, accentB);
  ctx.clearRect(0, 0, w, h);

  const now = state.nowPlaying;
  const positionMs = now ? (now.paused ? now.position : now.position + (Date.now() - now.updatedAt)) : 0;
  const playing = Boolean(now && !now.paused);
  // Energy eases instead of snapping so pause/resume breathes down/up.
  _viz.energy += ((playing ? 1 : 0.3) - _viz.energy) * 0.04;
  const energy = _viz.energy;

  // Layered pseudo-beat locked to the playback timeline: a per-track tempo
  // guess plus half- and double-time sine bands. Not a real FFT — DRM audio
  // can't be tapped — but it stops the pulse feeling metronomic.
  const beatHz = vizBpmGuess(now) / 60;
  const beat1 = (positionMs / 1000) * beatHz * Math.PI * 2;
  const pulseRaw =
    Math.sin(beat1) * 0.55 +
    Math.sin(beat1 * 0.5 + 1.3) * 0.3 +
    Math.sin(beat1 * 2 + 0.7) * 0.15;
  const pulse = (pulseRaw * 0.5 + 0.5) * energy;

  const cx = w / 2;
  const cy = h / 2;
  const minDim = Math.min(w, h);
  const innerR = minDim * 0.30 * (1 + pulse * 0.03);
  // TV-optimized: no shadowBlur, no "lighter" compositing. Glow is a single
  // pre-rendered sprite blit; everything else is thin alpha strokes.

  // Faint dust motes drifting upward, furthest back.
  ctx.fillStyle = accentB;
  for (const mote of _viz.dust) {
    mote.v -= mote.speed * 0.016;
    if (mote.v < -0.02) {
      mote.v = 1.02;
      mote.u = Math.random();
    }
    const flicker = 0.5 + 0.5 * Math.sin(phase * mote.speed * 30 + mote.phase);
    ctx.globalAlpha = 0.05 + 0.09 * flicker * energy;
    ctx.fillRect(mote.u * w, mote.v * h, mote.r, mote.r);
  }
  ctx.globalAlpha = 1;

  // Palette glow behind the art, breathing with the beat.
  if (_viz.glow) {
    ctx.globalAlpha = 0.5 + pulse * 0.35;
    ctx.drawImage(_viz.glow, cx - _viz.glow.width / 2, cy - _viz.glow.height / 2);
    ctx.globalAlpha = 1;
  }

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(phase * 0.01); // slow whole-ring drift
  ctx.lineCap = "round";
  const barW = Math.max(2, (minDim / VIZ_BARS) * 0.5);
  for (let i = 0; i < VIZ_BARS; i++) {
    const t = i / VIZ_BARS;
    const angle = t * Math.PI * 2 - Math.PI / 2;
    const wobble =
      Math.sin(phase * 0.7 + i * 0.35) * 0.5 +
      Math.sin(phase * 0.33 + i * 0.11) * 0.3 +
      Math.sin(beat1 + i * 0.5) * 0.4;
    const target = (0.30 + (wobble * 0.5 + 0.5) * 0.7) * energy;
    // Smooth amplitude easing — bars glide toward their targets, never jump.
    _viz.bars[i] += (target - _viz.bars[i]) * 0.25;
    const amp = _viz.bars[i];
    const len = amp * minDim * 0.16 + 6;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    // Outer bar: palette gradient stroke (precomputed, radial A→B).
    ctx.strokeStyle = _viz.barGradient;
    ctx.globalAlpha = 0.38 + amp * 0.5;
    ctx.lineWidth = barW;
    ctx.beginPath();
    ctx.moveTo(cosA * innerR, sinA * innerR);
    ctx.lineTo(cosA * (innerR + len), sinA * (innerR + len));
    ctx.stroke();
    // Peak cap: holds the recent maximum and falls away slowly.
    _viz.peaks[i] = Math.max(len, _viz.peaks[i] - minDim * 0.0014);
    const peakR = innerR + _viz.peaks[i] + 5;
    ctx.globalAlpha = 0.28 + amp * 0.3;
    ctx.lineWidth = Math.max(2, barW * 0.6);
    ctx.beginPath();
    ctx.moveTo(cosA * peakR, sinA * peakR);
    ctx.lineTo(cosA * (peakR + 3), sinA * (peakR + 3));
    ctx.stroke();
    // Mirrored inner ring: shorter bars pointing inward, cooler color.
    const innerLen = len * 0.4;
    ctx.strokeStyle = accentB;
    ctx.globalAlpha = 0.18 + amp * 0.25;
    ctx.lineWidth = Math.max(2, barW * 0.55);
    ctx.beginPath();
    ctx.moveTo(cosA * (innerR * 0.86), sinA * (innerR * 0.86));
    ctx.lineTo(cosA * (innerR * 0.86 - innerLen), sinA * (innerR * 0.86 - innerLen));
    ctx.stroke();
  }
  // Soft breathing ring just outside the album art.
  ctx.globalAlpha = 0.14 + pulse * 0.18;
  ctx.lineWidth = minDim * 0.012;
  ctx.strokeStyle = accentC;
  ctx.beginPath();
  ctx.arc(0, 0, innerR * 0.92, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  // Track-progress arc (drawn unrotated): a faint full ring plus a brighter arc
  // up to the current position, so the visualizer doubles as a glanceable timer.
  if (now && now.duration) {
    const progress = Math.max(0, Math.min(1, positionMs / now.duration));
    const arcR = innerR + minDim * 0.215;
    ctx.lineCap = "round";
    ctx.lineWidth = 3;
    ctx.strokeStyle = accentC;
    ctx.globalAlpha = 0.1;
    ctx.beginPath();
    ctx.arc(cx, cy, arcR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 0.42;
    ctx.beginPath();
    ctx.arc(cx, cy, arcR, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

export { startVisualizerIfNeeded, stopVisualizer };
