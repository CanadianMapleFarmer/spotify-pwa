// Generic helpers: formatters, image pickers, HTML escaping, PRNG, storage probe.

function formatFollowers(count) {
  if (count >= 1e6) return `${(count / 1e6).toFixed(count >= 1e7 ? 0 : 1)}M`;
  if (count >= 1e3) return `${Math.round(count / 1e3)}K`;
  return String(count);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
// Deterministic PRNG: one seed → one scene. (Math.random only rolls new seeds.)
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor((ms || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

// Human-readable total for a collection header, e.g. "1 hr 23 min" / "47 min".
function formatTotalDuration(ms) {
  const totalMinutes = Math.round(Math.max(0, ms) / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours} hr${minutes ? ` ${minutes} min` : ""}`;
  return `${minutes} min`;
}

// Spotify `images[]` arrays come largest-first (typically 640/300/64). Pick the
// smallest variant that still covers `minSize` CSS pixels so cards and rows
// don't make the TV download + decode 640×640 art for a ~230px tile. Falls back
// to the largest when sizes are missing (some playlist mosaics omit them).
function pickImageUrl(item, minSize = 300) {
  const images = item?.album?.images || item?.images || [];
  let best = null;
  let bestDim = Infinity;
  for (const image of images) {
    if (!image?.url) continue;
    const dim = Math.max(image.width || 0, image.height || 0);
    if (!dim) continue; // unsized entry — only usable via the images[0] fallback
    if (dim >= minSize && dim < bestDim) {
      best = image;
      bestDim = dim;
    }
  }
  return best?.url || images[0]?.url || "";
}

function getImage(item, minSize = 300) {
  return pickImageUrl(item, minSize) || "/public/icons/spotify-logo.png";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

function storageAvailable() {
  try {
    const key = "__spotify_probe_storage__";
    localStorage.setItem(key, key);
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export {
  escapeAttribute,
  escapeHtml,
  formatDuration,
  formatFollowers,
  formatTotalDuration,
  getImage,
  mulberry32,
  pickImageUrl,
  sleep,
  storageAvailable,
};
