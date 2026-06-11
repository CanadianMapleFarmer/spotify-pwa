// Entry point: data-action registry, boot wiring and init().

// main.js is the entry module and is imported by nobody, so the eval-time
// `actions` table below always sees fully initialized imported bindings even
// though the feature modules form import cycles among themselves (see the
// note in focus.js).

import { renderAmbient, setAmbientMode } from "./ambient/index.js";
import { reflectSceneCategory, selectSceneCategory, skipSceneClip } from "./ambient/scene.js";
import {
  applyUrlState,
  checkPairToken,
  createPairLogin,
  handleSpotifyRedirect,
  loginSpotify,
  renderPhonePairScreen,
  resetSpotify,
  saveClientId,
} from "./auth.js";
import { AMBIENT_MODES, SCENE_CATEGORIES, SPOTIFY_CLIENT_ID, storageKeys } from "./config.js";
import {
  applyDebugVisibility,
  clearKeys,
  clearLog,
  log,
  logError,
  runDeviceChecks,
  testAudio,
  testStorage,
  toggleDebugView,
} from "./diagnostics.js";
import { elements } from "./dom.js";
import {
  cancelExit,
  clearKeyRepeat,
  confirmExit,
  focusFirst,
  handleRemoteEvent,
  wireFocusWithinClass,
} from "./focus.js";
import {
  createSpotifyPlayer,
  cycleRepeat,
  getCurrentPlayback,
  loadSpotifySdk,
  nextTrack,
  previousTrack,
  scheduleSpotifyPlayerCreation,
  startPlaybackPolling,
  stopPlaybackPolling,
  toggleShuffle,
  toggleSpotifyPlayback,
  transferPlayback,
  volumeDown,
  volumeUp,
} from "./player.js";
import { closeQueueDrawer, openQueueDrawer } from "./queue.js";
import { goToSettings, renderShellState, setView } from "./shell.js";
import { state } from "./state.js";
import { closeTrackMenu } from "./track-menu.js";
import { artistBack } from "./views/artist.js";
import {
  collectionBack,
  handleCollectionTracksFocusIn,
  playCollection,
  toggleCollectionSaved,
  toggleCollectionShuffle,
} from "./views/collection.js";
import { bootstrapData, refreshAll } from "./views/home.js";
import { loadLibrary } from "./views/library.js";
import { renderNpPill, renderTransportState, startProgressTimer } from "./views/now.js";
import { buildSearchKeyboard, renderSearchQuery } from "./views/search.js";
import {
  applyAutoplaySimilarState,
  loadDevices,
  renderPairInfo,
  renderSpotifyFacts,
  toggleAutoplaySimilar,
} from "./views/settings.js";

const actions = {
  setView,
  goToSettings,
  runDeviceChecks,
  refreshAll,
  loadLibrary,
  loadDevices,
  setAmbientMode,
  selectSceneCategory,
  skipSceneClip,
  playCollection,
  toggleCollectionShuffle,
  toggleCollectionSaved,
  collectionBack,
  artistBack,
  clearKeys,
  testStorage,
  testAudio,
  saveClientId,
  loginSpotify,
  createPairLogin,
  checkPairToken,
  loadSpotifySdk,
  createSpotifyPlayer,
  transferPlayback,
  getCurrentPlayback,
  toggleSpotifyPlayback,
  toggleShuffle,
  cycleRepeat,
  nextTrack,
  previousTrack,
  volumeDown,
  volumeUp,
  resetSpotify,
  clearLog,
  toggleDebugView,
  toggleAutoplaySimilar,
  cancelExit,
  confirmExit,
  openQueueDrawer,
  closeQueueDrawer,
  closeTrackMenu,
};

function init() {
  localStorage.setItem(storageKeys.clientId, SPOTIFY_CLIENT_ID);
  if (elements.clientIdInput) {
    elements.clientIdInput.value = SPOTIFY_CLIENT_ID;
  }
  applyUrlState();

  if (document.body.classList.contains("is-phone-pair")) {
    initPhoneOnly();
    return;
  }

  // Lift #view-ambient out of .app and into the body root so nothing inside the
  // app shell (margins, padding, scroll, focus auto-scroll) can affect it. With
  // ambient as a body-level child its position:fixed inset:0 is the *only* thing
  // that decides its placement — no more leaks at the bottom edge on the TV.
  const ambientView = document.getElementById("view-ambient");
  if (ambientView && ambientView.parentElement !== document.body) {
    document.body.appendChild(ambientView);
  }

  window.addEventListener("error", (event) => {
    log(`Window error: ${event.message} at ${event.filename}:${event.lineno}`, "error");
  });
  window.addEventListener("unhandledrejection", (event) => {
    logError("Unhandled promise rejection", event.reason);
  });

  for (const eventType of ["keydown", "keyup", "keypress"]) {
    window.addEventListener(eventType, handleRemoteEvent, true);
  }

  document.addEventListener("click", handleClick);

  // Focus-state class fallbacks for old TV Blink builds without :focus-within.
  // The rail expands (labels + scrim) while focus is inside it; the dimmed
  // ambient control cluster undims while any of its controls is focused.
  wireFocusWithinClass(elements.navRail);
  wireFocusWithinClass(elements.ambientControls);

  // On-screen search keyboard (Search view) is generated once at boot.
  buildSearchKeyboard();
  renderSearchQuery();

  // Windowed collection rendering: extend the rendered row window as focus
  // approaches its end (see renderMoreCollectionRows).
  elements.collectionTracks?.addEventListener("focusin", handleCollectionTracksFocusIn);

  // If the app loses key focus mid-hold we never get the keyup — stop repeating.
  window.addEventListener("blur", clearKeyRepeat);

  elements.pairQr?.addEventListener("error", () => {
    elements.pairQr.hidden = true;
    log("Pair QR image failed to load. Use the printed URL on your phone.", "error");
  });
  elements.pairQr?.addEventListener("load", () => {
    elements.pairQr.hidden = false;
  });
  window.addEventListener("spotifySdkReady", () => {
    log("Spotify SDK ready event received.", "success");
    renderSpotifyFacts();
  });

  // Pause polling when the tab goes hidden (e.g. TV briefly drops focus) so we
  // don't burn quota; resume snappily on return so the user sees fresh state.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopPlaybackPolling();
    } else {
      startPlaybackPolling("visibility");
    }
  });

  hydrateUiPreferences();
  runDeviceChecks();
  renderPairInfo();
  renderShellState();
  renderNpPill();
  renderTransportState();
  renderAmbient();
  startProgressTimer();
  scheduleSpotifyPlayerCreation("app init");
  focusFirst();

  // Resolve the OAuth/pair redirect first (it loads data itself when a code is
  // present), then make sure a cold reload with an existing session still pulls
  // data through instead of getting stuck on the empty skeleton.
  handleSpotifyRedirect()
    .catch((error) => logError("Spotify redirect failed", error))
    .finally(() => {
      bootstrapData("app init").catch((error) => logError("Initial data load failed", error));
    });
}

function initPhoneOnly() {
  // Minimal bootstrap for the phone pair flow. The TV-side app stays untouched and
  // never loads the SDK, never hits Spotify APIs after sign-in, and never registers
  // the service worker (this is a one-shot auth surface).
  window.addEventListener("error", (event) => {
    logError("Phone error", new Error(`${event.message} at ${event.filename}:${event.lineno}`));
  });
  window.addEventListener("unhandledrejection", (event) => {
    logError("Phone unhandled rejection", event.reason);
  });
  document.addEventListener("click", handleClick);

  if (elements.phonePairScreen) elements.phonePairScreen.hidden = false;

  const params = new URLSearchParams(location.search);
  const hasCode = params.has("code");
  const hasError = params.has("error");

  if (hasError) {
    renderPhonePairScreen("error", `Spotify returned: ${params.get("error")}`);
  } else if (hasCode) {
    renderPhonePairScreen("connecting");
  } else {
    renderPhonePairScreen("ready");
  }

  handleSpotifyRedirect()
    .catch((error) => {
      logError("Spotify redirect failed", error);
      renderPhonePairScreen("error", error?.message || "Sign-in failed.");
    })
    .finally(() => {
      // Phone never keeps the token — the TV is the only consumer.
      // Best-effort cleanup so a returning phone visitor doesn't auto-resume as a TV.
      try {
        localStorage.removeItem(storageKeys.accessToken);
        localStorage.removeItem(storageKeys.refreshToken);
        localStorage.removeItem(storageKeys.expiresAt);
        localStorage.removeItem(storageKeys.verifier);
      } catch {}
    });
}

function hydrateUiPreferences() {
  try {
    const savedMode = localStorage.getItem(storageKeys.ambientMode);
    if (savedMode && AMBIENT_MODES.includes(savedMode)) {
      state.ambientMode = savedMode;
    }
    const savedScene = localStorage.getItem(storageKeys.sceneCategory);
    if (savedScene && SCENE_CATEGORIES.includes(savedScene)) {
      state.sceneCategory = savedScene;
    }
    const savedDebug = localStorage.getItem(storageKeys.debugVisible);
    state.debugVisible = savedDebug === "1";
    // Default ON: keep the music going when the queue runs out.
    const savedAutoplay = localStorage.getItem(storageKeys.autoplaySimilar);
    state.autoplaySimilar = savedAutoplay === null ? true : savedAutoplay === "1";
  } catch {
    // localStorage unavailable; defaults already set
  }
  applyDebugVisibility();
  applyAutoplaySimilarState();
  for (const button of document.querySelectorAll("[data-action='setAmbientMode']")) {
    button.classList.toggle("is-active", button.dataset.mode === state.ambientMode);
  }
  reflectSceneCategory();
  elements.ambientControls?.classList.toggle("is-dim", state.ambientMode === "screensaver");
}

function handleClick(event) {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = actions[button.dataset.action];
  if (!action) return;
  // Hand the action the resolved [data-action] element as currentTarget/target.
  // This is a delegated click, so event.target is the deepest child (e.g. the
  // pill's artwork) which carries no data-* attrs — setView/setAmbientMode read
  // their dataset, so a mouse click on a child mis-routed (fell back to "home").
  // The TV path (activeElement.click()) targets the button directly, which is
  // why this only broke in a desktop browser.
  const actionEvent = {
    currentTarget: button,
    target: button,
    originalEvent: event,
    preventDefault: () => event.preventDefault(),
    stopPropagation: () => event.stopPropagation(),
  };
  try {
    const result = action(actionEvent);
    if (result && typeof result.catch === "function") {
      result.catch((error) => logError(`${button.dataset.action} failed`, error));
    }
  } catch (error) {
    logError(`${button.dataset.action} failed`, error);
  }
}

init();
