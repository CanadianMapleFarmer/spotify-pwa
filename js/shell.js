// View router + shell chrome state (the bits every view shares).

import { syncAmbientScene } from "./ambient/scene.js";
import { startVisualizerIfNeeded, stopVisualizer } from "./ambient/visualizer.js";
import { getStoredAccessToken } from "./auth.js";
import { storageKeys } from "./config.js";
import { log } from "./diagnostics.js";
import { elements } from "./dom.js";
import { activeFocusables, focusElement, invalidateFocusables } from "./focus.js";
import { restartPlaybackPolling } from "./player.js";
import { state } from "./state.js";
import { renderNpPill } from "./views/now.js";

function goToSettings() {
  setView("settings");
}

function setView(viewOrEvent) {
  const view = typeof viewOrEvent === "string"
    ? viewOrEvent
    : viewOrEvent?.currentTarget?.dataset?.view || viewOrEvent?.target?.dataset?.view;
  const nextView = view || "home";
  if (nextView !== state.currentView) {
    state.previousView = state.currentView;
  }
  state.currentView = nextView;
  // CSS hook: lets us scope rules to the current view (e.g. fully suppress the
  // .app column while ambient is up so its padding can't leak as a bottom bar).
  document.body.dataset.view = nextView;
  // Reset any inherited scroll position when entering ambient — focus moves
  // inside the fixed stage shouldn't ever scroll the document, but if a stray
  // scroll snuck in earlier we wipe it here so the stage really fills 100vh.
  if (nextView === "ambient") {
    try {
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    } catch {}
  }
  for (const section of document.querySelectorAll(".view")) {
    section.classList.toggle("is-visible", section.id === `view-${nextView}`);
  }
  for (const button of document.querySelectorAll(".nav-item")) {
    button.classList.toggle("is-active", button.dataset.view === nextView);
  }
  invalidateFocusables();
  renderNpPill();
  if (nextView === "ambient") {
    startVisualizerIfNeeded();
  } else {
    stopVisualizer();
  }
  // Adjust the playback-poll cadence to the new view (Now/Ambient → fast, others
  // → slow) so the visible bubbles refresh quickly when the phone changes tracks.
  restartPlaybackPolling("view change");
  syncAmbientScene();
  // Land focus inside the new view so the remote starts somewhere sensible.
  // Skip Ambient (it owns its own mode-arrow handling) and skip if focus is already there.
  if (nextView !== "ambient") {
    const targetView = document.getElementById(`view-${nextView}`);
    const alreadyInside = targetView && document.activeElement && targetView.contains(document.activeElement);
    if (!alreadyInside) {
      const focusables = activeFocusables();
      const firstInView = focusables.find((el) => targetView?.contains(el)) || focusables[0];
      if (firstInView) focusElement(firstInView);
    }
  }
  log(`View changed to ${nextView}.`);
}

function renderShellState() {
  const hasToken = Boolean(getStoredAccessToken() || localStorage.getItem(storageKeys.refreshToken));
  elements.connectionStatus.textContent = hasToken ? "Signed in" : "Not signed in";
  elements.deviceStatus.textContent = state.spotifyDeviceId
    ? (state.spotifyDeviceOffline ? "TV player offline" : "TV player ready")
    : state.spotifyPlayerPromise
      ? "Creating TV player"
      : "No TV player";
}

export { goToSettings, renderShellState, setView };
