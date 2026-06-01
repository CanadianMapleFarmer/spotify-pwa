const SPOTIFY_CLIENT_ID = "f090eff2edba4b17a1b0743e4080e755";

const SPOTIFY_SCOPES = [
  "streaming",
  "user-read-email",
  "user-read-private",
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "playlist-read-private",
  "user-library-read",
  "user-top-read",
  "user-read-recently-played",
];

const storageKeys = {
  clientId: "spotify-probe-client-id",
  verifier: "spotify-probe-code-verifier",
  accessToken: "spotify-probe-access-token",
  refreshToken: "spotify-probe-refresh-token",
  expiresAt: "spotify-probe-expires-at",
  pairCode: "spotify-probe-pair-code",
  pairLoginUrl: "spotify-probe-pair-login-url",
  debugVisible: "spotify-pwa.debug-visible",
  ambientMode: "spotify-pwa.ambient-mode",
  sceneCategory: "spotify-pwa.scene-category",
};

const PHONE_MODE_SESSION_KEY = "spotify-pwa.phone-mode";
const PAIR_SESSION_COLLECTION = "pairSessions";
const PAIR_SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes — long enough for a phone OAuth round trip

const AMBIENT_MODES = ["room", "screensaver", "visualizer"];
const AMBIENT_MODE_LABELS = {
  room: "Room Display",
  screensaver: "Scene",
  visualizer: "Visualizer",
};
const BUBBLE_CORNERS = ["bl", "br", "tr", "tl"];

// Screensaver scenery, tried in order. Local files (drop your own loops into
// public/ambient/) win first; the hotlinked city loops are a best-effort
// fallback. If every source fails, the generative drift scene takes over.
const AMBIENT_VIDEOS = [
  "/public/ambient/loop-1.mp4",
  "/public/ambient/loop-2.mp4",
  "/public/ambient/loop-3.mp4",
  "https://assets.mixkit.co/videos/preview/mixkit-aerial-shot-of-a-city-at-night-time-4063-large.mp4",
  "https://assets.mixkit.co/videos/preview/mixkit-night-traffic-in-the-city-4053-large.mp4",
  "https://assets.mixkit.co/videos/preview/mixkit-traffic-in-the-city-during-the-night-4055-large.mp4",
];

// === Pexels long-form Scene scenery ===========================================
// Scene mode prefers fresh, full-length clips from the Pexels video API. The key
// is injected at deploy time into window.__PEXELS_KEY__ (see pexels-config.js);
// it is empty locally and on PR previews, so Scene transparently falls back to
// the bundled AMBIENT_VIDEOS loops. Per Pexels terms we keep clips in memory
// only for the current session — nothing is written to localStorage/disk.
const SCENE_CATEGORIES = ["nature", "skyline"];
const SCENE_CATEGORY_LABELS = { nature: "Nature", skyline: "City" };
// A few queries per category; we pick one at random each fetch so repeat visits
// don't always surface the same page of results.
const SCENE_QUERIES = {
  nature: ["nature landscape", "mountains", "forest", "ocean waves"],
  skyline: ["city skyline night", "city aerial", "cityscape timelapse"],
};
const PEXELS_VIDEO_SEARCH = "https://api.pexels.com/videos/search";
const PEXELS_PER_PAGE = 20;
const PEXELS_MAX_PAGE = 5; // keep paging shallow so results stay relevant
const PEXELS_MAX_RETRIES = 3; // for 429 backoff

const state = {
  focusIndex: 0,
  spotifyPlayer: null,
  spotifyPlayerPromise: null,
  spotifyDeviceId: "",
  spotifyVolume: 0.7,
  pairPollTimer: 0,
  currentView: "home",
  previousView: "home",
  ambientMode: "room",
  nowPlaying: null,
  shuffle: false,
  repeat: "off",
  sceneCategory: "nature",
  scenePlaylist: [], // in-memory list of Pexels mp4 URLs (shuffled)
  scenePlaylistIndex: -1,
  sceneSource: "local", // "pexels" | "local" — which scenery is currently feeding
  sceneActiveVideo: "a", // which A/B element is currently visible
  sceneToken: 0, // bumped on category change / mode exit to cancel stale async work
  sceneFetchInFlight: false,
  progressTimer: 0,
  remoteEvents: [],
  debugVisible: false,
  paletteCache: { url: "", palette: null },
  bubbleCornerIndex: 0,
  bubbleCornerTimer: 0,
  pillDimTimer: 0,
  visualizerRaf: 0,
  visualizerPhase: 0,
  visualizerRect: null,
  visualizerResizeHandler: null,
  collection: null,
  collectionShuffle: false,
  collectionReturnView: "home",
  dataLoaded: false,
  dataLoading: false,
};

const elements = {
  connectionStatus: document.querySelector("#connectionStatus"),
  deviceFacts: document.querySelector("#deviceFacts"),
  keyReadout: document.querySelector("#keyReadout"),
  storageMediaStatus: document.querySelector("#storageMediaStatus"),
  probeAudio: document.querySelector("#probeAudio"),
  clientIdInput: document.querySelector("#clientIdInput"),
  spotifyFacts: document.querySelector("#spotifyFacts"),
  log: document.querySelector("#log"),
  authPanel: document.querySelector("#authPanel"),
  pairCard: document.querySelector("#pairCard"),
  pairQr: document.querySelector("#pairQr"),
  pairCode: document.querySelector("#pairCode"),
  pairUrl: document.querySelector("#pairUrl"),
  deviceStatus: document.querySelector("#deviceStatus"),
  keyStatus: document.querySelector("#keyStatus"),
  newReleasesShelf: document.querySelector("#newReleasesShelf"),
  playlistsHomeShelf: document.querySelector("#playlistsHomeShelf"),
  topShelf: document.querySelector("#topShelf"),
  signedOutHero: document.querySelector("#signedOutHero"),
  homeShelves: document.querySelector("#homeShelves"),
  playlistShelf: document.querySelector("#playlistShelf"),
  libraryAlbumsShelf: document.querySelector("#libraryAlbumsShelf"),
  libraryTracksShelf: document.querySelector("#libraryTracksShelf"),
  devicesGrid: document.querySelector("#devicesGrid"),
  nowArtwork: document.querySelector("#nowArtwork"),
  nowBackdrop: document.querySelector("#nowBackdrop"),
  nowContext: document.querySelector("#nowContext"),
  nowTitle: document.querySelector("#nowTitle"),
  nowArtist: document.querySelector("#nowArtist"),
  progressFill: document.querySelector("#progressFill"),
  positionText: document.querySelector("#positionText"),
  durationText: document.querySelector("#durationText"),
  ambientBg: document.querySelector("#ambientBg"),
  ambientStage: document.querySelector("#ambientStage"),
  ambientModeLabel: document.querySelector("#ambientModeLabel"),
  ambientTitle: document.querySelector("#ambientTitle"),
  ambientSubtitle: document.querySelector("#ambientSubtitle"),
  ambientRoomArt: document.querySelector("#ambientRoomArt"),
  ambientBubble: document.querySelector("#ambientBubble"),
  ambientBubbleTitle: document.querySelector("#ambientBubbleTitle"),
  ambientBubbleArtist: document.querySelector("#ambientBubbleArtist"),
  ambientDriftA: document.querySelector("#ambientDriftA"),
  ambientDriftB: document.querySelector("#ambientDriftB"),
  ambientDriftC: document.querySelector("#ambientDriftC"),
  ambientDriftD: document.querySelector("#ambientDriftD"),
  ambientVisualizerCanvas: document.querySelector("#ambientVisualizerCanvas"),
  ambientVisualizerArt: document.querySelector("#ambientVisualizerArt"),
  ambientScreensaver: document.querySelector("#ambientScreensaver"),
  ambientVideo: document.querySelector("#ambientVideo"),
  ambientVideoB: document.querySelector("#ambientVideoB"),
  ambientSceneControls: document.querySelector("#ambientSceneControls"),
  sceneCategoryBtn: document.querySelector("#sceneCategoryBtn"),
  sceneCategoryLabel: document.querySelector("#sceneCategoryLabel"),
  sceneSkipBtn: document.querySelector("#sceneSkipBtn"),
  ambientControls: document.querySelector("#ambientControls"),
  ambientProgressFill: document.querySelector("#ambientProgressFill"),
  ambientProgressTime: document.querySelector("#ambientProgressTime"),
  toastStack: document.querySelector("#toastStack"),
  npPill: document.querySelector("#npPill"),
  npPillArt: document.querySelector("#npPillArt"),
  npPillTitle: document.querySelector("#npPillTitle"),
  npPillArtist: document.querySelector("#npPillArtist"),
  npPillProgressFill: document.querySelector("#npPillProgressFill"),
  npPillTime: document.querySelector("#npPillTime"),
  npPillPlayBtn: document.querySelector("#npPillPlayBtn"),
  collectionBackdrop: document.querySelector("#collectionBackdrop"),
  collectionArt: document.querySelector("#collectionArt"),
  collectionKind: document.querySelector("#collectionKind"),
  collectionTitle: document.querySelector("#collectionTitle"),
  collectionMeta: document.querySelector("#collectionMeta"),
  collectionShuffleBtn: document.querySelector("#collectionShuffleBtn"),
  collectionTracks: document.querySelector("#collectionTracks"),
  diagnostics: document.querySelector("#diagnostics"),
  toggleDebugView: document.querySelector("#toggleDebugView"),
  toggleDebugState: document.querySelector("#toggleDebugState"),
  viewAmbient: document.querySelector("#view-ambient"),
  phonePairScreen: document.querySelector("#phonePairScreen"),
  phonePairCode: document.querySelector("#phonePairCode"),
  phonePairErrorMessage: document.querySelector("#phonePairErrorMessage"),
  phonePairSuccessMessage: document.querySelector("#phonePairSuccessMessage"),
};

const actions = {
  setView,
  goToSettings,
  runDeviceChecks,
  refreshAll,
  loadLibrary,
  loadDevices,
  setAmbientMode,
  toggleSceneCategory,
  skipSceneClip,
  playCollection,
  toggleCollectionShuffle,
  collectionBack,
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

  hydrateUiPreferences();
  registerServiceWorker();
  runDeviceChecks();
  renderPairInfo();
  renderShellState();
  renderNpPill();
  renderTransportState();
  renderAmbient();
  startProgressTimer();
  startBubbleCornerTimer();
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

async function bootstrapData(reason) {
  if (state.dataLoading || state.dataLoaded) return;
  const signedIn = Boolean(getStoredAccessToken() || localStorage.getItem(storageKeys.refreshToken));
  if (!signedIn) {
    markShelvesSignedOut();
    return;
  }
  state.dataLoading = true;
  markShelvesLoading();
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await ensureAccessToken();
      await loadHome();
      // Library/devices/playback are best-effort; never block the home render.
      loadLibrary().catch((error) => logError("Library load failed", error));
      loadDevices().catch(() => {});
      getCurrentPlayback().catch((error) => logError("Playback sync failed", error));
      state.dataLoaded = true;
      state.dataLoading = false;
      log(`Initial data loaded (${reason}).`, "success");
      return;
    } catch (error) {
      lastError = error;
      logError(`Data load attempt ${attempt}/3 failed`, error);
      await new Promise((resolve) => setTimeout(resolve, attempt * 700));
    }
  }
  state.dataLoading = false;
  markShelvesError(lastError);
  showToast(`Couldn't load your music: ${lastError?.message || "unknown error"}. Try Refresh.`, "error");
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
  } catch {
    // localStorage unavailable; defaults already set
  }
  applyDebugVisibility();
  for (const button of document.querySelectorAll("[data-action='setAmbientMode']")) {
    button.classList.toggle("is-active", button.dataset.mode === state.ambientMode);
  }
  reflectSceneCategory();
  elements.ambientControls?.classList.toggle("is-dim", state.ambientMode === "screensaver");
}

function focusableElements() {
  return activeFocusables();
}

// Scope the focus pool to the chrome (nav) + the active view + the now-playing pill.
// This stops "down"/"right" from teleporting into an off-screen view's controls.
function activeFocusables() {
  const roots = [];
  const nav = document.querySelector(".nav");
  if (nav) roots.push(nav);
  const activeView = document.getElementById(`view-${state.currentView}`);
  if (activeView) roots.push(activeView);
  const pill = document.getElementById("npPill");
  if (pill) roots.push(pill);

  const seen = new Set();
  const result = [];
  for (const root of roots) {
    const matches = root.matches?.(".focusable:not([disabled])") ? [root] : [];
    for (const el of matches.concat(Array.from(root.querySelectorAll(".focusable:not([disabled])")))) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (isVisibleElement(el)) result.push(el);
    }
  }
  return result;
}

// Overlap length of two 1D segments; positive means they share span on that axis.
function overlap1D(aStart, aEnd, bStart, bEnd) {
  return Math.min(aEnd, bEnd) - Math.max(aStart, bStart);
}

function isVisibleElement(element) {
  if (!element || element.hidden || element.closest("[hidden]")) return false;
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function getElementCenter(element) {
  const rect = element.getBoundingClientRect();
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
}

function focusFirst() {
  const focusables = focusableElements();
  if (!focusables.length) return;
  state.focusIndex = 0;
  focusElement(focusables[state.focusIndex]);
}

function focusElement(element) {
  if (!element) return;
  const focusables = focusableElements();
  state.focusIndex = Math.max(0, focusables.indexOf(element));
  element.focus();
  keepElementVisible(element);
}

function keepElementVisible(element) {
  const rail = element.closest(".rail");
  if (rail) {
    const railRect = rail.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    let nextLeft = rail.scrollLeft;
    if (elementRect.left < railRect.left + 18) {
      nextLeft += elementRect.left - railRect.left - 18;
    } else if (elementRect.right > railRect.right - 18) {
      nextLeft += elementRect.right - railRect.right + 18;
    }
    if (nextLeft !== rail.scrollLeft) {
      try {
        rail.scrollTo({ left: Math.max(0, nextLeft), behavior: "smooth" });
      } catch {
        rail.scrollLeft = Math.max(0, nextLeft);
      }
    }
    try {
      rail.closest(".shelf")?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    } catch {
      rail.closest(".shelf")?.scrollIntoView();
    }
    return;
  }

  try {
    element.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  } catch {
    element.scrollIntoView();
  }
}

function moveRailFocus(direction) {
  const active = document.activeElement?.matches?.(".focusable") ? document.activeElement : null;
  const rail = active?.closest?.(".rail");
  if (!rail || (direction !== "left" && direction !== "right")) return false;

  const items = Array.from(rail.querySelectorAll(".focusable:not([disabled])")).filter(isVisibleElement);
  const index = items.indexOf(active);
  if (index === -1) return false;

  const nextIndex = direction === "right" ? index + 1 : index - 1;
  if (nextIndex < 0 || nextIndex >= items.length) return false;
  focusElement(items[nextIndex]);
  return true;
}

function moveFocus(delta) {
  const focusables = focusableElements();
  if (!focusables.length) return;
  state.focusIndex = Math.max(0, Math.min(focusables.length - 1, state.focusIndex + delta));
  focusElement(focusables[state.focusIndex]);
}

function moveFocusDirectional(direction) {
  const focusables = focusableElements();
  if (!focusables.length) return;

  const active = document.activeElement?.matches?.(".focusable") ? document.activeElement : focusables[state.focusIndex];
  if (!active || !isVisibleElement(active)) {
    focusElement(focusables[0]);
    return;
  }

  const a = active.getBoundingClientRect();
  const horizontal = direction === "left" || direction === "right";

  const candidates = focusables
    .filter((element) => element !== active)
    .map((element) => {
      const r = element.getBoundingClientRect();
      // "ahead" = edge-to-edge gap in the travel direction; must clear the active box.
      let ahead;
      if (direction === "right") ahead = r.left - a.right;
      else if (direction === "left") ahead = a.left - r.right;
      else if (direction === "down") ahead = r.top - a.bottom;
      else ahead = a.top - r.bottom;
      // Require the candidate to genuinely lie ahead (allow slight overlap of edges).
      if (ahead < -Math.min(a.width, a.height) * 0.5) return null;
      const aheadDist = Math.max(0, ahead);

      // Cross-axis overlap: prefer candidates that share span on the perpendicular axis.
      const overlap = horizontal
        ? overlap1D(a.top, a.bottom, r.top, r.bottom)
        : overlap1D(a.left, a.right, r.left, r.right);
      // Negative overlap means a gap; turn it into a penalty distance.
      const offAxisGap = overlap > 0 ? 0 : -overlap;
      // Overlapping candidates win decisively; otherwise fall back to nearest by gap.
      const score = aheadDist + offAxisGap * 3 + (overlap > 0 ? 0 : 1000);
      return { element, score, overlap };
    })
    .filter(Boolean)
    .sort((x, y) => x.score - y.score);

  // No-wrap: if nothing lies ahead in this direction, stay put at the edge.
  if (candidates.length) {
    focusElement(candidates[0].element);
  }
}

function handleRemoteEvent(event) {
  const normalized = normalizeRemoteKey(event);
  logRemoteEvent(event, normalized);
  if (event.type !== "keydown") return;

  switch (normalized) {
    case "ArrowRight":
      event.preventDefault();
      if (handleAmbientModeArrow("right")) break;
      if (!moveRailFocus("right")) moveFocusDirectional("right");
      break;
    case "ArrowDown":
      event.preventDefault();
      moveFocusDirectional("down");
      break;
    case "ArrowLeft":
      event.preventDefault();
      if (handleAmbientModeArrow("left")) break;
      if (!moveRailFocus("left")) moveFocusDirectional("left");
      break;
    case "ArrowUp":
      event.preventDefault();
      moveFocusDirectional("up");
      break;
    case "Enter":
    case "Space":
      if (document.activeElement?.matches("button")) {
        event.preventDefault();
        document.activeElement.click();
      }
      break;
    case "Back":
      event.preventDefault();
      handleBack();
      break;
    case "MediaPlayPause":
      event.preventDefault();
      toggleSpotifyPlayback().catch((error) => logError("MediaPlayPause failed", error));
      break;
    case "MediaNextTrack":
      event.preventDefault();
      nextTrack().catch((error) => logError("MediaNextTrack failed", error));
      break;
    case "MediaPreviousTrack":
      event.preventDefault();
      previousTrack().catch((error) => logError("MediaPreviousTrack failed", error));
      break;
    case "MediaStop":
      event.preventDefault();
      toggleSpotifyPlayback().catch((error) => logError("MediaStop pause failed", error));
      break;
    case "VolumeUp":
      event.preventDefault();
      changeSpotifyVolume(0.1).catch((error) => logError("VolumeUp failed", error));
      break;
    case "VolumeDown":
      event.preventDefault();
      changeSpotifyVolume(-0.1).catch((error) => logError("VolumeDown failed", error));
      break;
    case "VolumeMute":
      event.preventDefault();
      log("Volume mute key observed. Spotify Web Playback SDK does not expose mute directly.");
      break;
    case "ChannelUp":
      event.preventDefault();
      pageScroll(-1);
      break;
    case "ChannelDown":
      event.preventDefault();
      pageScroll(1);
      break;
  }
}

function normalizeRemoteKey(event) {
  const keyCode = event.keyCode || event.which;
  const codeMap = {
    8: "Back",
    13: "Enter",
    19: "MediaPlayPause",
    27: "Back",
    32: "Space",
    37: "ArrowLeft",
    38: "ArrowUp",
    39: "ArrowRight",
    40: "ArrowDown",
    166: "Back",
    179: "MediaPlayPause",
    403: "ColorRed",
    404: "ColorGreen",
    405: "ColorYellow",
    406: "ColorBlue",
    412: "MediaPreviousTrack",
    413: "MediaStop",
    415: "MediaPlayPause",
    417: "MediaNextTrack",
    427: "ChannelUp",
    428: "ChannelDown",
    447: "VolumeUp",
    448: "VolumeDown",
    449: "VolumeMute",
    461: "Back",
  };
  if (codeMap[keyCode]) return codeMap[keyCode];
  if (event.key === " ") return "Space";
  if (event.key === "Escape" || event.key === "BrowserBack" || event.key === "Backspace") return "Back";
  return event.key || event.code || `keyCode:${keyCode}`;
}

function pageScroll(direction) {
  const distance = Math.round(window.innerHeight * 0.78) * direction;
  window.scrollBy({ top: distance, behavior: "smooth" });
  log(`Channel scroll ${direction > 0 ? "down" : "up"} by ${Math.abs(distance)}px.`);
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
  if (event.type === "keydown") {
    log(`Remote key: ${JSON.stringify(payload)}`);
  }
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

async function refreshAll() {
  requireAccessToken();
  state.dataLoaded = false;
  await bootstrapData("manual refresh");
  log("Spotify app data refreshed.", "success");
}

async function loadHome() {
  requireAccessToken();
  toggleSignedOutHero(false);
  const results = await Promise.allSettled([
    spotifyApiJson("/v1/me/playlists?limit=50"),
    spotifyApiJson("/v1/me/top/tracks?limit=18&time_range=medium_term"),
    spotifyApiJson("/v1/browse/new-releases?limit=18"),
  ]);
  // Total failure (every endpoint rejected) signals a transient token/network
  // problem — throw so bootstrapData can retry instead of painting empty shelves.
  if (results.every((result) => result.status === "rejected")) {
    throw results[0].reason || new Error("Home data requests all failed.");
  }
  const [playlists, top, newReleases] = results;
  const { own } = splitPlaylists(playlists.value?.items || []);
  renderShelf(elements.playlistsHomeShelf, "Your Playlists", own.slice(0, 18), "playlist", {
    hideIfEmpty: true,
  });
  renderShelf(elements.topShelf, "On Repeat For You", top.value?.items || [], "track", {
    hideIfEmpty: true,
  });
  // Spotify deprecated /recommendations + /browse/featured-playlists, and this
  // account follows no owner:spotify mixes, so "New Releases" is the live source
  // for fresh discovery — kept below the user's familiar shelves.
  renderShelf(elements.newReleasesShelf, "New Releases", newReleases.value?.albums?.items || [], "album", {
    hideIfEmpty: true,
  });
}

// Spotify's first-party mixes carry owner.id === "spotify" and are excluded so
// the playlist shelves only show the user's own/followed playlists.
function splitPlaylists(items) {
  const own = (items || []).filter(Boolean).filter((playlist) => {
    const ownerId = (playlist.owner?.id || "").toLowerCase();
    const ownerName = (playlist.owner?.display_name || "").toLowerCase();
    return ownerId !== "spotify" && ownerName !== "spotify";
  });
  return { own };
}

function goToSettings() {
  setView("settings");
}

function toggleSignedOutHero(show) {
  if (elements.signedOutHero) elements.signedOutHero.hidden = !show;
  if (elements.homeShelves) elements.homeShelves.hidden = Boolean(show);
}

const HOME_SHELVES = [
  ["playlistsHomeShelf", "Your Playlists"],
  ["topShelf", "On Repeat For You"],
  ["newReleasesShelf", "New Releases"],
];

function markShelvesLoading() {
  toggleSignedOutHero(false);
  for (const [key, title] of HOME_SHELVES) {
    shelfPlaceholder(elements[key], title, "loading", "Loading…");
  }
}

function markShelvesSignedOut() {
  toggleSignedOutHero(true);
}

function markShelvesError(error) {
  toggleSignedOutHero(false);
  const message = `Couldn't load (${error?.message || "error"}).`;
  for (const [key, title] of HOME_SHELVES) {
    shelfPlaceholder(elements[key], title, "error", message, true);
  }
}

function shelfPlaceholder(container, title, kind, message, withRetry) {
  if (!container) return;
  container.replaceChildren();
  const heading = document.createElement("h3");
  heading.textContent = title;
  const rail = document.createElement("div");
  rail.className = "rail";
  const note = document.createElement("div");
  note.className = `card card--placeholder card--${kind}`;
  note.textContent = message;
  rail.append(note);
  if (withRetry) {
    const retry = document.createElement("button");
    retry.className = "focusable card card--retry";
    retry.dataset.action = "refreshAll";
    retry.textContent = "Retry";
    rail.append(retry);
  }
  container.append(heading, rail);
}

async function loadLibrary() {
  requireAccessToken();
  const [playlists, albums, tracks] = await Promise.all([
    spotifyApiJson("/v1/me/playlists?limit=50"),
    spotifyApiJson("/v1/me/albums?limit=24"),
    spotifyApiJson("/v1/me/tracks?limit=24"),
  ]);
  const { own } = splitPlaylists(playlists.items || []);
  renderShelf(elements.playlistShelf, "Your Playlists", own, "playlist");
  renderShelf(elements.libraryAlbumsShelf, "Albums", (albums.items || []).map((item) => item.album), "album");
  renderShelf(elements.libraryTracksShelf, "Saved Tracks", (tracks.items || []).map((item) => item.track), "track");
}

async function loadDevices() {
  requireAccessToken();
  const data = await spotifyApiJson("/v1/me/player/devices");
  elements.devicesGrid.replaceChildren();
  for (const device of data.devices || []) {
    const button = document.createElement("button");
    button.className = "focusable device-card";
    button.dataset.deviceId = device.id || "";
    button.innerHTML = `<strong>${escapeHtml(device.name)}</strong><span>${escapeHtml(device.type)}${device.is_active ? " - active" : ""}</span>`;
    button.addEventListener("click", () => transferToDevice(device.id));
    elements.devicesGrid.append(button);
  }
  if (!elements.devicesGrid.children.length) {
    elements.devicesGrid.append(emptyState("No Spotify Connect devices found."));
  }
}

function renderShelf(container, title, items, type, { hideIfEmpty = false } = {}) {
  if (!container) return;
  container.replaceChildren();
  const visible = (items || []).filter(Boolean);
  // Discovery shelves collapse when empty so Home never shows a lonely
  // "Nothing to show yet" under a heading.
  if (hideIfEmpty && !visible.length) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  const heading = document.createElement("h3");
  heading.textContent = title;
  const rail = document.createElement("div");
  rail.className = "rail";
  rail.setAttribute("role", "list");
  rail.setAttribute("aria-label", title);
  for (const item of visible) {
    rail.append(createMediaCard(item, type));
  }
  if (!rail.children.length) {
    rail.append(emptyState("Nothing to show yet."));
  }
  container.append(heading, rail);
}

function createMediaCard(item, type) {
  const button = document.createElement("button");
  button.className = "focusable card";
  button.setAttribute("role", "listitem");
  const image = getImage(item);
  const subtitle = type === "playlist"
    ? `${item.tracks?.total || 0} tracks`
    : type === "album"
      ? `${item.album_type || "album"} - ${(item.artists || []).map((artist) => artist.name).join(", ")}`
    : (item.artists || []).map((artist) => artist.name).join(", ");
  button.innerHTML = `
    <img src="${escapeAttribute(image)}" alt="">
    <span class="card-title">${escapeHtml(item.name || "Untitled")}</span>
    <span class="card-subtitle">${escapeHtml(subtitle || type)}</span>
  `;
  // A single track plays immediately; a collection opens its detail screen so the
  // user can browse tracks and choose shuffle vs. sequential before playing.
  if (type === "album" || type === "playlist") {
    button.addEventListener("click", () => openCollection(item, type));
  } else {
    button.addEventListener("click", () => playItem(item, type));
  }
  return button;
}

async function playItem(item, type) {
  requireAccessToken();
  await ensureSpotifyDeviceReady();
  const body = (type === "playlist" || type === "album")
    ? { context_uri: item.uri }
    : { uris: [item.uri] };
  const response = await spotifyApiFetch(withDeviceIdParam("/v1/me/player/play"), {
    method: "PUT",
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await readSpotifyError(response);
    throw new Error(`Spotify play failed (${response.status}): ${detail}`);
  }
  log(`Requested playback: ${item.name}`, "success");
  await getCurrentPlayback();
}

async function openCollection(item, type) {
  requireAccessToken();
  if (state.currentView !== "collection") {
    state.collectionReturnView = state.currentView;
  }
  const totalKnown = type === "playlist" ? item.tracks?.total : item.total_tracks;
  state.collection = {
    type,
    id: item.id,
    contextUri: item.uri,
    title: item.name || "Untitled",
    image: getImage(item),
    byline: type === "playlist"
      ? (item.owner?.display_name ? `By ${item.owner.display_name}` : "Playlist")
      : (item.artists || []).map((artist) => artist.name).join(", "),
    totalKnown: Number.isFinite(totalKnown) ? totalKnown : null,
    tracks: [],
    loading: true,
    error: "",
  };
  setView("collection");
  renderCollection();
  focusElement(elements.collectionShuffleBtn);
  try {
    state.collection.tracks = await fetchCollectionTracks(item, type);
  } catch (error) {
    state.collection.error = error?.message || "Couldn't load tracks.";
    logError("Collection load failed", error);
  } finally {
    state.collection.loading = false;
    renderCollection();
  }
}

async function fetchCollectionTracks(item, type) {
  if (type === "album") {
    const data = await spotifyApiJson(`/v1/albums/${item.id}/tracks?limit=50`);
    return (data?.items || []).map((track) => normalizeCollectionTrack(track));
  }
  const data = await spotifyApiJson(`/v1/playlists/${item.id}/items?limit=50`);
  return (data?.items || [])
    .map((entry) => entry.item ?? entry.track)
    .filter((track) => track && track.uri)
    .map((track) => normalizeCollectionTrack(track));
}

function normalizeCollectionTrack(track) {
  return {
    uri: track.uri || "",
    id: track.id || "",
    name: track.name || "Untitled",
    artist: (track.artists || []).map((artist) => artist.name).join(", "),
    duration: track.duration_ms || 0,
  };
}

function renderCollection() {
  const coll = state.collection;
  if (!coll || !elements.collectionTracks) return;

  if (elements.collectionBackdrop) {
    elements.collectionBackdrop.style.backgroundImage = coll.image ? `url("${coll.image}")` : "";
  }
  if (elements.collectionArt) {
    if (coll.image) elements.collectionArt.src = coll.image;
    else elements.collectionArt.removeAttribute("src");
  }
  if (elements.collectionKind) {
    elements.collectionKind.textContent = coll.type === "playlist" ? "Playlist" : "Album";
  }
  if (elements.collectionTitle) elements.collectionTitle.textContent = coll.title;
  if (elements.collectionMeta) {
    const count = coll.tracks.length || coll.totalKnown || 0;
    const countText = count ? `${count} song${count === 1 ? "" : "s"}` : "";
    elements.collectionMeta.textContent = [coll.byline, countText].filter(Boolean).join(" · ");
  }
  updateCollectionShuffleBtn();

  const list = elements.collectionTracks;
  list.replaceChildren();

  if (coll.loading) {
    const note = document.createElement("p");
    note.className = "collection-note";
    note.textContent = "Loading tracks…";
    list.append(note);
    return;
  }
  if (coll.error) {
    const note = document.createElement("p");
    note.className = "collection-note collection-note--error";
    note.textContent = coll.error;
    list.append(note);
    return;
  }
  if (!coll.tracks.length) {
    const note = document.createElement("p");
    note.className = "collection-note";
    note.textContent = "No tracks here.";
    list.append(note);
    return;
  }

  coll.tracks.forEach((track, index) => {
    const row = document.createElement("button");
    row.className = "focusable collection-track";
    row.dataset.uri = track.uri;
    row.innerHTML = `
      <span class="collection-track__index">
        <span class="collection-track__num">${index + 1}</span>
        <span class="collection-track__eq" aria-hidden="true"><i></i><i></i><i></i></span>
      </span>
      <span class="collection-track__body">
        <span class="collection-track__title">${escapeHtml(track.name)}</span>
        <span class="collection-track__artist">${escapeHtml(track.artist)}</span>
      </span>
      <span class="collection-track__time">${formatDuration(track.duration)}</span>
    `;
    row.addEventListener("click", () => {
      startCollectionPlayback({ offsetUri: track.uri }).catch((error) =>
        logError("Collection track play failed", error)
      );
    });
    list.append(row);
  });
  renderCollectionPlayingState();
}

function renderCollectionPlayingState() {
  if (!elements.collectionTracks) return;
  const now = state.nowPlaying;
  const rows = elements.collectionTracks.querySelectorAll(".collection-track");
  rows.forEach((row) => {
    const match = Boolean(now) && now.uri && row.dataset.uri === now.uri;
    row.classList.toggle("is-playing", match);
    row.classList.toggle("is-paused", match && Boolean(now?.paused));
  });
}

function updateCollectionShuffleBtn() {
  const btn = elements.collectionShuffleBtn;
  if (!btn) return;
  btn.classList.toggle("is-active", state.collectionShuffle);
  btn.setAttribute("aria-pressed", state.collectionShuffle ? "true" : "false");
  const label = btn.querySelector(".collection-shuffle__state");
  if (label) label.textContent = state.collectionShuffle ? "On" : "Off";
}

function toggleCollectionShuffle() {
  state.collectionShuffle = !state.collectionShuffle;
  updateCollectionShuffleBtn();
  log(`Collection shuffle ${state.collectionShuffle ? "on" : "off"}.`);
}

function playCollection() {
  return startCollectionPlayback({});
}

async function startCollectionPlayback({ offsetUri } = {}) {
  const coll = state.collection;
  if (!coll?.contextUri) {
    showToast("Nothing to play here.", "error");
    return;
  }
  requireAccessToken();
  await ensureSpotifyDeviceReady();

  const body = { context_uri: coll.contextUri };
  if (offsetUri) body.offset = { uri: offsetUri };
  const response = await spotifyApiFetch(withDeviceIdParam("/v1/me/player/play"), {
    method: "PUT",
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Spotify play failed (${response.status}): ${await readSpotifyError(response)}`);
  }

  // Apply the collection's shuffle choice after the device is active. When shuffling
  // the whole collection (no specific track), skip once so it doesn't always open on
  // track 1.
  try {
    await setShuffleState(state.collectionShuffle);
    if (state.collectionShuffle && !offsetUri) {
      await spotifyApiFetch(withDeviceIdParam("/v1/me/player/next"), { method: "POST" });
    }
  } catch (error) {
    logError("Applying shuffle after collection play failed", error);
  }

  log(`Playing ${coll.title}${offsetUri ? " from selected track" : ""} (shuffle ${state.collectionShuffle ? "on" : "off"}).`, "success");
  window.setTimeout(() => getCurrentPlayback().catch((error) => logError("Playback refresh failed", error)), 700);
}

async function setShuffleState(value) {
  const response = await spotifyApiFetch(withDeviceIdParam(`/v1/me/player/shuffle?state=${value}`), { method: "PUT" });
  if (response.ok) {
    state.shuffle = value;
    renderTransportState();
  }
}

function collectionBack() {
  setView(state.collectionReturnView || "home");
}

function handleBack() {
  if (state.currentView === "collection") {
    collectionBack();
    log("Back: returned to collection source.");
    return;
  }
  if (state.currentView === "now" || state.currentView === "ambient") {
    const target = state.previousView && state.previousView !== state.currentView ? state.previousView : "home";
    setView(target);
    log(`Back: returned to ${target}.`);
    return;
  }
  setView("home");
  log("Back key observed. Returned to Home.");
}

function withDeviceIdParam(path) {
  if (!state.spotifyDeviceId) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}device_id=${encodeURIComponent(state.spotifyDeviceId)}`;
}

async function ensureSpotifyDeviceReady() {
  if (state.spotifyDeviceId && state.spotifyPlayer) return state.spotifyDeviceId;
  try {
    return await createSpotifyPlayer();
  } catch (error) {
    throw new Error(`TV player not ready: ${error?.message || error}`);
  }
}

async function readSpotifyError(response) {
  try {
    const text = await response.text();
    if (!text) return "no body";
    try {
      const parsed = JSON.parse(text);
      return parsed?.error?.message || parsed?.error?.reason || text.slice(0, 200);
    } catch {
      return text.slice(0, 200);
    }
  } catch {
    return "unreadable body";
  }
}

function clearKeys() {
  if (elements.keyReadout) elements.keyReadout.textContent = "Waiting for key event";
  state.remoteEvents = [];
  log("Key readout cleared.");
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
  for (const section of document.querySelectorAll(".view")) {
    section.classList.toggle("is-visible", section.id === `view-${nextView}`);
  }
  for (const button of document.querySelectorAll(".nav-item")) {
    button.classList.toggle("is-active", button.dataset.view === nextView);
  }
  renderNpPill();
  if (nextView === "ambient") {
    startVisualizerIfNeeded();
  } else {
    stopVisualizer();
  }
  syncAmbientVideo();
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
  syncAmbientVideo();
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

function saveClientId() {
  localStorage.setItem(storageKeys.clientId, SPOTIFY_CLIENT_ID);
  log("Spotify Client ID is built into this TV app.", "success");
  renderSpotifyFacts();
}

async function loginSpotify() {
  const clientId = getClientId();
  const pairCode = getPairCode();
  const verifier = generateCodeVerifier();
  const challenge = await createCodeChallenge(verifier);
  localStorage.setItem(storageKeys.verifier, verifier);

  const authUrl = new URL("https://accounts.spotify.com/authorize");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", spotifyRedirectUri());
  authUrl.searchParams.set("scope", SPOTIFY_SCOPES.join(" "));
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("code_challenge", challenge);
  if (pairCode) {
    authUrl.searchParams.set("state", pairCode);
  }
  log("Redirecting to Spotify Accounts.");
  location.assign(authUrl.toString());
}

function createPairLogin() {
  const clientId = getClientId();
  const pairCode = generatePairCode();
  const loginUrl = new URL(location.origin + location.pathname);
  loginUrl.searchParams.set("pair", pairCode);
  loginUrl.searchParams.set("phone", "1");
  localStorage.setItem(storageKeys.pairCode, pairCode);
  localStorage.setItem(storageKeys.pairLoginUrl, loginUrl.toString());
  localStorage.setItem(storageKeys.clientId, clientId);
  log(`Pair login created. Code=${pairCode} URL=${loginUrl.toString()}`, "success");
  startPairPolling();
  renderPairInfo();
  renderSpotifyFacts();
}

async function checkPairToken() {
  const pairCode = getPairCode();
  if (!pairCode) throw new Error("Create a pair login first.");

  const db = await getFirestoreOrNull();
  if (!db) {
    // Firestore not available — stay quiet rather than crash polling.
    return false;
  }

  let snap;
  try {
    snap = await db.collection(PAIR_SESSION_COLLECTION).doc(pairCode).get();
  } catch (error) {
    if (error?.code === "permission-denied") {
      throw new Error("Pair session lookup denied. Check Firestore rules for pairSessions.");
    }
    throw error;
  }
  if (!snap.exists) {
    log(`Pair token not ready for ${pairCode}.`);
    return false;
  }
  const session = snap.data() || {};
  const expireAt = session.expireAt?.toDate ? session.expireAt.toDate() : null;
  if (expireAt && expireAt.getTime() < Date.now()) {
    log(`Pair session expired for ${pairCode}.`);
    await snap.ref.delete().catch(() => {});
    return false;
  }

  localStorage.setItem(storageKeys.accessToken, session.accessToken);
  if (session.refreshToken) localStorage.setItem(storageKeys.refreshToken, session.refreshToken);
  const tokenExpiresAtMs = session.expiresAt?.toDate
    ? session.expiresAt.toDate().getTime()
    : (typeof session.expiresAt === "number" ? session.expiresAt : Date.now() + 3600000);
  localStorage.setItem(storageKeys.expiresAt, String(tokenExpiresAtMs));

  // One-shot: consume and delete so the credentials don't linger.
  await snap.ref.delete().catch((error) => log(`Pair session cleanup failed: ${error.message}`));

  elements.connectionStatus.textContent = "Signed in via pair";
  log(`Pair token received for ${pairCode}.`, "success");
  stopPairPolling();
  renderSpotifyFacts();
  scheduleSpotifyPlayerCreation("pair login");
  await refreshAll();
  return true;
}

function startPairPolling() {
  stopPairPolling();
  state.pairPollTimer = window.setInterval(() => {
    checkPairToken().catch((error) => logError("Pair polling failed", error));
  }, 5000);
  log("Pair polling started.");
}

function stopPairPolling() {
  if (state.pairPollTimer) {
    window.clearInterval(state.pairPollTimer);
    state.pairPollTimer = 0;
  }
}

async function handleSpotifyRedirect() {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  const error = params.get("error");
  const pairCode = normalizePairCode(params.get("state") || localStorage.getItem(storageKeys.pairCode));
  log(`Spotify redirect check: code=${code ? "present" : "missing"} error=${error || "none"}`);
  if (error) {
    history.replaceState({}, "", location.pathname);
    throw new Error(`Spotify returned ${error}`);
  }
  if (!code) {
    renderSpotifyFacts();
    return;
  }

  const clientId = getClientId();
  const verifier = localStorage.getItem(storageKeys.verifier);
  if (!verifier) throw new Error("Missing PKCE verifier from localStorage.");

  const body = new URLSearchParams();
  body.set("client_id", clientId);
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("redirect_uri", spotifyRedirectUri());
  body.set("code_verifier", verifier);

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status}`);
  }

  const token = await response.json();
  const expiresAt = Date.now() + token.expires_in * 1000;
  localStorage.setItem(storageKeys.accessToken, token.access_token);
  if (token.refresh_token) localStorage.setItem(storageKeys.refreshToken, token.refresh_token);
  localStorage.setItem(storageKeys.expiresAt, String(expiresAt));

  const isPhonePair = document.body.classList.contains("is-phone-pair");
  let pairDeliveryError = null;
  if (pairCode) {
    try {
      await postPairToken(pairCode, token.access_token, token.refresh_token || "", expiresAt);
    } catch (deliveryError) {
      pairDeliveryError = deliveryError;
      logError("Pair token delivery failed", deliveryError);
    }
  }
  history.replaceState({}, "", location.pathname);
  if (elements.connectionStatus) elements.connectionStatus.textContent = "Signed in";
  log("Spotify token exchange completed.", "success");
  renderSpotifyFacts();

  if (isPhonePair) {
    if (pairDeliveryError) {
      renderPhonePairScreen("error", pairDeliveryError.message);
    } else if (pairCode) {
      renderPhonePairScreen("success");
    } else {
      renderPhonePairScreen("success", "You're signed in.");
    }
    return;
  }

  scheduleSpotifyPlayerCreation("redirect login");
  await refreshAll();
}

async function postPairToken(pairCode, accessToken, refreshToken, expiresAt) {
  const db = await getFirestoreOrNull();
  if (!db) {
    throw new Error("Pair backend not ready. Refresh the page and try again.");
  }
  const fbNs = window.firebase;
  const TimestampCtor = fbNs?.firestore?.Timestamp;
  const toTimestamp = (ms) => TimestampCtor ? TimestampCtor.fromDate(new Date(ms)) : new Date(ms);
  const expireAtMs = Date.now() + PAIR_SESSION_TTL_MS;

  try {
    await db.collection(PAIR_SESSION_COLLECTION).doc(pairCode).set({
      accessToken,
      refreshToken: refreshToken || "",
      expiresAt: toTimestamp(expiresAt),
      createdAt: toTimestamp(Date.now()),
      expireAt: toTimestamp(expireAtMs),
    });
  } catch (error) {
    if (error?.code === "permission-denied") {
      throw new Error("Pair session write denied. Firestore rules need to allow create on pairSessions.");
    }
    if (error?.code === "unavailable" || error?.message?.includes("offline")) {
      throw new Error("Pair backend not reachable (offline). Check your phone's connection and retry.");
    }
    throw new Error(`Pair token delivery failed: ${error?.message || error}`);
  }
  log(`Pair token posted for ${pairCode}.`, "success");
}

let firestoreReadyPromise = null;
function getFirestoreOrNull() {
  if (firestoreReadyPromise) return firestoreReadyPromise;
  firestoreReadyPromise = (async () => {
    const start = Date.now();
    while (!(window.firebase && typeof window.firebase.firestore === "function")) {
      if (Date.now() - start > 6000) return null;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    try {
      return window.firebase.firestore();
    } catch {
      return null;
    }
  })();
  return firestoreReadyPromise;
}

async function loadSpotifySdk() {
  if (window.Spotify?.Player) {
    window.dispatchEvent(new Event("spotifySdkReady"));
    return;
  }

  await new Promise((resolve, reject) => {
    window.onSpotifyWebPlaybackSDKReady = () => {
      window.dispatchEvent(new Event("spotifySdkReady"));
      resolve();
    };
    const script = document.createElement("script");
    script.src = "https://sdk.scdn.co/spotify-player.js";
    script.async = true;
    script.onerror = () => reject(new Error("Could not load Spotify SDK script."));
    document.head.appendChild(script);
  });
}

function scheduleSpotifyPlayerCreation(reason) {
  if (!getStoredAccessToken() && !localStorage.getItem(storageKeys.refreshToken)) return;
  window.setTimeout(() => {
    createSpotifyPlayer().catch((error) => logError(`Auto player creation failed after ${reason}`, error));
  }, 600);
}

async function createSpotifyPlayer() {
  if (state.spotifyDeviceId && state.spotifyPlayer) return state.spotifyDeviceId;
  if (state.spotifyPlayerPromise) return state.spotifyPlayerPromise;

  state.spotifyPlayerPromise = createSpotifyPlayerInternal()
    .catch((error) => {
      state.spotifyPlayer?.disconnect?.();
      state.spotifyPlayer = null;
      state.spotifyDeviceId = "";
      throw error;
    })
    .finally(() => {
      state.spotifyPlayerPromise = null;
      renderSpotifyFacts();
    });

  return state.spotifyPlayerPromise;
}

async function createSpotifyPlayerInternal() {
  await ensureAccessToken();
  await loadSpotifySdk();

  if (state.spotifyPlayer) {
    state.spotifyPlayer.disconnect();
    state.spotifyPlayer = null;
    state.spotifyDeviceId = "";
  }

  state.spotifyPlayer = new window.Spotify.Player({
    name: "Spotify TV",
    getOAuthToken: (callback) => {
      ensureAccessToken()
        .then((token) => callback(token))
        .catch((error) => logError("Spotify SDK token refresh failed", error));
    },
    volume: state.spotifyVolume,
  });

  state.spotifyPlayer.addListener("ready", ({ device_id }) => {
    state.spotifyDeviceId = device_id;
    elements.deviceStatus.textContent = `TV player ready`;
    log(`Spotify player ready. Device ID: ${device_id}`, "success");
    renderSpotifyFacts();
  });

  state.spotifyPlayer.addListener("not_ready", ({ device_id }) => {
    log(`Spotify device went offline: ${device_id}`, "error");
  });

  state.spotifyPlayer.addListener("initialization_error", ({ message }) => log(`Spotify initialization error: ${message}`, "error"));
  state.spotifyPlayer.addListener("authentication_error", ({ message }) => log(`Spotify authentication error: ${message}`, "error"));
  state.spotifyPlayer.addListener("account_error", ({ message }) => log(`Spotify account error: ${message}`, "error"));
  state.spotifyPlayer.addListener("playback_error", ({ message }) => log(`Spotify playback error: ${message}`, "error"));
  state.spotifyPlayer.addListener("player_state_changed", (playerState) => {
    if (!playerState) {
      log("Spotify player_state_changed: null state");
      return;
    }
    const track = playerState.track_window?.current_track;
    updateNowPlayingFromSdk(playerState);
    log(
      `Spotify state: paused=${playerState.paused} position=${playerState.position} track=${track?.name || "unknown"}`
    );
    renderSpotifyFacts();
  });

  const connected = await state.spotifyPlayer.connect();
  log(`Spotify player connect() returned ${connected}.`, connected ? "success" : "error");
  if (!connected) throw new Error("Spotify player connect() returned false.");
  const deviceId = await waitForSpotifyDeviceId(12000);
  renderSpotifyFacts();
  return deviceId;
}

function waitForSpotifyDeviceId(timeoutMs) {
  if (state.spotifyDeviceId) return Promise.resolve(state.spotifyDeviceId);
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      if (state.spotifyDeviceId) {
        window.clearInterval(timer);
        resolve(state.spotifyDeviceId);
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        window.clearInterval(timer);
        reject(new Error("Spotify player connected but no device ID was received."));
      }
    }, 250);
  });
}

async function toggleSpotifyPlayback() {
  if (!state.spotifyPlayer) await createSpotifyPlayer();
  await state.spotifyPlayer.togglePlay();
  log("Spotify togglePlay() called.", "success");
}

async function nextTrack() {
  await ensureSpotifyDeviceReady();
  const response = await spotifyApiFetch(withDeviceIdParam("/v1/me/player/next"), { method: "POST" });
  if (!response.ok) throw new Error(`Spotify next failed (${response.status}): ${await readSpotifyError(response)}`);
  log("Spotify next track requested.", "success");
  window.setTimeout(() => getCurrentPlayback().catch((error) => logError("Playback refresh failed", error)), 800);
}

async function previousTrack() {
  await ensureSpotifyDeviceReady();
  const response = await spotifyApiFetch(withDeviceIdParam("/v1/me/player/previous"), { method: "POST" });
  if (!response.ok) throw new Error(`Spotify previous failed (${response.status}): ${await readSpotifyError(response)}`);
  log("Spotify previous track requested.", "success");
  window.setTimeout(() => getCurrentPlayback().catch((error) => logError("Playback refresh failed", error)), 800);
}

const REPEAT_CYCLE = ["off", "context", "track"];

async function toggleShuffle() {
  await ensureSpotifyDeviceReady();
  const next = !state.shuffle;
  const response = await spotifyApiFetch(withDeviceIdParam(`/v1/me/player/shuffle?state=${next}`), { method: "PUT" });
  if (!response.ok) throw new Error(`Spotify shuffle failed (${response.status}): ${await readSpotifyError(response)}`);
  state.shuffle = next;
  renderTransportState();
  log(`Spotify shuffle ${next ? "on" : "off"}.`, "success");
}

async function cycleRepeat() {
  await ensureSpotifyDeviceReady();
  const idx = REPEAT_CYCLE.indexOf(state.repeat);
  const next = REPEAT_CYCLE[(idx + 1) % REPEAT_CYCLE.length];
  const response = await spotifyApiFetch(withDeviceIdParam(`/v1/me/player/repeat?state=${next}`), { method: "PUT" });
  if (!response.ok) throw new Error(`Spotify repeat failed (${response.status}): ${await readSpotifyError(response)}`);
  state.repeat = next;
  renderTransportState();
  log(`Spotify repeat ${next}.`, "success");
}

async function transferPlayback() {
  if (!state.spotifyDeviceId) {
    log("TV device ID missing. Creating Spotify player before transfer.");
    await createSpotifyPlayer();
  }
  await transferToDevice(state.spotifyDeviceId);
}

async function transferToDevice(deviceId) {
  if (!deviceId) throw new Error("Missing Spotify device id.");
  const response = await spotifyApiFetch("/v1/me/player", {
    method: "PUT",
    body: JSON.stringify({ device_ids: [deviceId], play: true }),
  });
  log(`Spotify transfer playback returned ${response.status}.`, response.ok ? "success" : "error");
  await loadDevices().catch((error) => logError("Device refresh failed", error));
}

async function getCurrentPlayback() {
  const response = await spotifyApiFetch("/v1/me/player", { method: "GET" });
  if (response.status === 204) {
    // 204 = no active playback. Not an error — common after pause or before any device is active.
    log("Spotify current playback: no active playback.");
    return;
  }
  if (!response.ok) {
    throw new Error(`Spotify getCurrentPlayback failed (${response.status}): ${await readSpotifyError(response)}`);
  }
  const playback = await response.json();
  updateNowPlayingFromWebApi(playback);
  log(`Spotify current playback: device=${playback.device?.name || "unknown"} active=${playback.device?.is_active} playing=${playback.is_playing} item=${playback.item?.name || "unknown"}`);
}

function volumeDown() {
  return changeSpotifyVolume(-0.1);
}

function volumeUp() {
  return changeSpotifyVolume(0.1);
}

async function changeSpotifyVolume(delta) {
  if (!state.spotifyPlayer) await createSpotifyPlayer();
  state.spotifyVolume = Math.max(0, Math.min(1, state.spotifyVolume + delta));
  await state.spotifyPlayer.setVolume(state.spotifyVolume);
  log(`Spotify setVolume(${state.spotifyVolume.toFixed(2)}) called.`, "success");
  renderSpotifyFacts();
}

function resetSpotify() {
  if (state.spotifyPlayer) {
    state.spotifyPlayer.disconnect();
  }
  state.spotifyPlayer = null;
  state.spotifyPlayerPromise = null;
  state.spotifyDeviceId = "";
  localStorage.removeItem(storageKeys.accessToken);
  localStorage.removeItem(storageKeys.refreshToken);
  localStorage.removeItem(storageKeys.expiresAt);
  localStorage.removeItem(storageKeys.verifier);
  localStorage.removeItem(storageKeys.pairCode);
  localStorage.removeItem(storageKeys.pairLoginUrl);
  stopPairPolling();
  elements.connectionStatus.textContent = "Not signed in";
  log("Spotify TV state reset.");
  renderSpotifyFacts();
}

function renderSpotifyFacts() {
  const expiresAt = Number(localStorage.getItem(storageKeys.expiresAt) || 0);
  const facts = {
    "Client ID": "built in",
    "Access token": getStoredAccessToken() ? "present" : "missing",
    "Refresh token": localStorage.getItem(storageKeys.refreshToken) ? "present" : "missing",
    "Token expires": expiresAt ? new Date(expiresAt).toLocaleString() : "n/a",
    "SDK": window.Spotify?.Player ? "loaded" : "not loaded",
    "Player": state.spotifyPlayer ? "created" : "not created",
    "Device ID": state.spotifyDeviceId || "not ready",
    "Volume": Math.round(state.spotifyVolume * 100) + "%",
    "Pair code": getPairCode() || "not created",
    "Pair login URL": localStorage.getItem(storageKeys.pairLoginUrl) || "not created",
  };
  renderFacts(elements.spotifyFacts, facts);
  renderPairInfo();
  renderShellState();
}

function renderShellState() {
  const hasToken = Boolean(getStoredAccessToken() || localStorage.getItem(storageKeys.refreshToken));
  elements.connectionStatus.textContent = hasToken ? "Signed in" : "Not signed in";
  elements.deviceStatus.textContent = state.spotifyDeviceId
    ? "TV player ready"
    : state.spotifyPlayerPromise
      ? "Creating TV player"
      : "No TV player";
}

function renderPairInfo() {
  const pairCode = getPairCode();
  const pairUrl = localStorage.getItem(storageKeys.pairLoginUrl) || "";
  elements.pairCard.hidden = !pairCode || !pairUrl;
  if (!pairCode || !pairUrl) return;
  elements.pairCode.textContent = pairCode;
  elements.pairUrl.textContent = pairUrl;
  elements.pairQr.hidden = false;
  elements.pairQr.src = `https://api.qrserver.com/v1/create-qr-code/?size=420x420&margin=10&data=${encodeURIComponent(pairUrl)}`;
}

function updateNowPlayingFromSdk(playerState) {
  const track = playerState.track_window?.current_track;
  if (!track) return;
  const duration = track.duration_ms || 0;
  state.nowPlaying = {
    id: track.id || "",
    uri: track.uri || "",
    title: track.name,
    artist: (track.artists || []).map((artist) => artist.name).join(", "),
    image: track.album?.images?.[0]?.url || "",
    paused: playerState.paused,
    position: playerState.position || 0,
    duration,
    updatedAt: Date.now(),
  };
  if (typeof playerState.shuffle === "boolean") state.shuffle = playerState.shuffle;
  if (typeof playerState.repeat_mode === "number") {
    state.repeat = REPEAT_CYCLE[playerState.repeat_mode] || "off";
  }
  renderNowPlaying();
}

function updateNowPlayingFromWebApi(playback) {
  const item = playback.item;
  if (!item) return;
  state.nowPlaying = {
    id: item.id || "",
    uri: item.uri || "",
    title: item.name,
    artist: (item.artists || []).map((artist) => artist.name).join(", "),
    image: item.album?.images?.[0]?.url || "",
    paused: !playback.is_playing,
    position: playback.progress_ms || 0,
    duration: item.duration_ms || 0,
    updatedAt: Date.now(),
  };
  if (typeof playback.shuffle_state === "boolean") state.shuffle = playback.shuffle_state;
  if (typeof playback.repeat_state === "string") state.repeat = playback.repeat_state;
  renderNowPlaying();
}

function renderNowPlaying() {
  const now = state.nowPlaying;
  if (!now) {
    renderTransportState();
    renderNpPill();
    return;
  }
  if (now.image) elements.nowArtwork.src = now.image;
  else elements.nowArtwork.removeAttribute("src");
  if (elements.nowBackdrop) {
    elements.nowBackdrop.style.backgroundImage = now.image ? `url("${now.image}")` : "";
  }
  elements.nowContext.textContent = now.paused ? "Paused" : "Now Playing";
  elements.nowTitle.textContent = now.title;
  elements.nowArtist.textContent = now.artist;
  elements.ambientTitle.textContent = now.title;
  elements.ambientSubtitle.textContent = now.artist;
  refreshAmbientPalette(now.image);
  renderProgress();
  renderTransportState();
  renderAmbient();
  renderNpPill();
  renderCollectionPlayingState();
}

const ICON_PLAY = "M8 5v14l11-7z";
const ICON_PAUSE = "M6 5h4v14H6zm8 0h4v14h-4z";

function renderTransportState() {
  const now = state.nowPlaying;
  const isPlaying = now ? !now.paused : false;
  for (const btn of document.querySelectorAll("[data-action='toggleSpotifyPlayback']")) {
    btn.setAttribute("aria-label", isPlaying ? "Pause" : "Play");
    const path = btn.querySelector("svg path");
    if (path) path.setAttribute("d", isPlaying ? ICON_PAUSE : ICON_PLAY);
  }
  for (const btn of document.querySelectorAll("[data-action='toggleShuffle']")) {
    btn.classList.toggle("is-active", state.shuffle);
    btn.setAttribute("aria-pressed", state.shuffle ? "true" : "false");
  }
  for (const btn of document.querySelectorAll("[data-action='cycleRepeat']")) {
    btn.classList.toggle("is-active", state.repeat !== "off");
    btn.dataset.mode = state.repeat;
    btn.setAttribute("aria-label", `Repeat: ${state.repeat}`);
    const badge = btn.querySelector(".transport-btn__badge");
    if (badge) badge.hidden = state.repeat !== "track";
  }
}

function renderProgress() {
  const now = state.nowPlaying;
  if (!now) return;
  const elapsed = now.paused ? now.position : now.position + (Date.now() - now.updatedAt);
  const position = Math.min(elapsed, now.duration || elapsed);
  const ratio = now.duration ? position / now.duration : 0;
  const percent = Math.max(0, Math.min(100, ratio * 100));
  const timeText = `${formatDuration(position)} / ${formatDuration(now.duration)}`;
  elements.progressFill.style.width = `${percent}%`;
  elements.positionText.textContent = formatDuration(position);
  elements.durationText.textContent = formatDuration(now.duration);
  if (elements.npPillProgressFill) {
    elements.npPillProgressFill.style.width = `${percent}%`;
  }
  if (elements.npPillTime) {
    elements.npPillTime.textContent = timeText;
  }
  if (elements.ambientProgressFill) {
    elements.ambientProgressFill.style.width = `${percent}%`;
  }
  if (elements.ambientProgressTime) {
    elements.ambientProgressTime.textContent = timeText;
  }
}

function renderAmbient() {
  const now = state.nowPlaying;
  const image = now?.image || "";
  const mode = state.ambientMode;
  const stage = elements.ambientStage;
  if (!stage) return;

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

  if (elements.ambientRoomArt) {
    if (image) {
      elements.ambientRoomArt.src = image;
    } else {
      elements.ambientRoomArt.removeAttribute("src");
    }
  }

  if (elements.ambientBubbleTitle) {
    elements.ambientBubbleTitle.textContent = now?.title || "Nothing playing";
  }
  if (elements.ambientBubbleArtist) {
    elements.ambientBubbleArtist.textContent = now?.artist || "";
  }

  if (elements.ambientVisualizerArt) {
    if (image) {
      elements.ambientVisualizerArt.src = image;
    } else {
      elements.ambientVisualizerArt.removeAttribute("src");
    }
  }

  // Drift layers for screensaver pull from the same background-image custom property.
  const artUrl = image ? `url("${image}")` : "none";
  stage.style.setProperty("--ambient-art-url", artUrl);

  for (const button of document.querySelectorAll("[data-action='setAmbientMode']")) {
    button.classList.toggle("is-active", button.dataset.mode === mode);
  }
}

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
  if (!elements.viewAmbient || !palette) return;
  const [a, b, c] = palette;
  if (a) elements.viewAmbient.style.setProperty("--ambient-accent-a", a);
  if (b) elements.viewAmbient.style.setProperty("--ambient-accent-b", b);
  if (c) elements.viewAmbient.style.setProperty("--ambient-accent-c", c);
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

function startProgressTimer() {
  if (state.progressTimer) window.clearInterval(state.progressTimer);
  state.progressTimer = window.setInterval(renderProgress, 1000);
}

function renderNpPill() {
  const pill = elements.npPill;
  if (!pill) return;
  const now = state.nowPlaying;
  const hideOnView = state.currentView === "ambient" || state.currentView === "now";
  const shouldShow = Boolean(now) && !hideOnView;
  pill.hidden = !shouldShow;
  document.body.classList.toggle("has-pill", shouldShow);
  if (!shouldShow) return;
  if (elements.npPillArt) {
    if (now.image) elements.npPillArt.src = now.image;
    else elements.npPillArt.removeAttribute("src");
  }
  if (elements.npPillTitle) elements.npPillTitle.textContent = now.title || "Nothing playing";
  if (elements.npPillArtist) elements.npPillArtist.textContent = now.artist || "";
  if (elements.npPillPlayBtn) {
    const isPlaying = !now.paused;
    elements.npPillPlayBtn.setAttribute("aria-label", isPlaying ? "Pause" : "Play");
    const svg = elements.npPillPlayBtn.querySelector("svg path");
    if (svg) {
      svg.setAttribute("d", isPlaying ? "M6 5h4v14H6zm8 0h4v14h-4z" : "M8 5v14l11-7z");
    }
  }
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
  if (elements.toggleDebugView) {
    elements.toggleDebugView.setAttribute("aria-checked", state.debugVisible ? "true" : "false");
  }
  if (elements.toggleDebugState) {
    elements.toggleDebugState.textContent = state.debugVisible ? "On" : "Off";
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

function startBubbleCornerTimer() {
  if (state.bubbleCornerTimer) window.clearInterval(state.bubbleCornerTimer);
  state.bubbleCornerTimer = window.setInterval(() => {
    if (!elements.ambientBubble) return;
    state.bubbleCornerIndex = (state.bubbleCornerIndex + 1) % BUBBLE_CORNERS.length;
    elements.ambientBubble.dataset.corner = BUBBLE_CORNERS[state.bubbleCornerIndex];
  }, 90000);
}

// === Scene (screensaver) playback =============================================
// Scene runs an A/B pair of <video> elements so the next clip can preload while
// the current one plays; we crossfade by toggling .ambient-screensaver[data-active]
// (opacity only — TV-safe). Sources come from Pexels when a key is present, else
// the bundled AMBIENT_VIDEOS loops. We advance manually (no reliance on loop) so
// playback is perpetual and Skip can jump instantly.

function hasPexelsKey() {
  try {
    return Boolean(window.__PEXELS_KEY__);
  } catch {
    return false;
  }
}

function sceneVideoEls() {
  return { a: elements.ambientVideo, b: elements.ambientVideoB };
}

function activeSceneVideo() {
  const { a, b } = sceneVideoEls();
  return state.sceneActiveVideo === "b" ? b : a;
}

function inactiveSceneVideo() {
  const { a, b } = sceneVideoEls();
  return state.sceneActiveVideo === "b" ? a : b;
}

// Called by setAmbientMode + setView. Decides whether Scene should be running and
// kicks off (or stops) playback. Stopping pauses both elements without tearing
// down sources, so returning to Scene resumes quickly.
function syncAmbientVideo() {
  const screensaver = elements.ambientScreensaver;
  const { a, b } = sceneVideoEls();
  if (!screensaver || !a) return;
  const shouldPlay = state.currentView === "ambient" && state.ambientMode === "screensaver";
  if (!shouldPlay) {
    // Bump the token so any in-flight fetch/load callbacks become no-ops.
    state.sceneToken += 1;
    try { a.pause(); } catch {}
    try { b?.pause(); } catch {}
    return;
  }
  // Already running with a visible clip — resume it. Re-arm the onended advance
  // with a fresh token (the previous token was invalidated when Scene was paused).
  if (screensaver.dataset.video === "on" && activeSceneVideo()?.currentSrc) {
    const token = ++state.sceneToken;
    const current = activeSceneVideo();
    current.onended = () => {
      if (token !== state.sceneToken) return;
      advanceSceneClip(token);
    };
    current.play().catch(() => {});
    return;
  }
  startScenePlayback();
}

// Build (or rebuild) the in-memory playlist for the current category, then begin
// playing the first clip. Pexels is attempted first; any failure falls back to
// the bundled loops via beginLocalScene().
function startScenePlayback() {
  const token = ++state.sceneToken;
  if (!hasPexelsKey()) {
    log("Scene: no Pexels key present; using bundled ambient loops.");
    beginLocalScene(token);
    return;
  }
  if (state.sceneFetchInFlight) return;
  state.sceneFetchInFlight = true;
  fetchPexelsScene(state.sceneCategory, token)
    .then((urls) => {
      state.sceneFetchInFlight = false;
      if (token !== state.sceneToken) return; // category changed / left Scene
      if (!urls || !urls.length) {
        log("Scene: Pexels returned no usable clips; using bundled loops.");
        beginLocalScene(token);
        return;
      }
      state.sceneSource = "pexels";
      state.scenePlaylist = shuffleArray(urls);
      state.scenePlaylistIndex = -1;
      log(`Scene: loaded ${state.scenePlaylist.length} ${state.sceneCategory} clips from Pexels.`, "success");
      advanceSceneClip(token);
    })
    .catch((error) => {
      state.sceneFetchInFlight = false;
      if (token !== state.sceneToken) return;
      logError("Scene: Pexels fetch failed; using bundled loops", error);
      beginLocalScene(token);
    });
}

// Fallback path: the existing bundled loops become the playlist.
function beginLocalScene(token) {
  if (token !== state.sceneToken) return;
  state.sceneSource = "local";
  state.scenePlaylist = AMBIENT_VIDEOS.slice();
  state.scenePlaylistIndex = -1;
  advanceSceneClip(token);
}

// Load the next clip into the *inactive* video element, then crossfade. On a load
// error we skip forward; if every clip in a local playlist fails we drop to the
// generative drift scene (data-video="off"). For Pexels failures we retry within
// the same list, and only if the whole list is exhausted do we fall back local.
function advanceSceneClip(token, attempt = 0) {
  if (token !== state.sceneToken) return;
  const screensaver = elements.ambientScreensaver;
  const playlist = state.scenePlaylist;
  if (!screensaver || !playlist.length) return;

  // Exhausted the list (all failed this pass) — degrade.
  if (attempt >= playlist.length) {
    if (state.sceneSource === "pexels") {
      log("Scene: all Pexels clips failed to load; using bundled loops.");
      beginLocalScene(token);
    } else {
      screensaver.dataset.video = "off";
      log("Scene: no video source loaded; using generative scene.");
    }
    return;
  }

  state.scenePlaylistIndex = (state.scenePlaylistIndex + 1) % playlist.length;
  const url = playlist[state.scenePlaylistIndex];
  const next = inactiveSceneVideo();
  if (!next) return;

  next.onerror = null;
  next.oncanplay = null;
  next.onended = null;

  next.onerror = () => {
    if (token !== state.sceneToken) return;
    next.onerror = null;
    next.oncanplay = null;
    log(`Scene clip failed to load: ${url}`);
    advanceSceneClip(token, attempt + 1);
  };
  next.oncanplay = () => {
    if (token !== state.sceneToken) return;
    next.onerror = null;
    next.oncanplay = null;
    crossfadeToInactive(token);
    // Perpetual play: advance when this clip finishes. We muted + manual-advance
    // rather than loop so the next random clip always preloads.
    next.onended = () => {
      if (token !== state.sceneToken) return;
      advanceSceneClip(token);
    };
    log(`Scene clip playing (${state.sceneSource}): ${url}`, "success");
  };

  next.src = url;
  next.load();
  const p = next.play();
  if (p && typeof p.catch === "function") p.catch(() => {});
}

// Swap which A/B element is visible. The screensaver wrapper carries data-active
// = "a" | "b"; CSS fades the matching element in via opacity. Pause the now-hidden
// element so only one clip decodes at a time on the TV GPU.
function crossfadeToInactive(token) {
  if (token !== state.sceneToken) return;
  const screensaver = elements.ambientScreensaver;
  if (!screensaver) return;
  const justLoaded = state.sceneActiveVideo === "b" ? "a" : "b";
  const previous = activeSceneVideo();
  state.sceneActiveVideo = justLoaded;
  screensaver.dataset.active = justLoaded;
  screensaver.dataset.video = "on";
  // Pause the outgoing clip after the fade so it stops decoding.
  if (previous) {
    window.setTimeout(() => {
      if (token !== state.sceneToken) return;
      if (activeSceneVideo() !== previous) {
        try { previous.pause(); } catch {}
      }
    }, 900);
  }
}

// Skip control: jump to the next clip immediately (no waiting for the current one
// to end). Reuses advanceSceneClip against the existing in-memory playlist.
function skipSceneClip() {
  if (state.ambientMode !== "screensaver") return;
  if (!state.scenePlaylist.length) {
    syncAmbientVideo();
    return;
  }
  log("Scene: skip to next clip.");
  advanceSceneClip(state.sceneToken);
}

// Toggle category, persist it, reflect the icon/label, and rebuild the playlist.
function toggleSceneCategory() {
  const idx = SCENE_CATEGORIES.indexOf(state.sceneCategory);
  const safeIdx = idx < 0 ? 0 : idx;
  state.sceneCategory = SCENE_CATEGORIES[(safeIdx + 1) % SCENE_CATEGORIES.length];
  try {
    localStorage.setItem(storageKeys.sceneCategory, state.sceneCategory);
  } catch {}
  reflectSceneCategory();
  log(`Scene category set to ${SCENE_CATEGORY_LABELS[state.sceneCategory]}.`);
  if (state.currentView === "ambient" && state.ambientMode === "screensaver") {
    // Cancel any in-flight load and start fresh for the new category.
    startScenePlayback();
  }
}

// Sync the toggle button's data-category (drives which SVG shows) + label + a11y.
function reflectSceneCategory() {
  const label = SCENE_CATEGORY_LABELS[state.sceneCategory] || "Nature";
  if (elements.sceneCategoryBtn) {
    elements.sceneCategoryBtn.dataset.category = state.sceneCategory;
    elements.sceneCategoryBtn.setAttribute("aria-label", `Scene category: ${label}`);
  }
  if (elements.sceneCategoryLabel) {
    elements.sceneCategoryLabel.textContent = label;
  }
}

function shuffleArray(input) {
  const arr = input.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// === Pexels API ===============================================================
// Search one (random) query for the category and return a flat list of mp4 URLs.
// Honors 429 with exponential backoff using the Retry-After header. Clips are kept
// in memory only (callers store them on state); nothing is persisted.
async function fetchPexelsScene(category, token) {
  const key = window.__PEXELS_KEY__;
  if (!key) return [];
  const queries = SCENE_QUERIES[category] || SCENE_QUERIES.nature;
  const query = queries[Math.floor(Math.random() * queries.length)];
  const page = 1 + Math.floor(Math.random() * PEXELS_MAX_PAGE);
  const url = `${PEXELS_VIDEO_SEARCH}?query=${encodeURIComponent(query)}`
    + `&orientation=landscape&size=large&per_page=${PEXELS_PER_PAGE}&page=${page}`;

  let attempt = 0;
  while (attempt <= PEXELS_MAX_RETRIES) {
    if (token !== state.sceneToken) return [];
    let response;
    try {
      response = await fetch(url, {
        // Pexels wants the RAW key in Authorization (no "Bearer " prefix).
        headers: { Authorization: key },
      });
    } catch (networkError) {
      // Network-level failure — let the caller fall back to local loops.
      throw networkError;
    }

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("Retry-After"));
      // Exponential backoff: prefer the server hint, else 2^attempt seconds.
      const waitSec = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter
        : Math.pow(2, attempt);
      log(`Scene: Pexels rate-limited (429); backing off ${waitSec}s.`);
      attempt += 1;
      if (attempt > PEXELS_MAX_RETRIES) break;
      await delay(waitSec * 1000);
      continue;
    }

    if (!response.ok) {
      throw new Error(`Pexels HTTP ${response.status}`);
    }

    const data = await response.json();
    return extractPexelsMp4s(data);
  }
  // Ran out of retries on 429.
  throw new Error("Pexels rate limit retries exhausted");
}

// From a Pexels search payload, pick one good mp4 per video. Prefer ~1920 then
// ~1280 wide hd clips; fall back to the widest mp4 available.
function extractPexelsMp4s(data) {
  const videos = Array.isArray(data?.videos) ? data.videos : [];
  const urls = [];
  for (const video of videos) {
    const files = Array.isArray(video?.video_files) ? video.video_files : [];
    const mp4s = files.filter((f) => f && f.file_type === "video/mp4" && f.link);
    if (!mp4s.length) continue;
    const pick = pickPreferredMp4(mp4s);
    if (pick) urls.push(pick.link);
  }
  return urls;
}

function pickPreferredMp4(mp4s) {
  // Score by closeness to 1920, then 1280; prefer "hd" quality; tie-break wider.
  const scored = mp4s.map((f) => {
    const width = Number(f.width) || 0;
    let score;
    if (width >= 1800 && width <= 2100) score = 0;        // ~full HD landscape
    else if (width >= 1200 && width <= 1400) score = 1;   // ~HD landscape
    else if (width > 2100) score = 2;                      // 4K — heavy on the TV
    else score = 3;                                        // small/odd
    if (f.quality === "hd") score -= 0.25;
    return { file: f, score, width };
  });
  scored.sort((a, b) => (a.score - b.score) || (b.width - a.width));
  return scored[0]?.file || null;
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
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
  // TV-optimized: cap to ~30fps and dpr 1 so the canvas work stays cheap on the
  // VIDAA GPU. Anything higher just dropped frames and lagged the whole UI.
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
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    state.visualizerPhase += prefersReduced ? 0 : 0.06;
    drawVisualizerFrame(ctx, w, h, state.visualizerPhase, state.paletteCache.palette);
  };
  state.visualizerRaf = window.requestAnimationFrame(draw);
}

function stopVisualizer() {
  if (state.visualizerRaf) {
    window.cancelAnimationFrame(state.visualizerRaf);
    state.visualizerRaf = 0;
  }
}

function drawVisualizerFrame(ctx, w, h, phase, palette) {
  const accentA = (palette && palette[0]) || "#1ed760";
  const accentB = (palette && palette[1]) || "#70a6ff";
  const accentC = (palette && palette[2]) || accentA;
  ctx.clearRect(0, 0, w, h);

  const now = state.nowPlaying;
  const positionMs = now ? (now.paused ? now.position : now.position + (Date.now() - now.updatedAt)) : 0;
  const playing = Boolean(now && !now.paused);
  const energy = playing ? 1 : 0.42;
  // Pseudo-beat locked to the playback timeline (~120bpm) so the motion tracks
  // the song rather than free-running. Not a real FFT — DRM audio can't be tapped.
  const beatPhase = (positionMs / 1000) * (120 / 60) * Math.PI * 2;
  const pulse = (Math.sin(beatPhase) * 0.5 + 0.5) * energy;

  const cx = w / 2;
  const cy = h / 2;
  const minDim = Math.min(w, h);
  const innerR = minDim * 0.30 * (1 + pulse * 0.035);
  // TV-optimized: no shadowBlur, no "lighter" compositing, fewer bars. Those were
  // the per-frame killers on the VIDAA GPU. The circular look is preserved via the
  // radial bars + breathing ring, just rendered cheaply.
  const bars = 56;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.lineCap = "round";
  for (let i = 0; i < bars; i++) {
    const t = i / bars;
    const angle = t * Math.PI * 2 - Math.PI / 2;
    const wobble =
      Math.sin(phase * 0.7 + i * 0.35) * 0.5 +
      Math.sin(phase * 0.33 + i * 0.11) * 0.3 +
      Math.sin(beatPhase + i * 0.5) * 0.4;
    const amp = (0.32 + (wobble * 0.5 + 0.5) * 0.68) * energy;
    const len = amp * minDim * 0.16 + 6;
    const x1 = Math.cos(angle) * innerR;
    const y1 = Math.sin(angle) * innerR;
    const x2 = Math.cos(angle) * (innerR + len);
    const y2 = Math.sin(angle) * (innerR + len);
    const color = (Math.sin(t * Math.PI * 2 + phase * 0.2) * 0.5 + 0.5) < 0.5 ? accentA : accentB;
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.4 + amp * 0.5;
    ctx.lineWidth = Math.max(2, (minDim / bars) * 0.5);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  // Soft breathing ring just outside the album art.
  ctx.globalAlpha = 0.16 + pulse * 0.16;
  ctx.lineWidth = minDim * 0.012;
  ctx.strokeStyle = accentC;
  ctx.beginPath();
  ctx.arc(0, 0, innerR * 0.92, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor((ms || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function renderFacts(container, facts) {
  if (!container) return;
  container.replaceChildren();
  for (const [key, value] of Object.entries(facts)) {
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = key;
    dd.textContent = value;
    container.append(dt, dd);
  }
}

function getClientId() {
  localStorage.setItem(storageKeys.clientId, SPOTIFY_CLIENT_ID);
  return SPOTIFY_CLIENT_ID;
}

function requireAccessToken() {
  if (!getStoredAccessToken() && !localStorage.getItem(storageKeys.refreshToken)) {
    throw new Error("Sign in with Spotify first.");
  }
}

function spotifyRedirectUri() {
  return location.origin + location.pathname;
}

function applyUrlState() {
  const params = new URLSearchParams(location.search);
  const pairCode = normalizePairCode(params.get("pair"));

  // Phone mode is sticky for the lifetime of the tab. The OAuth round-trip
  // drops the ?phone=1 querystring (redirect URI is just origin + path), so we
  // persist the flag in sessionStorage to survive that redirect.
  let isPhonePair = false;
  try {
    if (params.get("phone") === "1") {
      sessionStorage.setItem(PHONE_MODE_SESSION_KEY, "1");
    }
    isPhonePair = sessionStorage.getItem(PHONE_MODE_SESSION_KEY) === "1";
  } catch {
    isPhonePair = params.get("phone") === "1";
  }
  document.body.classList.toggle("is-phone-pair", isPhonePair);
  if (pairCode) {
    localStorage.setItem(storageKeys.pairCode, pairCode);
    log(`Pair login mode active. Code=${pairCode}`);
  }
}

function renderPhonePairScreen(stateName, message) {
  const screen = elements.phonePairScreen;
  if (!screen) return;
  if (stateName) screen.dataset.state = stateName;
  if (elements.phonePairCode) {
    const code = getPairCode();
    elements.phonePairCode.textContent = code ? code.padEnd(6, "•") : "------";
  }
  if (message) {
    if (stateName === "error" && elements.phonePairErrorMessage) {
      elements.phonePairErrorMessage.textContent = message;
    }
    if (stateName === "success" && elements.phonePairSuccessMessage) {
      elements.phonePairSuccessMessage.textContent = message;
    }
  }
}

function getPairCode() {
  return normalizePairCode(localStorage.getItem(storageKeys.pairCode));
}

function generatePairCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(6);
  if (crypto?.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

function normalizePairCode(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}

function getStoredAccessToken() {
  const token = localStorage.getItem(storageKeys.accessToken);
  const expiresAt = Number(localStorage.getItem(storageKeys.expiresAt) || 0);
  if (!token || Date.now() > expiresAt - 60000) return "";
  return token;
}

function getAccessToken() {
  const token = getStoredAccessToken();
  if (!token) throw new Error("Missing or expired Spotify access token. Log in again.");
  return token;
}

async function ensureAccessToken() {
  const storedToken = getStoredAccessToken();
  if (storedToken) return storedToken;

  const refreshToken = localStorage.getItem(storageKeys.refreshToken);
  if (!refreshToken) throw new Error("Missing or expired Spotify access token. Log in again.");

  const body = new URLSearchParams();
  body.set("client_id", getClientId());
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", refreshToken);

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    localStorage.removeItem(storageKeys.accessToken);
    localStorage.removeItem(storageKeys.expiresAt);
    throw new Error(`Spotify token refresh failed: ${response.status}`);
  }

  const token = await response.json();
  const expiresAt = Date.now() + token.expires_in * 1000;
  localStorage.setItem(storageKeys.accessToken, token.access_token);
  if (token.refresh_token) localStorage.setItem(storageKeys.refreshToken, token.refresh_token);
  localStorage.setItem(storageKeys.expiresAt, String(expiresAt));
  log("Spotify access token refreshed.", "success");
  renderSpotifyFacts();
  return token.access_token;
}

async function spotifyApiJson(path, init = {}) {
  const response = await spotifyApiFetch(path, init);
  if (!response.ok) {
    throw new Error(`Spotify API failed ${response.status} for ${path}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function spotifyApiFetch(path, init) {
  const token = await ensureAccessToken();
  return fetch(`https://api.spotify.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
}

function getImage(item) {
  return item?.album?.images?.[0]?.url || item?.images?.[0]?.url || "/public/icons/spotify-logo.png";
}

function emptyState(message) {
  const div = document.createElement("div");
  div.className = "card";
  div.textContent = message;
  return div;
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

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("/service-worker.js");
    log("Service worker registered.", "success");
  } catch (error) {
    logError("Service worker registration failed", error);
  }
}

function generateCodeVerifier() {
  const bytes = new Uint8Array(64);
  if (crypto?.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    log("crypto.getRandomValues missing; used Math.random fallback for probe only.", "error");
  }
  return base64Url(bytes);
}

async function createCodeChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = crypto?.subtle?.digest
    ? await crypto.subtle.digest("SHA-256", data)
    : sha256(data);
  if (!crypto?.subtle?.digest) {
    log("crypto.subtle.digest missing; used JS SHA-256 fallback.", "error");
  }
  return base64Url(new Uint8Array(digest));
}

function sha256(bytes) {
  const rightRotate = (value, amount) => (value >>> amount) | (value << (32 - amount));
  const k = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
    0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
    0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
    0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
    0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
    0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
    0xc67178f2,
  ];
  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const message = Array.from(bytes);
  const bitLength = message.length * 8;
  message.push(0x80);
  while (message.length % 64 !== 56) message.push(0);
  for (let i = 7; i >= 0; i--) message.push((bitLength / Math.pow(256, i)) & 0xff);

  for (let i = 0; i < message.length; i += 64) {
    const w = new Array(64);
    for (let j = 0; j < 16; j++) {
      w[j] =
        (message[i + j * 4] << 24) |
        (message[i + j * 4 + 1] << 16) |
        (message[i + j * 4 + 2] << 8) |
        message[i + j * 4 + 3];
    }
    for (let j = 16; j < 64; j++) {
      const s0 = rightRotate(w[j - 15], 7) ^ rightRotate(w[j - 15], 18) ^ (w[j - 15] >>> 3);
      const s1 = rightRotate(w[j - 2], 17) ^ rightRotate(w[j - 2], 19) ^ (w[j - 2] >>> 10);
      w[j] = (w[j - 16] + s0 + w[j - 7] + s1) | 0;
    }

    let [a, b, c, d, e, f, g, hh] = h;
    for (let j = 0; j < 64; j++) {
      const s1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + s1 + ch + k[j] + w[j]) | 0;
      const s0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }

    h[0] = (h[0] + a) | 0;
    h[1] = (h[1] + b) | 0;
    h[2] = (h[2] + c) | 0;
    h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0;
    h[5] = (h[5] + f) | 0;
    h[6] = (h[6] + g) | 0;
    h[7] = (h[7] + hh) | 0;
  }

  const output = new Uint8Array(32);
  h.forEach((value, index) => {
    output[index * 4] = (value >>> 24) & 0xff;
    output[index * 4 + 1] = (value >>> 16) & 0xff;
    output[index * 4 + 2] = (value >>> 8) & 0xff;
    output[index * 4 + 3] = value & 0xff;
  });
  return output.buffer;
}

function base64Url(bytes) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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
  log(`${context}: ${message}`, "error");
}

function showToast(message, level) {
  if (!elements.toastStack) return;
  const toast = document.createElement("div");
  toast.className = `toast ${level}`;
  toast.textContent = message;
  elements.toastStack.append(toast);
  // Cap visible toasts at 3 — older ones leave on their own.
  while (elements.toastStack.children.length > 3) {
    elements.toastStack.firstElementChild?.remove();
  }
  window.setTimeout(() => {
    toast.classList.add("is-leaving");
    window.setTimeout(() => toast.remove(), 220);
  }, level === "error" ? 4500 : 3000);
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

init();
