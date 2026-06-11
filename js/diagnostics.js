// Logging, toasts, the debug panel, device checks and remote-key readouts.

import { spotifyRedirectUri } from "./auth.js";
import { storageKeys } from "./config.js";
import { elements, renderFacts } from "./dom.js";
import { _repeatScrollInstant, invalidateFocusables } from "./focus.js";
import { state } from "./state.js";
import { storageAvailable } from "./utils.js";

function isDiagnosticsOpen() {
  const panel = elements.diagnostics || document.getElementById("diagnostics");
  return Boolean(panel) && !panel.hidden;
}

// While the debug overlay is open, up/down scroll the panel directly — VIDAA
// has no mouse/wheel, so this is the only way to read past the visible portion
// on a TV remote. When debug is on the inner .log has max-height:none, so the
// .diagnostics panel itself is the scroll container (not the log element).
function scrollDiagnostics(direction) {
  const panel = elements.diagnostics || document.getElementById("diagnostics");
  if (!panel) return false;
  const step = Math.max(120, panel.clientHeight - 60);
  try {
    panel.scrollBy({ top: direction === "down" ? step : -step, behavior: _repeatScrollInstant ? "auto" : "smooth" });
  } catch {
    panel.scrollTop += direction === "down" ? step : -step;
  }
  return true;
}

function logRemoteEvent(event, normalized) {
  const payload = {
    type: event.type,
    normalized,
    key: event.key,
    code: event.code,
    keyCode: event.keyCode,
    which: event.which,
    target: event.target?.tagName,
    active: document.activeElement?.id || document.activeElement?.tagName,
  };
  state.remoteEvents.push(payload);
  state.remoteEvents = state.remoteEvents.slice(-40);
  if (elements.keyReadout) elements.keyReadout.textContent = JSON.stringify(payload);
  if (elements.keyStatus) elements.keyStatus.textContent = `${normalized} (${event.type})`;
  // Native auto-repeats while a key is held would flood the log (and its server
  // beacon) at the repeat cadence — log only the initial press.
  if (event.type === "keydown" && !event.repeat) {
    log(`Remote key: ${JSON.stringify(payload)}`);
  }
}

function runDeviceChecks() {
  const facts = {
    "User agent": navigator.userAgent,
    "Secure context": String(window.isSecureContext),
    "Crypto subtle": crypto?.subtle?.digest ? "available" : "missing",
    "Service worker": "serviceWorker" in navigator ? "available" : "missing",
    "Local storage": storageAvailable() ? "available" : "blocked",
    "HiUtils": typeof window.HiUtils_createRequest === "function" ? "available" : "missing",
    "Hisense install": typeof window.Hisense_installApp === "function" ? "available" : "missing",
    "Spotify SDK": window.Spotify ? "loaded" : "not loaded",
    "Spotify redirect URI": spotifyRedirectUri(),
  };
  renderFacts(elements.deviceFacts, facts);
  log("Device checks completed.", "success");
}

function clearKeys() {
  if (elements.keyReadout) elements.keyReadout.textContent = "Waiting for key event";
  state.remoteEvents = [];
  log("Key readout cleared.");
}
function testStorage() {
  const value = new Date().toISOString();
  localStorage.setItem("spotify-probe-storage-test", value);
  const persisted = localStorage.getItem("spotify-probe-storage-test") === value;
  if (elements.storageMediaStatus) {
    elements.storageMediaStatus.textContent = persisted
      ? `Storage OK at ${value}`
      : "Storage write/read failed.";
  }
  log(persisted ? "Storage test passed." : "Storage test failed.", persisted ? "success" : "error");
}

async function testAudio() {
  try {
    if (!elements.probeAudio) throw new Error("Probe audio element is not mounted.");
    elements.probeAudio.currentTime = 0;
    await elements.probeAudio.play();
    if (elements.storageMediaStatus) elements.storageMediaStatus.textContent = "HTML audio play() resolved.";
    log("HTML audio play() resolved.", "success");
  } catch (audioError) {
    logError("HTML audio failed; trying Web Audio", audioError);
    await testWebAudio();
  }
}

async function testWebAudio() {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) {
    throw new Error("No supported audio path: HTML audio and Web Audio are both unavailable.");
  }

  const context = new AudioContextCtor();
  if (context.state === "suspended") {
    await context.resume();
  }

  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.frequency.value = 440;
  gain.gain.value = 0.08;
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + 0.25);
  if (elements.storageMediaStatus) elements.storageMediaStatus.textContent = "Web Audio tone test started.";
  log("Web Audio tone test started.", "success");
}

function toggleDebugView() {
  state.debugVisible = !state.debugVisible;
  try {
    localStorage.setItem(storageKeys.debugVisible, state.debugVisible ? "1" : "0");
  } catch {}
  applyDebugVisibility();
  log(`Debug view ${state.debugVisible ? "enabled" : "disabled"}.`);
}

function applyDebugVisibility() {
  document.body.classList.toggle("debug-on", state.debugVisible);
  if (elements.diagnostics) {
    elements.diagnostics.hidden = !state.debugVisible;
  }
  invalidateFocusables();
  if (elements.toggleDebugView) {
    elements.toggleDebugView.setAttribute("aria-checked", state.debugVisible ? "true" : "false");
  }
  if (elements.toggleDebugState) {
    elements.toggleDebugState.textContent = state.debugVisible ? "On" : "Off";
  }
}

function clearLog() {
  elements.log?.replaceChildren();
}

function log(message, level = "info") {
  if (elements.log) {
    const item = document.createElement("li");
    item.className = level;
    item.textContent = `${new Date().toLocaleTimeString()} ${message}`;
    elements.log.append(item);
    while (elements.log.children.length > 120) {
      elements.log.firstElementChild?.remove();
    }
  }
  if (level === "error") {
    showToast(message, level);
  }
  sendServerLog({ level, message });
}

function logError(context, error) {
  const message = error instanceof Error ? error.message : String(error);
  // Errors flagged `handled` already showed their own friendly toast — log
  // them as warnings so log()'s error→toast path can't double-toast.
  log(`${context}: ${message}`, error?.handled ? "warn" : "error");
}

function showToast(message, level = "info") {
  if (!elements.toastStack) return;
  const toast = document.createElement("div");
  toast.className = `toast ${level}`;
  toast.textContent = message;
  elements.toastStack.append(toast);
  // Cap visible toasts at 3 — older ones leave on their own.
  while (elements.toastStack.children.length > 3) {
    elements.toastStack.firstElementChild?.remove();
  }
  // 10-foot reading distance needs longer dwell than a desktop toast.
  window.setTimeout(() => {
    toast.classList.add("is-leaving");
    window.setTimeout(() => toast.remove(), 220);
  }, level === "error" ? 7000 : 5000);
}

function sendServerLog(payload) {
  const body = JSON.stringify({
    ...payload,
    href: location.href,
    userAgent: navigator.userAgent,
    at: new Date().toISOString(),
  });
  if (navigator.sendBeacon) {
    navigator.sendBeacon("/__probe-log", new Blob([body], { type: "application/json" }));
    return;
  }
  fetch("/__probe-log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => {});
}

export {
  applyDebugVisibility,
  clearKeys,
  clearLog,
  isDiagnosticsOpen,
  log,
  logError,
  logRemoteEvent,
  runDeviceChecks,
  scrollDiagnostics,
  showToast,
  testAudio,
  testStorage,
  toggleDebugView,
};
