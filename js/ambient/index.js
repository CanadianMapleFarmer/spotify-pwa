// Ambient room-display view: mode switching and the main ambient renderer.

import { AMBIENT_MODES, AMBIENT_MODE_LABELS, storageKeys } from "../config.js";
import { log } from "../diagnostics.js";
import { elements } from "../dom.js";
import { invalidateFocusables } from "../focus.js";
import { state } from "../state.js";
import { updateAmbientRoomArt } from "./room.js";
import { syncAmbientScene } from "./scene.js";
import { startVisualizerIfNeeded } from "./visualizer.js";

function setAmbientMode(eventOrMode) {
  const fromString = typeof eventOrMode === "string" ? eventOrMode : null;
  const mode = fromString
    || eventOrMode?.currentTarget?.dataset?.mode
    || eventOrMode?.target?.dataset?.mode
    || "room";
  state.ambientMode = AMBIENT_MODES.includes(mode) ? mode : "room";
  try {
    localStorage.setItem(storageKeys.ambientMode, state.ambientMode);
  } catch {}
  renderAmbient();
  for (const button of document.querySelectorAll("[data-action='setAmbientMode']")) {
    button.classList.toggle("is-active", button.dataset.mode === state.ambientMode);
  }
  // Scene mode is meant to be glanceable — fade the controls back until focused.
  elements.ambientControls?.classList.toggle("is-dim", state.ambientMode === "screensaver");
  if (state.currentView === "ambient") {
    startVisualizerIfNeeded();
  }
  syncAmbientScene();
  log(`Ambient mode set to ${state.ambientMode}.`);
}

function cycleAmbientMode(direction) {
  const idx = AMBIENT_MODES.indexOf(state.ambientMode);
  const safeIdx = idx < 0 ? 0 : idx;
  const next = direction === "left"
    ? (safeIdx - 1 + AMBIENT_MODES.length) % AMBIENT_MODES.length
    : (safeIdx + 1) % AMBIENT_MODES.length;
  setAmbientMode(AMBIENT_MODES[next]);
}

// Ambient is always presented as a full-bleed room display now — there's no
// separate fullscreen toggle. CSS makes the stage cover the viewport whenever
// .ambient-view.is-visible is up.



function renderAmbient() {
  const now = state.nowPlaying;
  const image = now?.image || "";
  const mode = state.ambientMode;
  const stage = elements.ambientStage;
  if (!stage) return;

  // Mode flips show/hide the Scene controls cluster — refresh the focus pool.
  if (stage.dataset.mode !== mode) invalidateFocusables();
  stage.dataset.mode = mode;
  stage.classList.toggle("has-artwork", Boolean(image));
  stage.classList.toggle("is-playing", Boolean(now && !now.paused));

  // Global background tint follows artwork (used when not on Ambient view).
  if (image && state.currentView !== "ambient") {
    elements.ambientBg.classList.add("has-artwork");
    elements.ambientBg.classList.remove("skyline");
    elements.ambientBg.style.backgroundImage = `url("${image}")`;
  } else {
    elements.ambientBg.classList.remove("has-artwork", "skyline");
    elements.ambientBg.style.backgroundImage = "";
  }

  if (elements.ambientModeLabel) {
    elements.ambientModeLabel.textContent = AMBIENT_MODE_LABELS[mode] || "Room Display";
  }

  updateAmbientRoomArt(image);

  if (elements.sceneNpTitle) {
    elements.sceneNpTitle.textContent = now?.title || "Nothing playing";
  }
  if (elements.sceneNpArtist) {
    elements.sceneNpArtist.textContent = now?.artist || "";
  }
  if (elements.sceneNpArt) {
    if (image) {
      elements.sceneNpArt.src = image;
    } else {
      elements.sceneNpArt.removeAttribute("src");
    }
  }

  if (elements.ambientVisualizerArt) {
    if (image) {
      elements.ambientVisualizerArt.src = image;
    } else {
      elements.ambientVisualizerArt.removeAttribute("src");
    }
  }

  // Room mode's backdrop pulls the artwork from this custom property.
  const artUrl = image ? `url("${image}")` : "none";
  stage.style.setProperty("--ambient-art-url", artUrl);

  for (const button of document.querySelectorAll("[data-action='setAmbientMode']")) {
    button.classList.toggle("is-active", button.dataset.mode === mode);
  }
}

function handleAmbientModeArrow(direction) {
  if (state.currentView !== "ambient") return false;
  const active = document.activeElement;
  // Allow normal focus navigation when focus is inside the controls row.
  if (active && active.closest && active.closest(".ambient-controls")) {
    return false;
  }
  cycleAmbientMode(direction);
  return true;
}

export { handleAmbientModeArrow, renderAmbient, setAmbientMode };
