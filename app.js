const SPOTIFY_CLIENT_ID = "f090eff2edba4b17a1b0743e4080e755";

const SPOTIFY_SCOPES = [
  "streaming",
  "user-read-email",
  "user-read-private",
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "playlist-read-private",
  "playlist-modify-public",
  "playlist-modify-private",
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
  sceneStripAudio: "spotify-pwa.scene-strip-audio",
  sceneImageSequence: "spotify-pwa.scene-image-sequence",
};

// Image-sequence Scene library: read directly from Firestore (the scheduled
// Cloud Function populates sceneClips collection weekly). The Firebase compat
// SDK is loaded in index.html; we lazily grab the client when needed.
function getFirestoreClient() {
  try {
    if (typeof window === "undefined") return null;
    if (window.firebase?.firestore) return window.firebase.firestore();
  } catch {}
  return null;
}

// In-memory cache of the latest library list. Refreshed on Scene entry.
let _sceneLibraryCache = null;
async function loadSceneLibrary() {
  if (_sceneLibraryCache) return _sceneLibraryCache;
  const fs = getFirestoreClient();
  if (!fs) throw new Error("Firestore client not available");
  const snap = await fs.collection("sceneClips").get();
  const byCategory = { nature: [], skyline: [] };
  snap.forEach((doc) => {
    const d = doc.data();
    if (byCategory[d.category] && Array.isArray(d.frames) && d.frames.length) {
      byCategory[d.category].push({ id: d.id, frames: d.frames, fps: d.fps || 10 });
    }
  });
  _sceneLibraryCache = byCategory;
  return byCategory;
}

const PHONE_MODE_SESSION_KEY = "spotify-pwa.phone-mode";
const PAIR_SESSION_COLLECTION = "pairSessions";
const PAIR_SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes — long enough for a phone OAuth round trip

const AMBIENT_MODES = ["room", "screensaver", "visualizer"];
const AMBIENT_MODE_LABELS = {
  room: "Room Display",
  screensaver: "Scene",
  visualizer: "Visualizer",
};
// Scene metadata bubble drifts only between the top corners so it never collides
// with the control cluster anchored bottom-left.

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
  spotifyElementActivated: false,
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
  sceneStripAudio: true, // experimental: strip audio from Pexels MP4s via mp4box
  sceneStripBlobs: [], // Object URLs to revoke when leaving Scene
  sceneUseImageSequence: false, // backend-mode: cycle JPG frames via Cloud Function
  sceneImageTimer: 0, // setInterval handle for the image-sequence animator
  progressTimer: 0,
  remoteEvents: [],
  debugVisible: false,
  paletteCache: { url: "", palette: null },
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
  queueItems: [], // last-fetched upcoming queue (from /me/player/queue)
  queueReturnFocus: null,
  trackMenuTrack: null, // track object the context menu is acting on
  trackMenuReturnFocus: null,
  userPlaylists: null, // cached editable playlists for the add-to-playlist picker
  upNextTrackId: "", // nowPlaying id the up-next card was last shown for (once per song)
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
  recentShelf: document.querySelector("#recentShelf"),
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
  sceneNp: document.querySelector("#sceneNp"),
  sceneNpArt: document.querySelector("#sceneNpArt"),
  sceneNpTitle: document.querySelector("#sceneNpTitle"),
  sceneNpArtist: document.querySelector("#sceneNpArtist"),
  sceneNpProgressFill: document.querySelector("#sceneNpProgressFill"),
  sceneNpTime: document.querySelector("#sceneNpTime"),
  sceneNpStatus: document.querySelector("#sceneNpStatus"),
  ambientDriftA: document.querySelector("#ambientDriftA"),
  ambientDriftB: document.querySelector("#ambientDriftB"),
  ambientDriftC: document.querySelector("#ambientDriftC"),
  ambientDriftD: document.querySelector("#ambientDriftD"),
  ambientVisualizerCanvas: document.querySelector("#ambientVisualizerCanvas"),
  ambientVisualizerArt: document.querySelector("#ambientVisualizerArt"),
  ambientScreensaver: document.querySelector("#ambientScreensaver"),
  ambientVideo: document.querySelector("#ambientVideo"),
  ambientVideoB: document.querySelector("#ambientVideoB"),
  ambientImgSeq: document.querySelector("#ambientImgSeq"),
  ambientSceneControls: document.querySelector("#ambientSceneControls"),
  sceneNatureBtn: document.querySelector("#sceneNatureBtn"),
  sceneSkylineBtn: document.querySelector("#sceneSkylineBtn"),
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
  exitDialog: document.querySelector("#exitDialog"),
  exitDialogCancel: document.querySelector("#exitDialogCancel"),
  exitDialogConfirm: document.querySelector("#exitDialogConfirm"),
  queueDrawer: document.querySelector("#queueDrawer"),
  queueList: document.querySelector("#queueList"),
  trackMenu: document.querySelector("#trackMenu"),
  trackMenuArt: document.querySelector("#trackMenuArt"),
  trackMenuTitle: document.querySelector("#trackMenuTitle"),
  trackMenuArtist: document.querySelector("#trackMenuArtist"),
  trackMenuActions: document.querySelector("#trackMenuActions"),
  upNext: document.querySelector("#upNext"),
  upNextArt: document.querySelector("#upNextArt"),
  upNextTitle: document.querySelector("#upNextTitle"),
  upNextArtist: document.querySelector("#upNextArtist"),
};

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
  toggleSceneStripAudio,
  toggleSceneImageSequence,
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
    const savedStrip = localStorage.getItem(storageKeys.sceneStripAudio);
    // Default ON (experimental) so the user can flip it off if it misbehaves.
    state.sceneStripAudio = savedStrip === null ? true : savedStrip === "1";
    const savedImgSeq = localStorage.getItem(storageKeys.sceneImageSequence);
    state.sceneUseImageSequence = savedImgSeq === "1";
  } catch {
    // localStorage unavailable; defaults already set
  }
  applyDebugVisibility();
  applySceneStripState();
  applySceneImageSequenceState();
  for (const button of document.querySelectorAll("[data-action='setAmbientMode']")) {
    button.classList.toggle("is-active", button.dataset.mode === state.ambientMode);
  }
  reflectSceneCategory();
  elements.ambientControls?.classList.toggle("is-dim", state.ambientMode === "screensaver");
}

function focusableElements() {
  return activeFocusables();
}

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
    panel.scrollBy({ top: direction === "down" ? step : -step, behavior: "smooth" });
  } catch {
    panel.scrollTop += direction === "down" ? step : -step;
  }
  return true;
}

// Scope the focus pool to the chrome (nav) + the active view + the now-playing pill.
// This stops "down"/"right" from teleporting into an off-screen view's controls.
function activeFocusables() {
  // While the exit dialog is open it owns the focus pool — trap the remote on its
  // Cancel/Exit buttons so arrows can't escape to the (covered) view behind it.
  if (isExitDialogOpen()) {
    return Array.from(elements.exitDialog.querySelectorAll(".focusable:not([disabled])")).filter(isVisibleElement);
  }
  // The track menu and queue drawer are modal too — trap the remote inside them
  // so arrows can't escape to the view behind. Back closes (see handleBack).
  if (isTrackMenuOpen()) {
    return Array.from(elements.trackMenu.querySelectorAll(".focusable:not([disabled])")).filter(isVisibleElement);
  }
  if (isQueueDrawerOpen()) {
    return Array.from(elements.queueDrawer.querySelectorAll(".focusable:not([disabled])")).filter(isVisibleElement);
  }
  const roots = [];
  const nav = document.querySelector(".nav");
  if (nav) roots.push(nav);
  const activeView = document.getElementById(`view-${state.currentView}`);
  if (activeView) roots.push(activeView);
  const pill = document.getElementById("npPill");
  if (pill) roots.push(pill);
  // Diagnostics is a body-level panel — when Debug View is on, include its
  // focusables (including the scrollable log) so the remote can reach them.
  const diagnostics = document.getElementById("diagnostics");
  if (diagnostics && !diagnostics.hidden) roots.push(diagnostics);

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
  // preventScroll stops the browser's automatic scroll-on-focus, which on
  // VIDAA scrolls the fixed ambient overlay and leaves a stuck bar at the
  // bottom. keepElementVisible handles any intentional scrolling instead.
  try {
    element.focus({ preventScroll: true });
  } catch {
    element.focus();
  }
  keepElementVisible(element);
}

function keepElementVisible(element) {
  // The ambient view is a fixed, full-bleed overlay (position:fixed; inset:0) —
  // nothing in it is ever in normal scroll flow. scrollIntoView there still
  // scrolls the document on VIDAA and leaves a "bar" stuck at the bottom that
  // never scrolls back, so skip it entirely and hard-pin the page to the top.
  if (document.body.dataset.view === "ambient") {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    return;
  }
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

function isEditableTarget(node) {
  const el = node instanceof HTMLElement ? node : null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function handleRemoteEvent(event) {
  const normalized = normalizeRemoteKey(event);
  logRemoteEvent(event, normalized);
  if (event.type !== "keydown") return;

  // When a text field is focused, let the browser handle keys natively. Otherwise
  // the numpad-digit→D-pad aliases (2/4/5/6/8) would hijack numeric typing and the
  // arrows would navigate focus instead of moving the caret.
  if (isEditableTarget(event.target) || isEditableTarget(document.activeElement)) {
    return;
  }

  switch (normalized) {
    case "ArrowRight":
      event.preventDefault();
      // Right on a focused track row opens its context menu (Enter still plays it).
      if (openTrackMenuFromFocus()) break;
      if (handleAmbientModeArrow("right")) break;
      if (!moveRailFocus("right")) moveFocusDirectional("right");
      break;
    case "ArrowDown":
      event.preventDefault();
      if (isQueueDrawerOpen()) {
        scrollQueueList("down");
        break;
      }
      if (isDiagnosticsOpen()) {
        scrollDiagnostics("down");
        break;
      }
      moveFocusDirectional("down");
      break;
    case "ArrowLeft":
      event.preventDefault();
      if (handleAmbientModeArrow("left")) break;
      if (!moveRailFocus("left")) moveFocusDirectional("left");
      break;
    case "ArrowUp":
      event.preventDefault();
      if (isQueueDrawerOpen()) {
        scrollQueueList("up");
        break;
      }
      if (isDiagnosticsOpen()) {
        scrollDiagnostics("up");
        break;
      }
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
    // Numpad alias for D-pad (phone keypad layout: 2 top → 8 bottom). Lets the
    // user keep navigating when the regular arrows get stuck — particularly
    // useful for scrolling the diagnostics log on the TV. Top-row digits.
    50: "ArrowUp",      // 2
    52: "ArrowLeft",    // 4
    53: "Enter",        // 5
    54: "ArrowRight",   // 6
    56: "ArrowDown",    // 8
    // Numpad codes (some firmwares emit these for the actual keypad keys).
    98: "ArrowUp",      // Numpad2
    100: "ArrowLeft",   // Numpad4
    101: "Enter",       // Numpad5
    102: "ArrowRight",  // Numpad6
    104: "ArrowDown",   // Numpad8
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
    spotifyApiJson("/v1/me/player/recently-played?limit=30"),
    spotifyApiJson("/v1/browse/new-releases?limit=18"),
  ]);
  // Total failure (every endpoint rejected) signals a transient token/network
  // problem — throw so bootstrapData can retry instead of painting empty shelves.
  if (results.every((result) => result.status === "rejected")) {
    throw results[0].reason || new Error("Home data requests all failed.");
  }
  const [playlists, top, recent, newReleases] = results;
  const { own } = splitPlaylists(playlists.value?.items || []);
  renderShelf(elements.playlistsHomeShelf, "Your Playlists", own.slice(0, 18), "playlist", {
    hideIfEmpty: true,
  });
  renderShelf(elements.topShelf, "On Repeat For You", top.value?.items || [], "track", {
    hideIfEmpty: true,
  });
  // Recently-played returns play-history entries ({ track, played_at }) with the
  // same song repeated; unwrap to the track and dedupe by id so the shelf reads
  // as "jump back in", not a literal timeline.
  renderShelf(elements.recentShelf, "Jump Back In", dedupeRecentTracks(recent.value?.items || []), "track", {
    hideIfEmpty: true,
  });
  // Spotify deprecated /recommendations + /browse/featured-playlists, and this
  // account follows no owner:spotify mixes, so "New Releases" is the live source
  // for fresh discovery — kept below the user's familiar shelves.
  renderShelf(elements.newReleasesShelf, "New Releases", newReleases.value?.albums?.items || [], "album", {
    hideIfEmpty: true,
  });
}

function dedupeRecentTracks(items) {
  const seen = new Set();
  const tracks = [];
  for (const entry of items) {
    const track = entry?.track;
    if (!track?.id || seen.has(track.id)) continue;
    seen.add(track.id);
    tracks.push(track);
  }
  return tracks.slice(0, 18);
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
  ["recentShelf", "Jump Back In"],
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
  const head = buildShelfHead(title, kind === "error" ? "Needs attention" : "Loading");
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
  container.append(head, rail);
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

function renderShelf(container, title, items, type, { hideIfEmpty = false, eyebrow } = {}) {
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
  const head = buildShelfHead(title, eyebrow ?? eyebrowForType(type));
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
  container.append(head, rail);
}

// Two-tier shelf header: a small uppercase eyebrow over the larger title.
// Presentation only — neither element is focusable (no .focusable / tabindex),
// so the spatial-focus remote nav pool is untouched.
function buildShelfHead(title, eyebrow) {
  const head = document.createElement("div");
  head.className = "shelf-head";
  if (eyebrow) {
    const kicker = document.createElement("span");
    kicker.className = "shelf-eyebrow";
    kicker.textContent = eyebrow;
    head.append(kicker);
  }
  const heading = document.createElement("h3");
  heading.className = "shelf-title";
  heading.textContent = title;
  head.append(heading);
  return head;
}

function eyebrowForType(type) {
  switch (type) {
    case "playlist":
      return "Playlists";
    case "album":
      return "Albums";
    case "track":
      return "Tracks";
    default:
      return "Library";
  }
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
  activateSpotifyElement();
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
  // Album-track responses are simplified (no nested album); playlist items carry
  // a full track with album art and release date. image/album stay empty for albums.
  const images = track.album?.images || [];
  const releaseDate = track.album?.release_date || "";
  return {
    uri: track.uri || "",
    id: track.id || "",
    name: track.name || "Untitled",
    artist: (track.artists || []).map((artist) => artist.name).join(", "),
    duration: track.duration_ms || 0,
    image: images[images.length - 1]?.url || images[0]?.url || "",
    album: track.album?.name || "",
    year: releaseDate ? releaseDate.slice(0, 4) : "",
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
    const totalMs = coll.tracks.reduce((sum, track) => sum + (track.duration || 0), 0);
    const durationText = totalMs ? formatTotalDuration(totalMs) : "";
    elements.collectionMeta.textContent = [coll.byline, countText, durationText]
      .filter(Boolean)
      .join(" · ");
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
    row.dataset.index = index;
    // Playlists carry per-track art; albums share one cover, so show the track number.
    const hasArt = Boolean(track.image);
    const indexCell = hasArt
      ? `<span class="collection-track__index collection-track__index--art" style="background-image:url('${escapeHtml(track.image)}')">
           <span class="collection-track__eq" aria-hidden="true"><i></i><i></i><i></i></span>
         </span>`
      : `<span class="collection-track__index">
           <span class="collection-track__num">${index + 1}</span>
           <span class="collection-track__eq" aria-hidden="true"><i></i><i></i><i></i></span>
         </span>`;
    const subtitle = [track.artist, track.album].filter(Boolean).join(" · ");
    row.innerHTML = `
      ${indexCell}
      <span class="collection-track__body">
        <span class="collection-track__title">${escapeHtml(track.name)}</span>
        <span class="collection-track__artist">${escapeHtml(subtitle)}</span>
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
  activateSpotifyElement();
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
  // Exit dialog is modal: Back dismisses it (cancel) rather than navigating.
  if (isExitDialogOpen()) {
    cancelExit();
    return;
  }
  // Modal overlays close on Back before any view navigation.
  if (isTrackMenuOpen()) {
    closeTrackMenu();
    return;
  }
  if (isQueueDrawerOpen()) {
    closeQueueDrawer();
    return;
  }
  // Debug overlay traps up/down for scrolling — Back closes it so the remote
  // isn't stuck unable to navigate the rest of the screen.
  if (isDiagnosticsOpen()) {
    toggleDebugView();
    return;
  }
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
  // At the Home root, Back asks whether to close the app instead of being a no-op.
  if (state.currentView === "home") {
    openExitDialog();
    return;
  }
  setView("home");
  log("Back key observed. Returned to Home.");
}

function isExitDialogOpen() {
  return Boolean(elements.exitDialog) && !elements.exitDialog.hidden;
}

let exitDialogReturnFocus = null;

function openExitDialog() {
  const dialog = elements.exitDialog;
  if (!dialog || isExitDialogOpen()) return;
  exitDialogReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  dialog.hidden = false;
  // Default to Cancel so an accidental extra Enter doesn't close the app.
  if (elements.exitDialogCancel) focusElement(elements.exitDialogCancel);
  log("Exit dialog opened.");
}

function closeExitDialog() {
  const dialog = elements.exitDialog;
  if (!dialog || dialog.hidden) return;
  dialog.hidden = true;
  if (exitDialogReturnFocus && document.contains(exitDialogReturnFocus)) {
    focusElement(exitDialogReturnFocus);
  } else {
    const focusables = activeFocusables();
    if (focusables.length) focusElement(focusables[0]);
  }
  exitDialogReturnFocus = null;
}

function cancelExit() {
  closeExitDialog();
  log("Exit cancelled.");
}

function confirmExit() {
  log("Exit confirmed — attempting to close the app.");
  closeExitDialog();
  // Best-effort exit. On the VIDAA app container window.close() returns the user to
  // the launcher; some firmware exposes a Hisense exit hook. Desktop browsers ignore
  // window.close() for non-script-opened windows — that's fine, the dialog is already
  // gone. Each call is wrapped because some TV builds throw on unsupported APIs.
  try {
    if (typeof window.Hisense_exitApp === "function") window.Hisense_exitApp();
  } catch {}
  try { window.close(); } catch {}
}

/* ------------------------------------------------------------------ *
 * #49 Now Playing queue drawer
 * ------------------------------------------------------------------ */

function isQueueDrawerOpen() {
  return Boolean(elements.queueDrawer) && !elements.queueDrawer.hidden;
}

async function openQueueDrawer() {
  const drawer = elements.queueDrawer;
  if (!drawer || isQueueDrawerOpen()) return;
  state.queueReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  drawer.hidden = false;
  drawer.classList.add("is-open");
  renderQueueDrawer();
  const close = drawer.querySelector(".queue-drawer__close");
  if (close) focusElement(close);
  log("Queue drawer opened.");
  try {
    await fetchQueueItems();
    if (isQueueDrawerOpen()) renderQueueDrawer();
  } catch (error) {
    logError("Queue load failed", error);
    if (isQueueDrawerOpen()) renderQueueDrawer(error?.message || "Couldn't load the queue.");
  }
}

function closeQueueDrawer() {
  const drawer = elements.queueDrawer;
  if (!drawer || drawer.hidden) return;
  drawer.classList.remove("is-open");
  drawer.hidden = true;
  const ret = state.queueReturnFocus;
  state.queueReturnFocus = null;
  if (ret && document.contains(ret)) focusElement(ret);
  else {
    const focusables = activeFocusables();
    if (focusables.length) focusElement(focusables[0]);
  }
  log("Queue drawer closed.");
}

// VIDAA has no wheel — Up/Down scroll the queue list while the drawer is open.
function scrollQueueList(direction) {
  const list = elements.queueList;
  if (!list) return;
  const step = Math.max(120, list.clientHeight - 60);
  try {
    list.scrollBy({ top: direction === "down" ? step : -step, behavior: "smooth" });
  } catch {
    list.scrollTop += direction === "down" ? step : -step;
  }
}

function normalizeQueueTrack(item) {
  const images = item?.album?.images || [];
  return {
    uri: item?.uri || "",
    name: item?.name || "Untitled",
    artist: (item?.artists || []).map((a) => a.name).join(", "),
    image: images[images.length - 1]?.url || images[0]?.url || "",
  };
}

async function fetchQueueItems() {
  const data = await spotifyApiJson("/v1/me/player/queue");
  const items = Array.isArray(data?.queue) ? data.queue : [];
  state.queueItems = items.map(normalizeQueueTrack);
  return state.queueItems;
}

function renderQueueDrawer(errorMessage) {
  const list = elements.queueList;
  if (!list) return;
  list.replaceChildren();
  if (errorMessage) {
    const note = document.createElement("p");
    note.className = "queue-drawer__note queue-drawer__note--error";
    note.textContent = errorMessage;
    list.append(note);
    return;
  }
  const items = state.queueItems;
  if (!items || !items.length) {
    const note = document.createElement("p");
    note.className = "queue-drawer__note";
    note.textContent = "Nothing queued. Add tracks from a collection's ⋯ menu.";
    list.append(note);
    return;
  }
  items.forEach((track, index) => {
    const row = document.createElement("div");
    row.className = "queue-row";
    row.setAttribute("role", "listitem");
    const art = track.image ? `url("${escapeHtml(track.image)}")` : "none";
    row.innerHTML = `
      <span class="queue-row__art" style="background-image:${art}"></span>
      <span class="queue-row__body">
        <span class="queue-row__title">${escapeHtml(track.name)}</span>
        <span class="queue-row__artist">${escapeHtml(track.artist)}</span>
      </span>
      <span class="queue-row__pos">${index + 1}</span>
    `;
    list.append(row);
  });
}

/* ------------------------------------------------------------------ *
 * #50 Track context menu (Add to Queue / Add to Playlist)
 * ------------------------------------------------------------------ */

function isTrackMenuOpen() {
  return Boolean(elements.trackMenu) && !elements.trackMenu.hidden;
}

// If a Collection track row currently has focus, open its menu (Right arrow).
function openTrackMenuFromFocus() {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  const row = active.closest(".collection-track");
  if (!row) return false;
  const index = Number(row.dataset.index);
  const track = state.collection?.tracks?.[index];
  if (!track || !track.uri) return false;
  openTrackMenu(track);
  return true;
}

function openTrackMenu(track) {
  const menu = elements.trackMenu;
  if (!menu || isTrackMenuOpen()) return;
  state.trackMenuTrack = track;
  state.trackMenuReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (elements.trackMenuTitle) elements.trackMenuTitle.textContent = track.name || "Track";
  if (elements.trackMenuArtist) elements.trackMenuArtist.textContent = track.artist || "";
  if (elements.trackMenuArt) {
    if (track.image) elements.trackMenuArt.src = track.image;
    else elements.trackMenuArt.removeAttribute("src");
  }
  menu.hidden = false;
  menu.classList.add("is-open");
  renderTrackMenuRoot();
  log(`Track menu opened: ${track.name}`);
}

function closeTrackMenu() {
  const menu = elements.trackMenu;
  if (!menu || menu.hidden) return;
  menu.classList.remove("is-open");
  menu.hidden = true;
  const ret = state.trackMenuReturnFocus;
  state.trackMenuTrack = null;
  state.trackMenuReturnFocus = null;
  if (ret && document.contains(ret)) focusElement(ret);
  else {
    const focusables = activeFocusables();
    if (focusables.length) focusElement(focusables[0]);
  }
  log("Track menu closed.");
}

function trackMenuButton(label, onActivate, extraClass) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `focusable track-menu__action${extraClass ? " " + extraClass : ""}`;
  btn.textContent = label;
  btn.addEventListener("click", onActivate);
  return btn;
}

function focusFirstActive() {
  const focusables = activeFocusables();
  if (focusables.length) focusElement(focusables[0]);
}

function renderTrackMenuRoot() {
  const wrap = elements.trackMenuActions;
  if (!wrap) return;
  wrap.replaceChildren();
  const track = state.trackMenuTrack;
  if (!track) return;
  wrap.append(trackMenuButton("Add to Queue", () => {
    addTrackToQueue(track).catch((error) => {
      logError("Add to queue failed", error);
      showToast("Couldn't add to the queue.", "error");
    });
  }));
  wrap.append(trackMenuButton("Add to Playlist…", () => {
    openPlaylistPicker(track).catch((error) => logError("Playlist picker failed", error));
  }));
  focusFirstActive();
}

async function addTrackToQueue(track) {
  if (!track?.uri) return;
  await ensureSpotifyDeviceReady();
  const response = await spotifyApiFetch(
    withDeviceIdParam(`/v1/me/player/queue?uri=${encodeURIComponent(track.uri)}`),
    { method: "POST" }
  );
  if (!response.ok) {
    throw new Error(`Add to queue failed (${response.status}): ${await readSpotifyError(response)}`);
  }
  showToast(`Added "${track.name}" to the queue.`, "success");
  log(`Queued ${track.name}.`, "success");
  closeTrackMenu();
}

// Editable = owned by the current user, or collaborative. Cached after first load.
async function ensureUserPlaylists() {
  if (Array.isArray(state.userPlaylists)) return state.userPlaylists;
  const [me, data] = await Promise.all([
    spotifyApiJson("/v1/me"),
    spotifyApiJson("/v1/me/playlists?limit=50"),
  ]);
  const userId = me?.id || "";
  const all = Array.isArray(data?.items) ? data.items : [];
  state.userPlaylists = all
    .filter((p) => p && p.id && (p.collaborative || (userId && p.owner?.id === userId)))
    .map((p) => ({ id: p.id, name: p.name || "Untitled" }));
  return state.userPlaylists;
}

async function openPlaylistPicker(track) {
  const wrap = elements.trackMenuActions;
  if (!wrap) return;
  wrap.replaceChildren();
  const loading = document.createElement("p");
  loading.className = "track-menu__note";
  loading.textContent = "Loading your playlists…";
  wrap.append(loading);
  let playlists = [];
  try {
    playlists = await ensureUserPlaylists();
  } catch (error) {
    logError("Load playlists failed", error);
    if (!isTrackMenuOpen()) return;
    wrap.replaceChildren();
    wrap.append(trackMenuButton("‹ Back", renderTrackMenuRoot, "track-menu__action--ghost"));
    const note = document.createElement("p");
    note.className = "track-menu__note track-menu__note--error";
    note.textContent = "Couldn't load playlists.";
    wrap.append(note);
    focusFirstActive();
    return;
  }
  if (!isTrackMenuOpen()) return;
  wrap.replaceChildren();
  wrap.append(trackMenuButton("‹ Back", renderTrackMenuRoot, "track-menu__action--ghost"));
  if (!playlists.length) {
    const note = document.createElement("p");
    note.className = "track-menu__note";
    note.textContent = "No editable playlists found.";
    wrap.append(note);
  } else {
    playlists.forEach((pl) => {
      wrap.append(trackMenuButton(pl.name, () => {
        addTrackToPlaylist(pl, track).catch((error) => {
          logError("Add to playlist failed", error);
          showToast("Couldn't add to that playlist.", "error");
        });
      }));
    });
  }
  focusFirstActive();
}

async function addTrackToPlaylist(playlist, track) {
  if (!playlist?.id || !track?.uri) return;
  const response = await spotifyApiFetch(`/v1/playlists/${playlist.id}/tracks`, {
    method: "POST",
    body: JSON.stringify({ uris: [track.uri] }),
  });
  if (!response.ok) {
    throw new Error(`Add to playlist failed (${response.status}): ${await readSpotifyError(response)}`);
  }
  showToast(`Added "${track.name}" to ${playlist.name}.`, "success");
  log(`Added ${track.name} to playlist ${playlist.name}.`, "success");
  closeTrackMenu();
}

/* ------------------------------------------------------------------ *
 * #51 Up-next preview (final ~12s of a song)
 * ------------------------------------------------------------------ */

const UP_NEXT_WINDOW_MS = 12000;

function maybeUpdateUpNext(position, now) {
  if (!now || now.paused) { hideUpNext(); return; }
  const remaining = (now.duration || 0) - position;
  const inWindow = now.duration > 0 && remaining > 0 && remaining <= UP_NEXT_WINDOW_MS;
  const showHere = state.currentView === "now" || state.currentView === "ambient";
  if (!inWindow || !showHere) { hideUpNext(); return; }
  // Fetch the queue once when we first enter this song's final window.
  if (state.upNextTrackId !== now.id) {
    state.upNextTrackId = now.id;
    fetchQueueItems()
      .then(() => { if (state.upNextTrackId === now.id) showUpNextCard(); })
      .catch((error) => logError("Up-next queue fetch failed", error));
    return;
  }
  showUpNextCard();
}

function showUpNextCard() {
  const card = elements.upNext;
  if (!card) return;
  const next = state.queueItems?.[0];
  if (!next) { hideUpNext(); return; }
  if (elements.upNextTitle) elements.upNextTitle.textContent = next.name;
  if (elements.upNextArtist) elements.upNextArtist.textContent = next.artist;
  if (elements.upNextArt) {
    if (next.image) elements.upNextArt.src = next.image;
    else elements.upNextArt.removeAttribute("src");
  }
  card.hidden = false;
  card.classList.add("is-visible");
}

function hideUpNext() {
  const card = elements.upNext;
  if (!card || card.hidden) return;
  card.classList.remove("is-visible");
  card.hidden = true;
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

// Desktop/web browsers gate the SDK's <audio> element behind a user gesture: until
// activateElement() runs inside a click/keypress, the device registers as ready but
// can't actually render audio. Issuing /play then fails with "Playback error" and
// Spotify Connect auto-skips through the context trying to recover — which is the
// "skips a few songs before it starts" bug. We must call this synchronously from the
// gesture (before any await), so playback entry points invoke it first thing. Once
// unlocked it stays unlocked, so this is a one-time no-op after the first play.
function activateSpotifyElement() {
  if (state.spotifyElementActivated) return;
  const player = state.spotifyPlayer;
  if (!player || typeof player.activateElement !== "function") return;
  try {
    const result = player.activateElement();
    state.spotifyElementActivated = true;
    log("Spotify audio element activated for playback.", "success");
    if (result && typeof result.catch === "function") {
      result.catch((error) => {
        state.spotifyElementActivated = false;
        logError("activateElement failed", error);
      });
    }
  } catch (error) {
    logError("activateElement threw", error);
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

// Ambient is always presented as a full-bleed room display now — there's no
// separate fullscreen toggle. CSS makes the stage cover the viewport whenever
// .ambient-view.is-visible is up.

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
  activateSpotifyElement();
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
  if (elements.sceneNpProgressFill) {
    elements.sceneNpProgressFill.style.width = `${percent}%`;
  }
  if (elements.sceneNpTime) {
    elements.sceneNpTime.textContent = timeText;
  }
  maybeUpdateUpNext(position, now);
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

function toggleSceneImageSequence() {
  state.sceneUseImageSequence = !state.sceneUseImageSequence;
  try {
    localStorage.setItem(storageKeys.sceneImageSequence, state.sceneUseImageSequence ? "1" : "0");
  } catch {}
  applySceneImageSequenceState();
  log(`Scene image-sequence mode ${state.sceneUseImageSequence ? "enabled" : "disabled"}.`);
  if (state.currentView === "ambient" && state.ambientMode === "screensaver") {
    syncAmbientVideo();
  }
}

function applySceneImageSequenceState() {
  const btn = document.getElementById("toggleSceneImgSeq");
  const label = document.getElementById("toggleSceneImgSeqState");
  if (btn) btn.setAttribute("aria-checked", state.sceneUseImageSequence ? "true" : "false");
  if (label) label.textContent = state.sceneUseImageSequence ? "On" : "Off";
}

function toggleSceneStripAudio() {
  state.sceneStripAudio = !state.sceneStripAudio;
  try {
    localStorage.setItem(storageKeys.sceneStripAudio, state.sceneStripAudio ? "1" : "0");
  } catch {}
  applySceneStripState();
  log(`Scene audio strip ${state.sceneStripAudio ? "enabled" : "disabled"}.`);
  // If Scene is currently running, restart so the change takes effect on the
  // next clip rather than only after the user toggles modes.
  if (state.currentView === "ambient" && state.ambientMode === "screensaver") {
    startScenePlayback();
  }
}

function applySceneStripState() {
  const btn = document.getElementById("toggleSceneStrip");
  const label = document.getElementById("toggleSceneStripState");
  if (btn) btn.setAttribute("aria-checked", state.sceneStripAudio ? "true" : "false");
  if (label) label.textContent = state.sceneStripAudio ? "On" : "Off";
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

// Auto-resume removed: the tug-of-war was bidirectional — resuming Spotify made
// the video stop. The real fix is to strip the audio track out of Pexels MP4s
// in-browser (see mp4box-based audio-stripping below), so the firmware never
// sees a competing audio decoder in the first place.

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

// On the TV (old Blink) a muted <video> that still carries an audio track grabs the
// single hardware audio decoder / audio focus, which pauses the Spotify Web Playback
// SDK — and when Spotify plays, the video stalls. They become mutually exclusive.
// Desktop Chromium handles muted video fine, so this is purely defensive for the TV.
// The HTML `muted` attribute alone isn't enough; we force the muting properties AND
// disable the clip's audio tracks outright so the video never enters the audio
// pipeline. audioTracks populates after loadedmetadata, so call this then too.
function silenceVideoEl(el) {
  if (!el) return;
  el.muted = true;
  el.defaultMuted = true;
  el.volume = 0;
  try { el.disableRemotePlayback = true; } catch {}
  const tracks = el.audioTracks;
  if (tracks && typeof tracks.length === "number") {
    for (let i = 0; i < tracks.length; i += 1) {
      try { tracks[i].enabled = false; } catch {}
    }
  }
}

// === Audio stripping for Pexels Scene clips ==================================
// The TV firmware only allows one audio decoder at a time, so a muted Pexels clip
// (which still carries an AAC track) tugs audio focus away from the Spotify SDK.
// We can't strip the audio at the HTTP layer, so we demux the MP4 in-browser with
// mp4box.js and feed only the video samples to the <video> via MediaSource
// Extensions. The firmware sees a track-less video and never engages its audio
// decoder, so Spotify keeps playing.
//
// This is opt-in via Settings -> "Scene: strip audio (experimental)". If anything
// in the pipeline fails (MSE not supported, mp4box throws, codec rejected), we
// fall back to the plain <video src=url> path so Scene at least shows clips.

// Visible status badge on the Scene now-playing card. State is one of:
//   "idle"  — Scene not running
//   "strip" — mp4box+MSE actively delivering an audio-stripped video stream
//   "plain" — Strip path unavailable / off: playing original URL (conflict-prone)
//   "error" — A clip failed to load entirely
function setSceneStripStatus(state, detail) {
  const el = elements.sceneNpStatus;
  if (!el) return;
  el.dataset.state = state;
  const labels = {
    idle: "Scene: idle",
    strip: `Audio stripped${detail ? " · " + detail : ""}`,
    plain: `Audio active${detail ? " · " + detail : ""}`,
    error: `Clip failed${detail ? " · " + detail : ""}`,
  };
  el.textContent = labels[state] || state;
}

// Web Audio sink neutralization: route a video element's audio output through
// Web Audio with a zero-gain node. Some firmwares respect Web Audio's sink as
// the active audio surface, which can prevent the native video pipeline from
// grabbing audio focus when an audio track slips through (e.g., when the strip
// path falls back to plain URL). createMediaElementSource can only be called
// once per element, so we track which ones we've already routed.
const _webAudioRouted = new WeakSet();
function neutralizeVideoAudioWithWebAudio(videoEl) {
  if (!videoEl || _webAudioRouted.has(videoEl)) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const src = ctx.createMediaElementSource(videoEl);
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(gain);
    gain.connect(ctx.destination);
    _webAudioRouted.add(videoEl);
  } catch {
    // Already routed, insecure context, or unsupported — best-effort.
  }
}

function audioStripSupported() {
  try {
    return (
      typeof window.MediaSource !== "undefined" &&
      typeof window.MP4Box !== "undefined" &&
      typeof window.fetch !== "undefined" &&
      typeof Response !== "undefined"
    );
  } catch {
    return false;
  }
}

// Returns a Promise that resolves once the video element is playing (or rejects
// on demux/MSE failure so callers can fall back to the plain URL path).
async function playSceneClipStripped(videoEl, url, tokenRef) {
  if (!audioStripSupported()) throw new Error("Audio strip not supported");

  // Clear any previous Blob URL on this element (its old MediaSource is dead).
  try { URL.revokeObjectURL(videoEl.src); } catch {}

  const ms = new MediaSource();
  videoEl.src = URL.createObjectURL(ms);
  state.sceneStripBlobs.push(videoEl.src);

  await new Promise((resolve, reject) => {
    const onOpen = () => { ms.removeEventListener("sourceopen", onOpen); resolve(); };
    const onErr = (e) => { ms.removeEventListener("error", onErr); reject(e || new Error("MediaSource error")); };
    ms.addEventListener("sourceopen", onOpen);
    ms.addEventListener("error", onErr);
  });

  return new Promise((resolve, reject) => {
    const mp4box = window.MP4Box.createFile();
    let sourceBuffer = null;
    let videoTrackId = null;
    let appendQueue = [];
    let mp4boxStopped = false;

    const tryAppend = () => {
      if (!sourceBuffer || sourceBuffer.updating || !appendQueue.length) return;
      const next = appendQueue.shift();
      try { sourceBuffer.appendBuffer(next.buffer); } catch (e) { reject(e); }
      if (next.is_last) {
        sourceBuffer.addEventListener("updateend", () => {
          try { ms.endOfStream(); } catch {}
        }, { once: true });
      }
    };

    mp4box.onReady = (info) => {
      // Token check: if user left Scene while we were loading, bail.
      if (tokenRef.cancelled) { mp4boxStopped = true; reject(new Error("Cancelled")); return; }
      const videoTrack = info.tracks.find((t) => t.type === "video");
      if (!videoTrack) { reject(new Error("No video track in MP4")); return; }
      videoTrackId = videoTrack.id;
      // mp4box gives us a codec string like "avc1.640028" — exactly what MSE wants.
      const mime = `video/mp4; codecs="${videoTrack.codec}"`;
      if (!window.MediaSource.isTypeSupported(mime)) { reject(new Error(`MIME not supported: ${mime}`)); return; }
      // We have a confirmed video-only feed coming. Mark status so the user can
      // see at a glance that the strip path is actually engaged.
      setSceneStripStatus("strip", videoTrack.codec);
      try {
        sourceBuffer = ms.addSourceBuffer(mime);
      } catch (e) { reject(e); return; }
      sourceBuffer.mode = "segments";
      sourceBuffer.addEventListener("updateend", tryAppend);

      mp4box.setSegmentOptions(videoTrack.id, null, { nbSamples: 60 });
      const initSegs = mp4box.initializeSegmentation();
      for (const seg of initSegs) {
        if (seg.id === videoTrack.id) appendQueue.push({ buffer: seg.buffer, is_last: false });
      }
      tryAppend();
      mp4box.start();
    };

    mp4box.onSegment = (id, _user, buffer, _sampleNum, is_last) => {
      if (mp4boxStopped) return;
      if (id !== videoTrackId) return;
      appendQueue.push({ buffer, is_last });
      tryAppend();
    };

    mp4box.onError = (e) => { reject(new Error(`mp4box error: ${e}`)); };

    // Stream the MP4 in. We feed appendBuffer with fileStart offsets so mp4box
    // can keep its internal byte map; we don't need the whole file in memory.
    (async () => {
      try {
        const response = await fetch(url);
        if (!response.ok) { reject(new Error(`Fetch failed ${response.status}`)); return; }
        const reader = response.body.getReader();
        let offset = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          if (tokenRef.cancelled) { reject(new Error("Cancelled")); return; }
          const { done, value } = await reader.read();
          if (done) { mp4box.flush(); break; }
          const ab = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
          ab.fileStart = offset;
          offset += value.byteLength;
          mp4box.appendBuffer(ab);
        }
      } catch (err) { reject(err); }
    })();

    // Kick playback once enough has buffered. play() can reject if the firmware
    // refuses the source — surface that so the caller falls back.
    videoEl.addEventListener("canplay", () => {
      videoEl.play().then(resolve).catch(reject);
    }, { once: true });
  });
}

function clearSceneStripBlobs() {
  for (const url of state.sceneStripBlobs) {
    try { URL.revokeObjectURL(url); } catch {}
  }
  state.sceneStripBlobs = [];
}

// === Image-sequence Scene renderer ==========================================
// The TV's firmware pauses other media when a <video> decodes. Image sequences
// don't engage that pipeline at all — we just swap an <img> element's src at
// the source fps, which the renderer treats like any other image update.
//
// We rely on the Cloud Function-curated library in Firestore: each "clip" is
// an array of pre-generated JPG URLs at a known fps. Local cycling is cheap.

function stopImageSequence() {
  if (state.sceneImageTimer) {
    window.clearInterval(state.sceneImageTimer);
    state.sceneImageTimer = 0;
  }
}

async function playImageSequence(clip, token) {
  stopImageSequence();
  const img = elements.ambientImgSeq;
  if (!img || !clip || !clip.frames?.length) throw new Error("No frames");

  // Preload the first few frames so the cycle doesn't blink on startup.
  // We rely on browser HTTP cache for the rest as we cycle through.
  const preloadCount = Math.min(6, clip.frames.length);
  await Promise.all(clip.frames.slice(0, preloadCount).map((url) => new Promise((resolve) => {
    const probe = new Image();
    probe.onload = resolve;
    probe.onerror = resolve;
    probe.src = url;
  })));
  if (state.sceneToken !== token) return;

  // Mark the screensaver as imgseq-mode so CSS hides the <video> elements and
  // shows the <img>. setSceneStripStatus advertises which path is live.
  if (elements.ambientScreensaver) elements.ambientScreensaver.dataset.video = "imgseq";
  setSceneStripStatus("strip", `imgseq ${clip.frames.length}f@${clip.fps}fps`);

  const interval = Math.max(60, Math.round(1000 / (clip.fps || 10)));
  let i = 0;
  img.src = clip.frames[0];
  state.sceneImageTimer = window.setInterval(() => {
    if (state.sceneToken !== token) { stopImageSequence(); return; }
    i = (i + 1) % clip.frames.length;
    img.src = clip.frames[i];
  }, interval);
}

// Pick a random clip from the loaded library matching the user's category.
function pickLibraryClip(library) {
  const cat = state.sceneCategory || "nature";
  const list = library[cat] || [];
  if (!list.length) return null;
  return list[Math.floor(Math.random() * list.length)];
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
    stopImageSequence();
    clearSceneStripBlobs();
    setSceneStripStatus("idle");
    return;
  }

  // Image-sequence path: bypass <video> entirely, animate <img> frames from
  // the pre-converted library. The Cloud Function refreshes this set weekly.
  if (state.sceneUseImageSequence) {
    startImageSequencePlayback();
    return;
  }
  // Already running with a visible clip — resume it. Re-arm the onended advance
  // with a fresh token (the previous token was invalidated when Scene was paused).
  if (screensaver.dataset.video === "on" && activeSceneVideo()?.currentSrc) {
    const token = ++state.sceneToken;
    const current = activeSceneVideo();
    silenceVideoEl(current);
    current.onended = () => {
      if (token !== state.sceneToken) return;
      advanceSceneClip(token);
    };
    current.play().catch(() => {});
    return;
  }
  startScenePlayback();
}

// Image-sequence Scene: pull the pre-converted library from Firestore and pick
// a random clip in the user's category. We cycle frames until the user leaves
// Scene or category changes (token bump cancels the loop), then pick another.
async function startImageSequencePlayback() {
  const token = ++state.sceneToken;
  const screensaver = elements.ambientScreensaver;
  if (!screensaver) return;

  // Stale-cancel guard: any token bump (leaving Scene, category change, recursion)
  // makes this run a no-op at the next checkpoint — no polling watcher needed.
  try {
    setSceneStripStatus("strip", "loading library…");
    const library = await loadSceneLibrary();
    if (state.sceneToken !== token) return;
    const clip = pickLibraryClip(library);
    if (!clip) {
      log("Scene: image-sequence library is empty; falling back to <video>.", "warn");
      showToast("Scene library empty. Deploy the function or use video mode.", "warn");
      setSceneStripStatus("plain", "library empty");
      // Fall through to the regular <video> path.
      state.sceneUseImageSequence = false;
      startScenePlayback();
      return;
    }
    await playImageSequence(clip, token);

    // When this clip's frames have cycled a few times, advance to another one.
    // Random advance keeps it feeling like the old multi-clip rotation.
    const cycleMs = (clip.frames.length / (clip.fps || 10)) * 1000;
    window.setTimeout(() => {
      if (state.sceneToken !== token) return;
      // Recurse to pick a new random clip.
      startImageSequencePlayback();
    }, Math.max(8000, cycleMs * 2));
  } catch (err) {
    if (state.sceneToken !== token) return;
    log(`Scene image-sequence failed: ${err?.message || err}; falling back.`, "warn");
    showToast(`Scene library load failed: ${err?.message || err}`, "warn");
    setSceneStripStatus("error", err?.message);
    state.sceneUseImageSequence = false;
    startScenePlayback();
  }
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
  next.onloadedmetadata = null;

  silenceVideoEl(next);
  // audioTracks are only known once metadata loads, so re-disable them then.
  next.onloadedmetadata = () => {
    if (token !== state.sceneToken) return;
    silenceVideoEl(next);
  };

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
    // TV firmware can steal audio focus when this clip's audio track lands —
    // re-claim it for the Spotify SDK so music doesn't pause.
    log(`Scene clip playing (${state.sceneSource}): ${url}`, "success");
  };

  // Belt-and-suspenders: route this video element's audio through Web Audio
  // with a 0-gain sink, so even if a track sneaks through (strip fallback path
  // or unstripped local clip), the firmware sees Web Audio as the sink and not
  // the native video output. May or may not help on VIDAA, but cheap to try.
  neutralizeVideoAudioWithWebAudio(next);

  // Path A: strip audio via mp4box + MSE for Pexels clips when the toggle is on.
  // We only attempt this on remote (Pexels) clips — local loops are already
  // audio-free, so they go through the plain <video src> path.
  const shouldStrip = state.sceneStripAudio && state.sceneSource === "pexels" && audioStripSupported();
  if (shouldStrip) {
    const tokenRef = { cancelled: false };
    // If the scene token bumps mid-load, mark this strip attempt cancelled.
    const startedAt = state.sceneToken;
    const cancelWatcher = window.setInterval(() => {
      if (state.sceneToken !== startedAt) {
        tokenRef.cancelled = true;
        window.clearInterval(cancelWatcher);
      }
    }, 400);
    playSceneClipStripped(next, url, tokenRef)
      .then(() => { window.clearInterval(cancelWatcher); })
      .catch((err) => {
        window.clearInterval(cancelWatcher);
        if (tokenRef.cancelled) return;
        const reason = err?.message || String(err);
        log(`Scene: audio-strip failed (${reason}); falling back to plain URL.`, "warn");
        // Make it visible on the TV — the user shouldn't need to dig into logs
        // to know whether the strip is engaged or not.
        showToast(`Scene strip failed: ${reason}. Falling back.`, "warn");
        setSceneStripStatus("plain", "strip failed");
        // Fallback to plain <video src=url> — same conflict as before, but at
        // least the clip plays. This single-clip fallback is non-destructive.
        try { next.src = url; next.load(); next.play().catch(() => {}); } catch {}
      });
    return;
  }

  // Path B: plain URL — used for local loops and the strip-disabled state.
  setSceneStripStatus("plain", state.sceneSource === "local" ? "local clip" : "strip off");
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

// Segmented control: pick a category directly. No-op if already active, otherwise
// persist it, reflect the active segment, and rebuild the playlist.
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
    // Cancel any in-flight load and start fresh for the new category.
    startScenePlayback();
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

// Human-readable total for a collection header, e.g. "1 hr 23 min" / "47 min".
function formatTotalDuration(ms) {
  const totalMinutes = Math.round(Math.max(0, ms) / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours} hr${minutes ? ` ${minutes} min` : ""}`;
  return `${minutes} min`;
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
  div.className = "card card--placeholder";
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
