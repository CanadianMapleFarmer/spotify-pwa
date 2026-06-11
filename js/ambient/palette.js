// Album-art palette extraction and ambient palette application.

import { elements } from "../dom.js";
import { state } from "../state.js";
import { applySceneTint } from "./scene.js";

function refreshAmbientPalette(imageUrl) {
  if (!imageUrl || imageUrl === state.paletteCache.url) {
    return;
  }
  extractPalette(imageUrl).then((palette) => {
    if (!palette) return;
    state.paletteCache = { url: imageUrl, palette };
    applyAmbientPalette(palette);
  }).catch(() => {
    /* ignore palette errors — fall back to default tokens */
  });
}

function applyAmbientPalette(palette) {
  if (!palette) return;
  if (elements.viewAmbient) {
    const [a, b, c] = palette;
    if (a) elements.viewAmbient.style.setProperty("--ambient-accent-a", a);
    if (b) elements.viewAmbient.style.setProperty("--ambient-accent-b", b);
    if (c) elements.viewAmbient.style.setProperty("--ambient-accent-c", c);
  }
  // Now Playing shares the track palette: a subtle tint instead of flat black.
  applyPaletteChannels(elements.viewNow, "--np-rgb", palette, { scrimBoost: true });
  // Visualizer background wash picks up the palette via CSS rgba(var(--viz-rgb)).
  applyPaletteChannels(elements.viewAmbient, "--viz-rgb", palette);
  // The procedural Scene harmonizes with the playing album: re-tint sky/layers
  // in place (no geometry rebuild, so the slow parallax never jumps).
  applySceneTint();
}

// Writes a palette entry as bare "r, g, b" channels so CSS can compose its own
// alphas via rgba(var(--prop), a) — color-mix() is unavailable on TV Blink.
// #18: billboard views also get --tint-scrim-boost — a bright palette washes
// out the white header text, so CSS deepens the existing gradient scrim by this
// extra alpha (no text-color flip, no filters).
function applyPaletteChannels(el, prop, palette, { scrimBoost = false } = {}) {
  if (!el || !palette?.length) return;
  const match = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(palette[0] || "");
  if (!match) return;
  const r = Number(match[1]);
  const g = Number(match[2]);
  const b = Number(match[3]);
  el.style.setProperty(prop, `${r}, ${g}, ${b}`);
  if (scrimBoost) {
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    const boost = lum > 0.72 ? 0.28 : lum > 0.55 ? 0.18 : lum > 0.42 ? 0.1 : 0;
    el.style.setProperty("--tint-scrim-boost", String(boost));
  }
}

function extractPalette(url) {
  return new Promise((resolve) => {
    if (!url) return resolve(null);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onerror = () => resolve(null);
    img.onload = () => {
      try {
        const size = 12;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, size, size);
        const data = ctx.getImageData(0, 0, size, size).data;
        const buckets = new Map();
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i], g = data[i + 1], bl = data[i + 2], alpha = data[i + 3];
          if (alpha < 200) continue;
          const max = Math.max(r, g, bl);
          const min = Math.min(r, g, bl);
          const sat = max === 0 ? 0 : (max - min) / max;
          const lum = (max + min) / 2 / 255;
          if (sat < 0.18 || lum < 0.12 || lum > 0.92) continue;
          const key = `${r >> 4}-${g >> 4}-${bl >> 4}`;
          const entry = buckets.get(key) || { r: 0, g: 0, b: 0, count: 0 };
          entry.r += r; entry.g += g; entry.b += bl; entry.count += 1;
          buckets.set(key, entry);
        }
        const ranked = Array.from(buckets.values())
          .sort((x, y) => y.count - x.count)
          .slice(0, 4)
          .map((entry) => `rgb(${Math.round(entry.r / entry.count)}, ${Math.round(entry.g / entry.count)}, ${Math.round(entry.b / entry.count)})`);
        resolve(ranked.length ? ranked : null);
      } catch {
        resolve(null);
      }
    };
    img.src = url;
  });
}

// --- color helpers (palette entries come from extractPalette as "rgb(r, g, b)") --
function parseRgbColor(str) {
  const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(str || "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function mixRgb(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function rgbCss(c, alpha) {
  if (alpha === undefined) return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})`;
}

export { applyPaletteChannels, extractPalette, mixRgb, parseRgbColor, refreshAmbientPalette, rgbCss };
