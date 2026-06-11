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
  "user-library-modify",
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
  autoplaySimilar: "spotify-pwa.autoplay-similar",
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
// === Procedural Scene =========================================================
// Scene is rendered entirely client-side: layered silhouette SVGs with very slow
// CSS parallax drift + one 30fps-capped canvas for particles (stars, clouds, car
// streaks). No <video> ever plays — the TV firmware pauses Spotify whenever a
// video with an audio track engages the decoder, and even silent clips proved
// unreliable, so the whole video/Pexels/Firestore clip pipeline was removed.
const SCENE_CATEGORIES = ["nature", "skyline"];
const SCENE_CATEGORY_LABELS = { nature: "Nature", skyline: "City" };
// Time-of-day flavors tint the sky/glow. Entry picks by the local clock; Skip
// re-rolls everything (seed, flavor, palette mix) for a fresh variation.
const SCENE_FLAVORS = ["dawn", "evening", "night"];

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
  sceneSeed: 0, // PRNG seed for the procedural scene; Skip re-rolls it
  sceneFlavor: "", // "dawn" | "evening" | "night" — clock-picked on entry, re-rolled on Skip
  sceneBuiltKey: "", // `${category}:${seed}` of the scene currently in the DOM
  sceneRaf: 0, // rAF handle for the scene particle canvas (30fps capped)
  sceneRect: null, // cached canvas CSS-pixel size — measured outside the draw loop
  sceneResizeHandler: null,
  sceneParticles: null, // seeded stars/clouds/car streaks consumed by the draw loop
  sceneTintables: null, // node refs the palette re-tint touches without rebuilding geometry
  // The Web Playback SDK only emits player_state_changed for the TV's own device.
  // When playback is on the phone (or any other device) we'd never hear about
  // track changes — so we poll /v1/me/player here as the truth source. Cadence
  // adapts to the current view (fast on Now/Ambient where staleness is visible).
  playbackPollTimer: 0,
  playbackPollInFlight: false,
  playbackPollBackoffUntil: 0,
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
  artist: null, // artist-page state (id, name, image, topTracks, albums)
  artistReturnView: "home",
  dataLoaded: false,
  dataLoading: false,
  queueItems: [], // last-fetched upcoming queue (from /me/player/queue)
  queueReturnFocus: null,
  // The queue API can't tell us *why* an item is queued, so we remember the URIs
  // we POSTed ourselves this session. Anything else in GET /me/player/queue is
  // context continuation (album/playlist Spotify keeps playing by itself).
  sessionQueuedUris: new Set(), // every uri we queued (menu + radio)
  radioQueuedUris: new Set(), // subset queued by radio auto-fill
  radioSeedArtist: "", // artist name the last radio batch was seeded from
  radioSeededTrackId: "", // latch: radio fires at most once per playing track
  radioToastShown: false, // first-fire toast, once per session
  autoplaySimilar: true, // "Autoplay similar music" Settings toggle (persisted)
  recentlyPlayedCache: null, // { ids:Set, fetchedAt } — radio dedupe source
  contextNameCache: {}, // context uri → resolved album/playlist name
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
  ambientRoomArtB: document.querySelector("#ambientRoomArtB"),
  ambientRoomArtFrame: document.querySelector("#ambientRoomArtFrame"),
  sceneNp: document.querySelector("#sceneNp"),
  sceneNpArt: document.querySelector("#sceneNpArt"),
  sceneNpTitle: document.querySelector("#sceneNpTitle"),
  sceneNpArtist: document.querySelector("#sceneNpArtist"),
  sceneNpProgressFill: document.querySelector("#sceneNpProgressFill"),
  sceneNpTime: document.querySelector("#sceneNpTime"),
  sceneNpStatus: document.querySelector("#sceneNpStatus"),
  ambientVisualizerCanvas: document.querySelector("#ambientVisualizerCanvas"),
  ambientVisualizerArt: document.querySelector("#ambientVisualizerArt"),
  ambientScreensaver: document.querySelector("#ambientScreensaver"),
  sceneSky: document.querySelector("#sceneSky"),
  sceneCanvas: document.querySelector("#sceneCanvas"),
  sceneFgCanvas: document.querySelector("#sceneFgCanvas"),
  sceneLayerFar: document.querySelector("#sceneLayerFar"),
  sceneLayerMid: document.querySelector("#sceneLayerMid"),
  sceneLayerNear: document.querySelector("#sceneLayerNear"),
  sceneMist: document.querySelector("#sceneMist"),
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
  collectionSaveBtn: document.querySelector("#collectionSaveBtn"),
  collectionTracks: document.querySelector("#collectionTracks"),
  searchKeys: document.querySelector("#searchKeys"),
  searchQueryText: document.querySelector("#searchQueryText"),
  searchHint: document.querySelector("#searchHint"),
  searchTracksShelf: document.querySelector("#searchTracksShelf"),
  searchArtistsShelf: document.querySelector("#searchArtistsShelf"),
  searchAlbumsShelf: document.querySelector("#searchAlbumsShelf"),
  searchPlaylistsShelf: document.querySelector("#searchPlaylistsShelf"),
  artistBackdrop: document.querySelector("#artistBackdrop"),
  artistArt: document.querySelector("#artistArt"),
  artistTitle: document.querySelector("#artistTitle"),
  artistMeta: document.querySelector("#artistMeta"),
  artistTopTracks: document.querySelector("#artistTopTracks"),
  artistAlbumsShelf: document.querySelector("#artistAlbumsShelf"),
  viewArtist: document.querySelector("#view-artist"),
  diagnostics: document.querySelector("#diagnostics"),
  toggleDebugView: document.querySelector("#toggleDebugView"),
  toggleDebugState: document.querySelector("#toggleDebugState"),
  viewAmbient: document.querySelector("#view-ambient"),
  viewNow: document.querySelector("#view-now"),
  viewCollection: document.querySelector("#view-collection"),
  navRail: document.querySelector("#navRail"),
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
      // Now that we have a token, start the recurring poll so external playback
      // (phone next-track, etc.) propagates here without waiting for a user action.
      startPlaybackPolling("bootstrap");
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

function focusableElements() {
  return activeFocusables();
}

// Mirrors :focus-within as a .has-focus class — the VIDAA browser predates the
// pseudo-class, and the rail/ambient-control reveals depend on it.
function wireFocusWithinClass(container) {
  if (!container) return;
  container.addEventListener("focusin", () => container.classList.add("has-focus"));
  container.addEventListener("focusout", (event) => {
    const next = event.relatedTarget;
    if (!next || !container.contains(next)) container.classList.remove("has-focus");
  });
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
    panel.scrollBy({ top: direction === "down" ? step : -step, behavior: _repeatScrollInstant ? "auto" : "smooth" });
  } catch {
    panel.scrollTop += direction === "down" ? step : -step;
  }
  return true;
}

// --- W4: focusables memoization ---------------------------------------------
// Resolving the focus pool walks the DOM (querySelectorAll + getComputedStyle +
// getBoundingClientRect per element) and used to run on every arrow keypress —
// expensive on the TV's CPU. Cache the resolved array and invalidate it from
// every render/visibility mutation site (invalidateFocusables). The cache key
// captures modal/view context so view switches and modal opens re-resolve on
// their own; the isConnected sweep self-heals after any replaceChildren path
// that slipped through without an explicit invalidate.
let _focusablesCache = null;
let _focusablesCacheKey = "";

function invalidateFocusables() {
  _focusablesCache = null;
}

function focusablesContextKey() {
  return [
    isExitDialogOpen() ? "exit" : "",
    isTrackMenuOpen() ? "menu" : "",
    isQueueDrawerOpen() ? "drawer" : "",
    state.currentView,
    isDiagnosticsOpen() ? "diag" : "",
  ].join("|");
}

function activeFocusables() {
  const key = focusablesContextKey();
  if (_focusablesCache && _focusablesCacheKey === key) {
    let intact = true;
    for (const el of _focusablesCache) {
      if (!el.isConnected) { intact = false; break; }
    }
    if (intact) return _focusablesCache;
  }
  const result = computeActiveFocusables();
  _focusablesCache = result;
  _focusablesCacheKey = key;
  return result;
}

// Scope the focus pool to the chrome (nav) + the active view + the now-playing pill.
// This stops "down"/"right" from teleporting into an off-screen view's controls.
function computeActiveFocusables() {
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
  // During held-key repeats smooth scrolling piles up queued animations and the
  // viewport lags behind focus — repeats scroll instantly instead.
  const behavior = _repeatScrollInstant ? "auto" : "smooth";
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
        rail.scrollTo({ left: Math.max(0, nextLeft), behavior });
      } catch {
        rail.scrollLeft = Math.max(0, nextLeft);
      }
    }
    try {
      rail.closest(".shelf")?.scrollIntoView({ block: "nearest", inline: "nearest", behavior });
    } catch {
      rail.closest(".shelf")?.scrollIntoView();
    }
    return;
  }

  try {
    element.scrollIntoView({ block: "nearest", inline: "nearest", behavior });
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

  // Rail items expand to full open-rail width while focused, which would put
  // their right edge *past* the leftmost content and make "right" skip it.
  // Measure from the (collapsed-size) icon box instead so geometry matches
  // what the user sees as the rail's resting column.
  const railIcon = active.closest?.(".nav-rail") ? active.querySelector(".nav-item__icon") : null;
  const a = (railIcon || active).getBoundingClientRect();
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

// --- W4: key-repeat acceleration ---------------------------------------------
// Holding a D-pad arrow (or ChannelUp/Down) keeps moving focus/scrolling with
// mild acceleration: first repeat after ~350ms, then every ~120ms, dropping to
// ~80ms after 8 repeats. Native auto-repeat keydowns (event.repeat, or repeated
// same-key keydowns without an intervening keyup) are gated to that cadence; a
// fallback timer covers TVs that deliver only a single keydown while held. The
// timer is armed only once we've ever seen a keyup from this device — without
// keyups we could never tell "released" from "held" and a single tap would
// scroll forever.
const KEY_REPEAT_FIRST_MS = 350;
const KEY_REPEAT_MS = 120;
const KEY_REPEAT_FAST_MS = 80;
const KEY_REPEAT_FAST_AFTER = 8;
const REPEATABLE_KEYS = new Set([
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ChannelUp", "ChannelDown",
]);

const keyRepeat = {
  key: "",
  count: 0, // repeats performed since the initial press
  nextAt: 0, // earliest timestamp the next repeat may fire
  timer: 0, // fallback timer handle
  sawNativeRepeat: false,
};
let _keyupEverSeen = false;
let _repeatScrollInstant = false; // keepElementVisible/pageScroll: behavior:auto during repeats

function keyRepeatInterval(count) {
  if (count <= 0) return KEY_REPEAT_FIRST_MS;
  return count >= KEY_REPEAT_FAST_AFTER ? KEY_REPEAT_FAST_MS : KEY_REPEAT_MS;
}

function clearKeyRepeat() {
  if (keyRepeat.timer) {
    window.clearTimeout(keyRepeat.timer);
    keyRepeat.timer = 0;
  }
  keyRepeat.key = "";
  keyRepeat.count = 0;
  keyRepeat.nextAt = 0;
  keyRepeat.sawNativeRepeat = false;
}

function performKeyStep(normalized, isRepeat) {
  _repeatScrollInstant = isRepeat;
  try {
    dispatchDirectionalKey(normalized);
  } finally {
    _repeatScrollInstant = false;
  }
}

function scheduleKeyRepeatFallback() {
  if (!_keyupEverSeen) return; // see header comment — no keyups means no timer
  if (keyRepeat.timer) window.clearTimeout(keyRepeat.timer);
  const delay = Math.max(0, keyRepeat.nextAt - Date.now());
  keyRepeat.timer = window.setTimeout(() => {
    keyRepeat.timer = 0;
    if (!keyRepeat.key || keyRepeat.sawNativeRepeat) return; // native repeats took over
    keyRepeat.count += 1;
    keyRepeat.nextAt = Date.now() + keyRepeatInterval(keyRepeat.count);
    performKeyStep(keyRepeat.key, true);
    scheduleKeyRepeatFallback();
  }, delay);
}

function handleRepeatableKey(normalized, event) {
  const heldSameKey = keyRepeat.key === normalized;
  // event.repeat is authoritative where supported; otherwise a same-key keydown
  // with no intervening keyup counts as a repeat (only trustworthy on devices
  // that do deliver keyups).
  const isRepeat = Boolean(event.repeat) || (heldSameKey && _keyupEverSeen);
  if (!isRepeat) {
    clearKeyRepeat();
    keyRepeat.key = normalized;
    keyRepeat.nextAt = Date.now() + keyRepeatInterval(0);
    performKeyStep(normalized, false);
    scheduleKeyRepeatFallback();
    return;
  }
  keyRepeat.sawNativeRepeat = true;
  if (keyRepeat.timer) {
    window.clearTimeout(keyRepeat.timer);
    keyRepeat.timer = 0;
  }
  if (!heldSameKey) {
    // Rolled onto a different key while another was held — restart on it.
    keyRepeat.key = normalized;
    keyRepeat.count = 0;
    keyRepeat.nextAt = 0;
  }
  if (Date.now() < keyRepeat.nextAt) return; // throttle native repeats to our cadence
  keyRepeat.count += 1;
  keyRepeat.nextAt = Date.now() + keyRepeatInterval(keyRepeat.count);
  performKeyStep(normalized, true);
}

// The actual per-press work for the repeatable keys, shared by the initial
// press, native repeats, and the fallback timer.
function dispatchDirectionalKey(normalized) {
  switch (normalized) {
    case "ArrowRight":
      // Right on a focused track row opens its context menu (Enter still plays it).
      if (openTrackMenuFromFocus()) return;
      if (handleAmbientModeArrow("right")) return;
      if (!moveRailFocus("right")) moveFocusDirectional("right");
      return;
    case "ArrowDown":
      // When the queue drawer is open, let normal focus navigation flow through
      // the focusable rows — focusElement → keepElementVisible scrolls them
      // into view automatically, so we no longer need a dedicated scroll path.
      if (isDiagnosticsOpen()) {
        scrollDiagnostics("down");
        return;
      }
      moveFocusDirectional("down");
      return;
    case "ArrowLeft":
      if (handleAmbientModeArrow("left")) return;
      if (!moveRailFocus("left")) moveFocusDirectional("left");
      return;
    case "ArrowUp":
      if (isDiagnosticsOpen()) {
        scrollDiagnostics("up");
        return;
      }
      moveFocusDirectional("up");
      return;
    case "ChannelUp":
      pageScroll(-1);
      return;
    case "ChannelDown":
      pageScroll(1);
      return;
  }
}

function handleRemoteEvent(event) {
  const normalized = normalizeRemoteKey(event);
  logRemoteEvent(event, normalized);
  if (event.type === "keyup") {
    _keyupEverSeen = true;
    if (keyRepeat.key && normalized === keyRepeat.key) clearKeyRepeat();
    return;
  }
  if (event.type !== "keydown") return;

  // When a text field is focused, let the browser handle keys natively. Otherwise
  // the numpad-digit→D-pad aliases (2/4/5/6/8) would hijack numeric typing and the
  // arrows would navigate focus instead of moving the caret.
  if (isEditableTarget(event.target) || isEditableTarget(document.activeElement)) {
    return;
  }

  if (REPEATABLE_KEYS.has(normalized)) {
    event.preventDefault();
    handleRepeatableKey(normalized, event);
    return;
  }

  switch (normalized) {
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
  window.scrollBy({ top: distance, behavior: _repeatScrollInstant ? "auto" : "smooth" });
  // Held-key repeats would spam the log (and its server beacon) — log taps only.
  if (!_repeatScrollInstant) {
    log(`Channel scroll ${direction > 0 ? "down" : "up"} by ${Math.abs(distance)}px.`);
  }
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
  invalidateFocusables();
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
  invalidateFocusables();
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
  invalidateFocusables();
}

function renderShelf(container, title, items, type, { hideIfEmpty = false, eyebrow } = {}) {
  if (!container) return;
  container.replaceChildren();
  invalidateFocusables();
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
    case "artist":
      return "Artists";
    default:
      return "Library";
  }
}

function createMediaCard(item, type) {
  const button = document.createElement("button");
  button.className = "focusable card";
  if (type === "artist") button.classList.add("card--artist");
  button.setAttribute("role", "listitem");
  // ~300px variant covers the 232px card art; lazy + async decode keeps long
  // shelves from front-loading dozens of decodes on the TV.
  const image = getImage(item, 300);
  const subtitle = type === "playlist"
    ? `${item.tracks?.total || 0} tracks`
    : type === "album"
      ? `${item.album_type || "album"} - ${(item.artists || []).map((artist) => artist.name).join(", ")}`
      : type === "artist"
        ? "Artist"
    : (item.artists || []).map((artist) => artist.name).join(", ");
  button.innerHTML = `
    <img src="${escapeAttribute(image)}" alt="" loading="lazy" decoding="async">
    <span class="card-title">${escapeHtml(item.name || "Untitled")}</span>
    <span class="card-subtitle">${escapeHtml(subtitle || type)}</span>
  `;
  // A single track plays immediately; a collection opens its detail screen so the
  // user can browse tracks and choose shuffle vs. sequential before playing.
  if (type === "album" || type === "playlist") {
    button.addEventListener("click", () => openCollection(item, type));
  } else if (type === "artist") {
    button.addEventListener("click", () => {
      openArtist(item).catch((error) => logError("Open artist failed", error));
    });
  } else {
    button.addEventListener("click", () => playItem(item, type));
  }
  // Track tiles expose their data so openTrackMenuFromFocus can build a menu
  // target without needing a per-view lookup table. Album/artist fields feed
  // context-aware playback ("play in album"), Go to Album, and Start Radio.
  if (type === "track" && item?.uri) {
    button.dataset.trackUri = item.uri;
    button.dataset.trackId = item.id || "";
    button.dataset.trackName = item.name || "";
    button.dataset.trackArtist = (item.artists || []).map((a) => a.name).join(", ");
    button.dataset.trackImage = image || "";
    button.dataset.albumUri = item.album?.uri || "";
    button.dataset.albumId = item.album?.id || "";
    button.dataset.albumName = item.album?.name || "";
    button.dataset.artistIds = (item.artists || []).map((a) => a.id).filter(Boolean).join(",");
  }
  return button;
}

async function playItem(item, type) {
  activateSpotifyElement();
  requireAccessToken();
  await ensureSpotifyDeviceReady();
  // Single tracks play inside their album context so playback continues past
  // the song (a bare-uris play stops dead when the track ends). Fall back to
  // the bare URI only when no album is known.
  const albumUri = item.album?.uri || "";
  const body = (type === "playlist" || type === "album")
    ? { context_uri: item.uri }
    : albumUri
      ? { context_uri: albumUri, offset: { uri: item.uri } }
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

// W4: bounded pagination + windowed rendering for big collections. The first
// page paints immediately, the rest stream in the background; rows only enter
// the DOM in chunks as focus approaches the end of what's rendered.
const COLLECTION_MAX_TRACKS = 500;
const COLLECTION_RENDER_CHUNK = 60;
const COLLECTION_RENDER_LOOKAHEAD = 15; // rows of headroom before extending

async function openCollection(item, type) {
  requireAccessToken();
  if (state.currentView !== "collection") {
    state.collectionReturnView = state.currentView;
  }
  const totalKnown = type === "playlist" ? item.tracks?.total : item.total_tracks;
  const releaseDate = type === "album" ? (item.release_date || "") : "";
  const coll = {
    type,
    id: item.id,
    contextUri: item.uri,
    title: item.name || "Untitled",
    image: getImage(item, 640), // billboard/backdrop hero wants the large variant
    byline: type === "playlist"
      ? (item.owner?.display_name ? `By ${item.owner.display_name}` : "Playlist")
      : (item.artists || []).map((artist) => artist.name).join(", "),
    year: releaseDate ? releaseDate.slice(0, 4) : "",
    totalKnown: Number.isFinite(totalKnown) ? totalKnown : null,
    tracks: [],
    renderedCount: 0,
    loadedAll: false,
    truncated: false,
    loading: true,
    error: "",
    saved: null, // null = unknown until the contains-check resolves
    savedPending: false,
    paletteUrl: "",
  };
  state.collection = coll;
  setView("collection");
  renderCollection();
  focusElement(elements.collectionShuffleBtn);
  refreshCollectionSaved(coll);
  await loadCollectionTracks(item, type, coll);
}

// Streams the track pages into coll.tracks: page 1 renders immediately, later
// pages append in the background. Every await is followed by a staleness check
// so leaving for another collection cancels the rest of the work.
async function loadCollectionTracks(item, type, coll) {
  // Spotify caps per-page at 50; large playlists/albums need pagination via the
  // `next` URL so we don't silently truncate. The next URL is fully-qualified;
  // strip the host since spotifyApiFetch prepends it.
  let path = type === "album"
    ? `/v1/albums/${item.id}/tracks?limit=50`
    : `/v1/playlists/${item.id}/items?limit=50`;
  const getTrack = type === "album"
    ? (entry) => entry
    : (entry) => entry.track ?? entry.item;
  let firstPage = true;
  try {
    while (path && coll.tracks.length < COLLECTION_MAX_TRACKS) {
      const data = await spotifyApiJson(path);
      if (state.collection !== coll) return; // user opened something else
      if (!data) break;
      for (const entry of data.items || []) {
        const track = getTrack(entry);
        if (!track || !track.uri) continue;
        // Skip explicitly-unavailable and local-only tracks — they error if we
        // try to play them and pad the duration total with garbage.
        if (track.is_playable === false || track.is_local === true) continue;
        coll.tracks.push(normalizeCollectionTrack(track));
        if (coll.tracks.length >= COLLECTION_MAX_TRACKS) break;
      }
      path = data.next ? data.next.replace(/^https:\/\/api\.spotify\.com/, "") : "";
      if (firstPage) {
        firstPage = false;
        coll.loading = false;
        renderCollection(); // paint page 1 right away; the rest streams in
      } else {
        renderCollectionMeta();
        // If focus is parked near the end of the window (user outran the
        // fetch), extend it now — Down needs the next row to exist.
        maybeExtendCollectionWindow();
      }
    }
    if (path && coll.tracks.length >= COLLECTION_MAX_TRACKS) coll.truncated = true;
    coll.loadedAll = true;
  } catch (error) {
    if (state.collection !== coll) return;
    coll.error = error?.message || "Couldn't load tracks.";
    logError("Collection load failed", error);
  } finally {
    if (state.collection === coll) {
      coll.loading = false;
      if (firstPage || !coll.tracks.length) {
        // Nothing rendered yet (page-1 failure or genuinely empty collection).
        renderCollection();
      } else {
        // Rows are already on screen — never blow them away, even if a later
        // page failed; just settle the header and the end-of-list note.
        if (coll.error) {
          showToast("Couldn't load the rest of this collection.", "warn");
          coll.error = "";
        }
        renderCollectionMeta();
        updateCollectionEndNote();
        maybeExtendCollectionWindow();
      }
    }
  }
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
    artistIds: (track.artists || []).map((artist) => artist.id).filter(Boolean),
    duration: track.duration_ms || 0,
    image: images[images.length - 1]?.url || images[0]?.url || "",
    album: track.album?.name || "",
    albumUri: track.album?.uri || "",
    albumId: track.album?.id || "",
    year: releaseDate ? releaseDate.slice(0, 4) : "",
  };
}

function renderCollection() {
  const coll = state.collection;
  if (!coll || !elements.collectionTracks) return;

  if (elements.collectionBackdrop) {
    elements.collectionBackdrop.style.backgroundImage = coll.image ? `url("${coll.image}")` : "";
  }
  // Billboard tint: pull the collection's accent from its artwork once per image
  // and expose it as --coll-rgb for the scrim/panel tints in CSS.
  if (coll.image && coll.image !== coll.paletteUrl) {
    coll.paletteUrl = coll.image;
    extractPalette(coll.image).then((palette) => {
      if (state.collection !== coll) return;
      applyPaletteChannels(elements.viewCollection, "--coll-rgb", palette);
    }).catch(() => {});
  }
  if (elements.collectionArt) {
    if (coll.image) elements.collectionArt.src = coll.image;
    else elements.collectionArt.removeAttribute("src");
  }
  if (elements.collectionKind) {
    elements.collectionKind.textContent = coll.type === "playlist" ? "Playlist" : "Album";
  }
  if (elements.collectionTitle) elements.collectionTitle.textContent = coll.title;
  renderCollectionMeta();
  updateCollectionShuffleBtn();
  renderCollectionSaveBtn();

  const list = elements.collectionTracks;
  list.replaceChildren();
  coll.renderedCount = 0;
  invalidateFocusables();

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

  renderMoreCollectionRows();
}

// Header line: byline · year · count · duration. While pages stream in the
// count tracks what's known; the duration settles once all pages have loaded.
function renderCollectionMeta() {
  const coll = state.collection;
  if (!coll || !elements.collectionMeta) return;
  const count = (coll.loadedAll && !coll.truncated)
    ? coll.tracks.length
    : (coll.totalKnown || coll.tracks.length || 0);
  const countText = count ? `${count} song${count === 1 ? "" : "s"}` : "";
  const totalMs = coll.tracks.reduce((sum, track) => sum + (track.duration || 0), 0);
  const durationText = coll.loadedAll && totalMs
    ? formatTotalDuration(totalMs) + (coll.truncated ? "+" : "")
    : "";
  const truncatedText = coll.truncated ? `showing first ${coll.tracks.length}` : "";
  elements.collectionMeta.textContent = [coll.byline, coll.year, countText, truncatedText, durationText]
    .filter(Boolean)
    .join(" · ");
}

function buildCollectionTrackRow(track, index) {
  const row = document.createElement("button");
  row.type = "button";
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
  return row;
}

// Appends the next window of rows. Called from renderCollection (first chunk)
// and whenever focus nears the end of the rendered window.
function renderMoreCollectionRows(chunk = COLLECTION_RENDER_CHUNK) {
  const coll = state.collection;
  const list = elements.collectionTracks;
  if (!coll || !list) return;
  const end = Math.min(coll.tracks.length, coll.renderedCount + chunk);
  if (end <= coll.renderedCount) {
    updateCollectionEndNote();
    return;
  }
  // The end note must stay after the last row — drop it before appending.
  list.querySelector(".collection-end-note")?.remove();
  const frag = document.createDocumentFragment();
  for (let i = coll.renderedCount; i < end; i++) {
    frag.append(buildCollectionTrackRow(coll.tracks[i], i));
  }
  coll.renderedCount = end;
  list.append(frag);
  updateCollectionEndNote();
  invalidateFocusables();
  renderCollectionPlayingState();
}

function updateCollectionEndNote() {
  const coll = state.collection;
  const list = elements.collectionTracks;
  if (!coll || !list) return;
  const show = coll.loadedAll && coll.truncated && coll.renderedCount >= coll.tracks.length;
  let note = list.querySelector(".collection-end-note");
  if (!show) {
    note?.remove();
    return;
  }
  if (!note) {
    note = document.createElement("p");
    note.className = "collection-note collection-end-note";
  }
  note.textContent = `Showing the first ${coll.tracks.length} tracks.`;
  list.append(note);
}

// Extend the rendered window when the focused row runs out of headroom — this
// is what keeps Down working all the way through a 500-track playlist without
// 500 rows in the DOM up front.
function maybeExtendCollectionWindow() {
  const coll = state.collection;
  if (!coll || !elements.collectionTracks) return;
  const active = document.activeElement;
  const row = active instanceof HTMLElement ? active.closest(".collection-track") : null;
  if (!row || !elements.collectionTracks.contains(row)) return;
  const index = Number(row.dataset.index);
  if (!Number.isFinite(index)) return;
  if (index >= coll.renderedCount - COLLECTION_RENDER_LOOKAHEAD) {
    renderMoreCollectionRows();
  }
}

function handleCollectionTracksFocusIn() {
  maybeExtendCollectionWindow();
}

function renderCollectionPlayingState() {
  const now = state.nowPlaying;
  for (const container of [elements.collectionTracks, elements.artistTopTracks]) {
    if (!container) continue;
    const rows = container.querySelectorAll(".collection-track");
    rows.forEach((row) => {
      const match = Boolean(now) && now.uri && row.dataset.uri === now.uri;
      row.classList.toggle("is-playing", match);
      row.classList.toggle("is-paused", match && Boolean(now?.paused));
    });
  }
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

/* === Save to library (albums: /v1/me/albums, playlists: follow/unfollow) === */

let _userProfile = null;
async function getUserProfile() {
  if (_userProfile?.id) return _userProfile;
  _userProfile = await spotifyApiJson("/v1/me");
  return _userProfile;
}

function renderCollectionSaveBtn() {
  const btn = elements.collectionSaveBtn;
  const coll = state.collection;
  if (!btn) return;
  const saved = Boolean(coll?.saved);
  btn.classList.toggle("is-active", saved);
  btn.classList.toggle("is-pending", Boolean(coll?.savedPending));
  btn.setAttribute("aria-pressed", saved ? "true" : "false");
  btn.setAttribute("aria-label", saved ? "Remove from your library" : "Save to your library");
  const label = btn.querySelector(".collection-save__label");
  if (label) label.textContent = saved ? "Saved" : "Save";
  const heart = btn.querySelector("svg path");
  if (heart) heart.setAttribute("fill", saved ? "currentColor" : "none");
}

async function refreshCollectionSaved(coll) {
  if (!coll?.id) return;
  try {
    let saved = null;
    if (coll.type === "album") {
      const data = await spotifyApiJson(`/v1/me/albums/contains?ids=${encodeURIComponent(coll.id)}`);
      if (Array.isArray(data)) saved = Boolean(data[0]);
    } else {
      const me = await getUserProfile();
      const data = await spotifyApiJson(
        `/v1/playlists/${coll.id}/followers/contains?ids=${encodeURIComponent(me.id)}`
      );
      if (Array.isArray(data)) saved = Boolean(data[0]);
    }
    if (state.collection === coll && saved !== null) {
      coll.saved = saved;
      renderCollectionSaveBtn();
    }
  } catch (error) {
    // Non-fatal: the button still works as a blind toggle.
    log(`Library state check failed: ${error?.message || error}`, "error");
  }
}

async function toggleCollectionSaved() {
  const coll = state.collection;
  if (!coll?.id || coll.savedPending) return;
  const next = !coll.saved;
  coll.savedPending = true;
  renderCollectionSaveBtn();
  try {
    requireAccessToken();
    const path = coll.type === "album"
      ? `/v1/me/albums?ids=${encodeURIComponent(coll.id)}`
      : `/v1/playlists/${coll.id}/followers`;
    const response = await spotifyApiFetch(path, { method: next ? "PUT" : "DELETE" });
    if (!response.ok) {
      // Tokens minted before user-library-modify was added need a re-pair.
      if (response.status === 403) {
        throw new Error("Spotify refused (403) — re-pair from Settings to grant library permissions");
      }
      throw new Error(`Spotify returned ${response.status}: ${await readSpotifyError(response)}`);
    }
    coll.saved = next;
    log(`${next ? "Saved to" : "Removed from"} your library: ${coll.title}`, "success");
  } catch (error) {
    logError("Library save failed", error);
    showToast(`Couldn't update your library: ${error?.message || "unknown error"}`, "error");
  } finally {
    coll.savedPending = false;
    renderCollectionSaveBtn();
  }
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

/* ------------------------------------------------------------------ *
 * W4 Artist page: hero + top tracks + albums shelf. Mirrors the
 * collection-view pattern (sibling view, return-view memory, palette tint).
 * ------------------------------------------------------------------ */

function artistBack() {
  setView(state.artistReturnView || "home");
}

function formatFollowers(count) {
  if (count >= 1e6) return `${(count / 1e6).toFixed(count >= 1e7 ? 0 : 1)}M`;
  if (count >= 1e3) return `${Math.round(count / 1e3)}K`;
  return String(count);
}

// Accepts a full artist object (search card) or a bare artist id (track menu).
async function openArtist(itemOrId) {
  requireAccessToken();
  const seed = itemOrId && typeof itemOrId === "object" ? itemOrId : null;
  const id = typeof itemOrId === "string" ? itemOrId : seed?.id || spotifyUriId(seed?.uri);
  if (!id) {
    showToast("Couldn't open that artist.", "error");
    return;
  }
  if (state.currentView !== "artist") {
    state.artistReturnView = state.currentView;
  }
  const artist = {
    id,
    name: seed?.name || "",
    image: seed ? pickImageUrl(seed, 640) : "",
    meta: "",
    topTracks: [],
    albums: [],
    loading: true,
    error: "",
    paletteUrl: "",
  };
  state.artist = artist;
  setView("artist");
  renderArtist();

  const results = await Promise.allSettled([
    spotifyApiJson(`/v1/artists/${encodeURIComponent(id)}`),
    spotifyApiJson(`/v1/artists/${encodeURIComponent(id)}/top-tracks?market=from_token`),
    spotifyApiJson(`/v1/artists/${encodeURIComponent(id)}/albums?include_groups=album,single&limit=20`),
  ]);
  if (state.artist !== artist) return; // user moved on while loading
  const [profile, top, albums] = results;
  if (profile.status === "fulfilled" && profile.value) {
    artist.name = profile.value.name || artist.name;
    artist.image = pickImageUrl(profile.value, 640) || artist.image;
    const followers = profile.value.followers?.total;
    const genres = (profile.value.genres || []).slice(0, 3).join(" · ");
    artist.meta = [genres, Number.isFinite(followers) ? `${formatFollowers(followers)} followers` : ""]
      .filter(Boolean)
      .join(" · ");
  }
  if (top.status === "fulfilled") {
    artist.topTracks = (top.value?.tracks || []).filter((track) => track && track.uri);
  }
  if (albums.status === "fulfilled") {
    artist.albums = (albums.value?.items || []).filter(Boolean);
  }
  if (results.every((result) => result.status === "rejected")) {
    artist.error = profile.reason?.message || "Couldn't load this artist.";
    logError("Artist load failed", profile.reason);
  }
  artist.loading = false;
  renderArtist();
}

function renderArtist() {
  const artist = state.artist;
  const list = elements.artistTopTracks;
  if (!artist || !list) return;

  if (elements.artistBackdrop) {
    elements.artistBackdrop.style.backgroundImage = artist.image ? `url("${artist.image}")` : "";
  }
  if (artist.image && artist.image !== artist.paletteUrl) {
    artist.paletteUrl = artist.image;
    extractPalette(artist.image).then((palette) => {
      if (state.artist !== artist) return;
      applyPaletteChannels(elements.viewArtist, "--coll-rgb", palette);
    }).catch(() => {});
  }
  if (elements.artistArt) {
    if (artist.image) elements.artistArt.src = artist.image;
    else elements.artistArt.removeAttribute("src");
  }
  if (elements.artistTitle) elements.artistTitle.textContent = artist.name || "Artist";
  if (elements.artistMeta) elements.artistMeta.textContent = artist.meta || "";

  list.replaceChildren();
  invalidateFocusables();
  if (artist.loading) {
    const note = document.createElement("p");
    note.className = "collection-note";
    note.textContent = "Loading top tracks…";
    list.append(note);
  } else if (artist.error) {
    const note = document.createElement("p");
    note.className = "collection-note collection-note--error";
    note.textContent = artist.error;
    list.append(note);
  } else if (!artist.topTracks.length) {
    const note = document.createElement("p");
    note.className = "collection-note";
    note.textContent = "No top tracks available.";
    list.append(note);
  } else {
    artist.topTracks.forEach((track, index) => list.append(buildArtistTrackRow(track, index)));
  }

  renderShelf(elements.artistAlbumsShelf, "Albums & Singles", artist.albums, "album", {
    hideIfEmpty: true,
  });
  renderCollectionPlayingState();
}

// Top-track rows reuse the collection-track styling and expose the standard
// data-track-* dataset so Right opens the existing context menu (tile path).
function buildArtistTrackRow(track, index) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "focusable collection-track";
  row.dataset.uri = track.uri;
  const image = pickImageUrl(track, 96);
  row.dataset.trackUri = track.uri;
  row.dataset.trackId = track.id || "";
  row.dataset.trackName = track.name || "";
  row.dataset.trackArtist = (track.artists || []).map((a) => a.name).join(", ");
  row.dataset.trackImage = image || "";
  row.dataset.albumUri = track.album?.uri || "";
  row.dataset.albumId = track.album?.id || "";
  row.dataset.albumName = track.album?.name || "";
  row.dataset.artistIds = (track.artists || []).map((a) => a.id).filter(Boolean).join(",");
  const indexCell = image
    ? `<span class="collection-track__index collection-track__index--art" style="background-image:url('${escapeHtml(image)}')">
         <span class="collection-track__eq" aria-hidden="true"><i></i><i></i><i></i></span>
       </span>`
    : `<span class="collection-track__index">
         <span class="collection-track__num">${index + 1}</span>
         <span class="collection-track__eq" aria-hidden="true"><i></i><i></i><i></i></span>
       </span>`;
  row.innerHTML = `
    ${indexCell}
    <span class="collection-track__body">
      <span class="collection-track__title">${escapeHtml(track.name || "Untitled")}</span>
      <span class="collection-track__artist">${escapeHtml(track.album?.name || "")}</span>
    </span>
    <span class="collection-track__time">${formatDuration(track.duration_ms)}</span>
  `;
  row.addEventListener("click", () => {
    playItem(track, "track").catch((error) => logError("Top track play failed", error));
  });
  return row;
}

/* ------------------------------------------------------------------ *
 * W4 Search view: on-screen A–Z 0–9 grid keyboard (spatial-nav friendly),
 * debounced /v1/search, results rendered as the standard shelves. Nothing
 * is persisted.
 * ------------------------------------------------------------------ */

const SEARCH_DEBOUNCE_MS = 600;
const SEARCH_QUERY_MAX = 40;
const SEARCH_DEFAULT_HINT = "Type with the on-screen keys to search Spotify.";

let _searchQuery = "";
let _searchTimer = 0;
let _searchSeq = 0; // stale-response guard

function buildSearchKeyboard() {
  const wrap = elements.searchKeys;
  if (!wrap || wrap.children.length) return;
  const frag = document.createDocumentFragment();
  for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") {
    frag.append(searchKeyButton(ch, ch));
  }
  frag.append(searchKeyButton("Space", "space", "search-key--wide"));
  frag.append(searchKeyButton("Delete", "del", "search-key--wide"));
  frag.append(searchKeyButton("Clear", "clear", "search-key--wide"));
  wrap.append(frag);
}

function searchKeyButton(label, key, extraClass) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `focusable search-key${extraClass ? " " + extraClass : ""}`;
  btn.dataset.key = key;
  btn.setAttribute("aria-label", key === "del" ? "Delete last character" : label);
  btn.textContent = label;
  btn.addEventListener("click", () => handleSearchKey(key));
  return btn;
}

function handleSearchKey(key) {
  if (key === "del") {
    _searchQuery = _searchQuery.slice(0, -1);
  } else if (key === "clear") {
    _searchQuery = "";
  } else if (key === "space") {
    if (_searchQuery && !_searchQuery.endsWith(" ")) _searchQuery += " ";
  } else if (_searchQuery.length < SEARCH_QUERY_MAX) {
    _searchQuery += key;
  }
  renderSearchQuery();
  scheduleSearch();
}

function renderSearchQuery() {
  if (elements.searchQueryText) elements.searchQueryText.textContent = _searchQuery;
}

function setSearchHint(text) {
  const hint = elements.searchHint;
  if (!hint) return;
  hint.hidden = !text;
  hint.textContent = text || "";
}

function scheduleSearch() {
  if (_searchTimer) window.clearTimeout(_searchTimer);
  _searchSeq += 1; // anything in flight is stale now
  const q = _searchQuery.trim();
  if (!q) {
    clearSearchResults();
    return;
  }
  _searchTimer = window.setTimeout(() => {
    _searchTimer = 0;
    runSearch().catch((error) => logError("Search failed", error));
  }, SEARCH_DEBOUNCE_MS);
}

function clearSearchResults() {
  for (const key of ["searchTracksShelf", "searchArtistsShelf", "searchAlbumsShelf", "searchPlaylistsShelf"]) {
    const shelf = elements[key];
    if (shelf) {
      shelf.replaceChildren();
      shelf.hidden = true;
    }
  }
  setSearchHint(SEARCH_DEFAULT_HINT);
  invalidateFocusables();
}

async function runSearch() {
  const q = _searchQuery.trim();
  if (!q) return;
  const seq = ++_searchSeq;
  setSearchHint(`Searching for “${q}”…`);
  try {
    const data = await spotifyApiJson(
      `/v1/search?q=${encodeURIComponent(q)}&type=track,album,artist,playlist&limit=12`
    );
    if (seq !== _searchSeq) return; // a newer query superseded this one
    renderSearchResults(q, data);
  } catch (error) {
    if (seq !== _searchSeq) return;
    logError("Search failed", error);
    setSearchHint(`Couldn't search: ${error?.message || "unknown error"}`);
  }
}

function renderSearchResults(q, data) {
  const tracks = (data?.tracks?.items || []).filter(Boolean);
  const artists = (data?.artists?.items || []).filter(Boolean);
  const albums = (data?.albums?.items || []).filter(Boolean);
  const playlists = (data?.playlists?.items || []).filter(Boolean);
  renderShelf(elements.searchTracksShelf, "Tracks", tracks, "track", { hideIfEmpty: true });
  renderShelf(elements.searchArtistsShelf, "Artists", artists, "artist", { hideIfEmpty: true });
  renderShelf(elements.searchAlbumsShelf, "Albums", albums, "album", { hideIfEmpty: true });
  renderShelf(elements.searchPlaylistsShelf, "Playlists", playlists, "playlist", { hideIfEmpty: true });
  const total = tracks.length + artists.length + albums.length + playlists.length;
  setSearchHint(total ? "" : `No results for “${q}”.`);
  log(`Search "${q}": ${tracks.length} tracks, ${artists.length} artists, ${albums.length} albums, ${playlists.length} playlists.`);
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
  if (state.currentView === "artist") {
    artistBack();
    log("Back: returned from artist page.");
    return;
  }
  if (state.currentView === "now" || state.currentView === "ambient") {
    const target = state.previousView && state.previousView !== state.currentView ? state.previousView : "home";
    setView(target);
    log(`Back: returned to ${target}.`);
    return;
  }
  // Top-level views (home/library/settings): Back first hops focus to the nav
  // rail (the TV convention — nav is one Back away from any scroll depth).
  // Only once focus is already on the rail does Back escalate: Home shows the
  // exit dialog, other views return Home.
  if (focusNavRail()) {
    log("Back: focused the navigation rail.");
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

// Moves focus to the nav rail's active item. Returns false when focus is
// already inside the rail (so Back can escalate) or the rail is unavailable.
function focusNavRail() {
  const rail = elements.navRail || document.querySelector(".nav-rail");
  if (!rail || !isVisibleElement(rail.querySelector(".nav-item"))) return false;
  if (rail.contains(document.activeElement)) return false;
  const target = rail.querySelector(".nav-item.is-active") || rail.querySelector(".focusable:not([disabled])");
  if (!target) return false;
  focusElement(target);
  return true;
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

function normalizeQueueTrack(item) {
  const images = item?.album?.images || [];
  // GET /me/player/queue returns full track objects — keep album + artist ids so
  // queue rows can play in-context and feed the radio dedupe set.
  return {
    uri: item?.uri || "",
    id: item?.id || "",
    name: item?.name || "Untitled",
    artist: (item?.artists || []).map((a) => a.name).join(", "),
    artistIds: (item?.artists || []).map((a) => a.id).filter(Boolean),
    image: images[images.length - 1]?.url || images[0]?.url || "",
    albumUri: item?.album?.uri || "",
    albumId: item?.album?.id || "",
    albumName: item?.album?.name || "",
  };
}

async function fetchQueueItems() {
  const data = await spotifyApiJson("/v1/me/player/queue");
  const items = Array.isArray(data?.queue) ? data.queue : [];
  state.queueItems = items.map(normalizeQueueTrack);
  return state.queueItems;
}

function queueSectionHead(label) {
  const head = document.createElement("p");
  head.className = "queue-section-head";
  head.textContent = label;
  return head;
}

function buildQueueRow(track, position) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "focusable queue-row";
  row.dataset.uri = track.uri || "";
  const art = track.image ? `url("${escapeHtml(track.image)}")` : "none";
  row.innerHTML = `
    <span class="queue-row__art" style="background-image:${art}"></span>
    <span class="queue-row__body">
      <span class="queue-row__title">${escapeHtml(track.name)}</span>
      <span class="queue-row__artist">${escapeHtml(track.artist)}</span>
    </span>
    <span class="queue-row__pos">${position}</span>
  `;
  row.addEventListener("click", () => {
    playQueueTrack(track).catch((error) => logError("Play from queue failed", error));
  });
  return row;
}

// Friendly fallback header while the context name resolves (or if it can't).
function contextTypeLabel(uri) {
  const type = String(uri || "").split(":")[1] || "";
  if (type === "album") return "Continuing from this album";
  if (type === "playlist") return "Continuing from this playlist";
  if (type === "artist") return "Continuing from this artist";
  return "Up next";
}

// Resolve a context uri (album/playlist/artist) to its display name, cached per
// session so reopening the drawer doesn't refetch.
async function resolveContextName(uri) {
  if (!uri) return "";
  if (state.contextNameCache[uri] !== undefined) return state.contextNameCache[uri];
  const match = /^spotify:(album|playlist|artist):([A-Za-z0-9]+)$/.exec(uri);
  if (!match) {
    state.contextNameCache[uri] = "";
    return "";
  }
  const [, kind, id] = match;
  const path = kind === "album"
    ? `/v1/albums/${id}`
    : kind === "playlist"
      ? `/v1/playlists/${id}?fields=name`
      : `/v1/artists/${id}`;
  try {
    const data = await spotifyApiJson(path);
    state.contextNameCache[uri] = data?.name || "";
  } catch (error) {
    logError("Context name lookup failed", error);
    state.contextNameCache[uri] = "";
  }
  return state.contextNameCache[uri];
}

// Honest "Up Next" panel. Spotify's queue API can't distinguish explicit queue
// items from context continuation, so we split best-effort: URIs we queued this
// session render under "In queue"/"Radio", everything else under "Continuing
// from". No fake remove/reorder — the API is append-only.
function renderQueueDrawer(errorMessage) {
  const list = elements.queueList;
  if (!list) return;
  list.replaceChildren();
  invalidateFocusables();
  if (errorMessage) {
    const note = document.createElement("p");
    note.className = "queue-drawer__note queue-drawer__note--error";
    note.textContent = errorMessage;
    list.append(note);
    return;
  }

  const now = state.nowPlaying;
  if (now) {
    list.append(queueSectionHead("Now playing"));
    const nowRow = document.createElement("div");
    nowRow.className = "queue-row queue-row--now";
    const art = now.image ? `url("${escapeHtml(now.image)}")` : "none";
    nowRow.innerHTML = `
      <span class="queue-row__art" style="background-image:${art}"></span>
      <span class="queue-row__body">
        <span class="queue-row__title">${escapeHtml(now.title)}</span>
        <span class="queue-row__artist">${escapeHtml(now.artist)}</span>
      </span>
      <span class="queue-row__pos">${now.paused ? "Paused" : "Playing"}</span>
    `;
    list.append(nowRow);
  }

  const items = state.queueItems || [];
  if (!items.length) {
    const note = document.createElement("p");
    note.className = "queue-drawer__note";
    note.textContent = "Nothing up next. Spotify's queue is append-only — press Right on any track and choose Add to Queue, or leave Autoplay on to keep the music going.";
    list.append(note);
    return;
  }

  const queued = [];
  const radio = [];
  const fromContext = [];
  for (const track of items) {
    if (track.uri && state.radioQueuedUris.has(track.uri)) radio.push(track);
    else if (track.uri && state.sessionQueuedUris.has(track.uri)) queued.push(track);
    else fromContext.push(track);
  }
  // Positions reflect the real playback order from the API, not section order.
  const positionOf = (track) => items.indexOf(track) + 1;
  const appendRows = (tracks) => {
    for (const track of tracks) list.append(buildQueueRow(track, positionOf(track)));
  };

  if (queued.length) {
    list.append(queueSectionHead("In queue"));
    appendRows(queued);
  }
  if (fromContext.length) {
    const ctxUri = now?.contextUri || "";
    const cachedName = ctxUri ? state.contextNameCache[ctxUri] : "";
    list.append(queueSectionHead(cachedName ? `Continuing from: ${cachedName}` : contextTypeLabel(ctxUri)));
    appendRows(fromContext);
    // Resolve the context name in the background and re-render once known.
    if (ctxUri && state.contextNameCache[ctxUri] === undefined) {
      resolveContextName(ctxUri).then((name) => {
        if (name && isQueueDrawerOpen()) renderQueueDrawer();
      });
    }
  }
  if (radio.length) {
    list.append(queueSectionHead(state.radioSeedArtist ? `Radio: similar to ${state.radioSeedArtist}` : "Radio"));
    appendRows(radio);
  }
}

async function playQueueTrack(track) {
  if (!track?.uri) return;
  activateSpotifyElement();
  requireAccessToken();
  await ensureSpotifyDeviceReady();
  // Play inside the track's album context where known so music continues after
  // the song; a bare-uris play would stop dead and abandon any continuation.
  const body = track.albumUri
    ? { context_uri: track.albumUri, offset: { uri: track.uri } }
    : { uris: [track.uri] };
  const response = await spotifyApiFetch(withDeviceIdParam("/v1/me/player/play"), {
    method: "PUT",
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Play failed (${response.status}): ${await readSpotifyError(response)}`);
  }
  closeQueueDrawer();
}

/* ------------------------------------------------------------------ *
 * #50 Track context menu (Add to Queue / Add to Playlist)
 * ------------------------------------------------------------------ */

function isTrackMenuOpen() {
  return Boolean(elements.trackMenu) && !elements.trackMenu.hidden;
}

// Open the context menu for whatever track-like focusable is currently focused.
// Two paths: collection rows look up the indexed track in state; standalone
// track tiles (saved tracks, search results, recent shelf) carry their fields
// as data-track-* attributes so we don't need to track them per-view.
function openTrackMenuFromFocus() {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;

  // Artist top-track rows reuse the .collection-track class for styling but
  // carry data-track-* attrs — only rows inside the collection list resolve
  // through state.collection (others fall through to the dataset path below).
  const collectionRow = active.closest(".collection-track");
  if (collectionRow && elements.collectionTracks?.contains(collectionRow)) {
    const index = Number(collectionRow.dataset.index);
    const track = state.collection?.tracks?.[index];
    if (track && track.uri) {
      // Album-track payloads are simplified (no nested album object) — the
      // collection itself is the album, so backfill from it for Go to Album.
      const coll = state.collection;
      const fromAlbumColl = coll?.type === "album";
      openTrackMenu({
        ...track,
        albumUri: track.albumUri || (fromAlbumColl ? coll.contextUri : ""),
        albumId: track.albumId || (fromAlbumColl ? coll.id : ""),
        albumName: track.album || (fromAlbumColl ? coll.title : ""),
        image: track.image || (fromAlbumColl ? coll.image : ""),
      });
      return true;
    }
  }

  const tile = active.closest("[data-track-uri]");
  if (tile && tile.dataset.trackUri) {
    openTrackMenu({
      uri: tile.dataset.trackUri,
      id: tile.dataset.trackId || "",
      name: tile.dataset.trackName || "Untitled",
      artist: tile.dataset.trackArtist || "",
      image: tile.dataset.trackImage || "",
      albumUri: tile.dataset.albumUri || "",
      albumId: tile.dataset.albumId || "",
      albumName: tile.dataset.albumName || "",
      artistIds: (tile.dataset.artistIds || "").split(",").filter(Boolean),
    });
    return true;
  }

  return false;
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

// "spotify:track:ID" → "ID" (also works for album/artist uris).
function spotifyUriId(uri) {
  const parts = String(uri || "").split(":");
  return parts.length === 3 ? parts[2] : "";
}

function renderTrackMenuRoot() {
  const wrap = elements.trackMenuActions;
  if (!wrap) return;
  wrap.replaceChildren();
  invalidateFocusables();
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

  // Save/Remove Liked Songs. Render immediately with the optimistic label and
  // fix it up async once /me/tracks/contains answers — TV remotes shouldn't
  // wait on a round trip before the menu is usable.
  const trackId = track.id || spotifyUriId(track.uri);
  if (trackId) {
    const likeBtn = trackMenuButton("Save to Liked Songs", () => {
      toggleTrackSaved(track, trackId, likeBtn.dataset.saved === "1").catch((error) => {
        logError("Liked Songs update failed", error);
        showToast("Couldn't update Liked Songs.", "error");
      });
    });
    likeBtn.dataset.saved = "0";
    wrap.append(likeBtn);
    spotifyApiJson(`/v1/me/tracks/contains?ids=${encodeURIComponent(trackId)}`)
      .then((result) => {
        const saved = Array.isArray(result) && result[0] === true;
        if (!isTrackMenuOpen() || state.trackMenuTrack !== track) return;
        likeBtn.dataset.saved = saved ? "1" : "0";
        likeBtn.textContent = saved ? "Remove from Liked Songs" : "Save to Liked Songs";
      })
      .catch((error) => logError("Liked Songs check failed", error));
  }

  const albumId = track.albumId || spotifyUriId(track.albumUri);
  if (albumId) {
    wrap.append(trackMenuButton("Go to Album", () => {
      const albumItem = {
        id: albumId,
        uri: track.albumUri || `spotify:album:${albumId}`,
        name: track.albumName || track.album || "Album",
        images: track.image ? [{ url: track.image }] : [],
        artists: track.artist ? [{ name: track.artist }] : [],
      };
      closeTrackMenu();
      openCollection(albumItem, "album").catch((error) => logError("Go to album failed", error));
    }));
  }

  const menuArtistIds = (track.artistIds || []).filter(Boolean);
  if (menuArtistIds.length) {
    wrap.append(trackMenuButton("Go to Artist", () => {
      closeTrackMenu();
      openArtist(menuArtistIds[0]).catch((error) => logError("Go to artist failed", error));
    }));
  }

  wrap.append(trackMenuButton("Start Radio", () => {
    startRadioFromTrack(track).catch((error) => {
      logError("Start radio failed", error);
      showToast("Couldn't start radio.", "error");
    });
  }));
  focusFirstActive();
}

async function toggleTrackSaved(track, trackId, saved) {
  const response = await spotifyApiFetch(`/v1/me/tracks?ids=${encodeURIComponent(trackId)}`, {
    method: saved ? "DELETE" : "PUT",
  });
  if (!response.ok) {
    throw new Error(`Liked Songs ${saved ? "remove" : "save"} failed (${response.status}): ${await readSpotifyError(response)}`);
  }
  showToast(saved ? `Removed "${track.name}" from Liked Songs.` : `Saved "${track.name}" to Liked Songs.`, "success");
  log(`${saved ? "Removed" : "Saved"} ${track.name} ${saved ? "from" : "to"} Liked Songs.`, "success");
  closeTrackMenu();
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
  // Remember the uri so the Up Next panel can file it under "In queue" rather
  // than mistaking it for context continuation.
  state.sessionQueuedUris.add(track.uri);
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
  invalidateFocusables();
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
    invalidateFocusables();
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
  invalidateFocusables();
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
    if (response.status === 403) {
      // Tokens minted before the playlist-modify scopes were added won't carry
      // permission; only a fresh pair-login fixes it.
      showToast("Re-pair from Settings to enable Add to Playlist (extra Spotify permission needed).", "warn");
      throw new Error("Missing playlist-modify scope (re-pair required)");
    }
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

/* ------------------------------------------------------------------ *
 * W2 Radio auto-fill ("Autoplay similar music")
 * /v1/recommendations and related-artists are dead for dev-mode apps, so the
 * seed source is the current track's artists via /v1/artists/{id}/top-tracks.
 * ------------------------------------------------------------------ */

const RADIO_WINDOW_MS = 25000; // start topping up in the final ~25s of a track
const RADIO_QUEUE_DELAY_MS = 350; // gap between sequential queue POSTs
const RADIO_RECENT_TTL_MS = 15 * 60 * 1000; // lazy refresh of recently-played

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Called every progress tick. Fires the auto-fill at most once per track (latch
// on track id); the latch naturally resets when the track changes.
function maybeAutofillRadio(position, now) {
  if (!state.autoplaySimilar || !now || now.paused) return;
  if (state.repeat !== "off") return;
  if (!now.id || state.radioSeededTrackId === now.id) return;
  const remaining = (now.duration || 0) - position;
  if (!(now.duration > 0 && remaining > 0 && remaining <= RADIO_WINDOW_MS)) return;
  state.radioSeededTrackId = now.id; // latch before any async work
  runRadioAutofill(now).catch((error) => logError("Radio auto-fill failed", error));
}

async function runRadioAutofill(now) {
  // GET /me/player/queue includes context continuation, so a non-empty result
  // means Spotify will keep playing on its own (more album/playlist tracks, or
  // user-queued items) — radio only tops up when the up-next window is empty.
  const queue = await fetchQueueItems();
  if (queue.length > 1) return;
  const exclude = new Set([now.id]);
  const picked = await pickSimilarTracks({ artistIds: now.artistIds || [], exclude });
  if (!picked.length) {
    log("Radio: no similar tracks found to queue.");
    return;
  }
  const queuedCount = await enqueueRadioTracks(picked);
  if (!queuedCount) return;
  state.radioSeedArtist = (now.artist || "").split(",")[0].trim();
  log(`Radio: queued ${queuedCount} similar track${queuedCount === 1 ? "" : "s"} (seeded from ${state.radioSeedArtist}).`, "success");
  if (!state.radioToastShown) {
    state.radioToastShown = true;
    showToast(`Autoplay: queued ${queuedCount} track${queuedCount === 1 ? "" : "s"} similar to ${state.radioSeedArtist}.`, "success");
  }
}

// Recently-played ids, cached per session and refreshed lazily so radio doesn't
// hammer the endpoint once per track.
async function ensureRecentlyPlayedIds() {
  const cache = state.recentlyPlayedCache;
  if (cache && Date.now() - cache.fetchedAt < RADIO_RECENT_TTL_MS) return cache.ids;
  try {
    const data = await spotifyApiJson("/v1/me/player/recently-played?limit=30");
    const ids = new Set((data?.items || []).map((entry) => entry?.track?.id).filter(Boolean));
    state.recentlyPlayedCache = { ids, fetchedAt: Date.now() };
    return ids;
  } catch (error) {
    logError("Recently-played fetch failed", error);
    return cache?.ids || new Set();
  }
}

// Pull top tracks for 1–2 seed artists, drop anything already heard/queued,
// shuffle, and pick 3–5.
async function pickSimilarTracks({ artistIds, exclude }) {
  const seeds = (artistIds || []).filter(Boolean).slice(0, 2);
  if (!seeds.length) return [];
  const recentIds = await ensureRecentlyPlayedIds();
  const excludeIds = new Set([...(exclude || []), ...recentIds]);
  for (const item of state.queueItems || []) {
    if (item.id) excludeIds.add(item.id);
  }
  const pool = [];
  const seen = new Set();
  for (const artistId of seeds) {
    try {
      const data = await spotifyApiJson(`/v1/artists/${encodeURIComponent(artistId)}/top-tracks?market=from_token`);
      for (const track of data?.tracks || []) {
        if (!track?.id || !track.uri) continue;
        if (excludeIds.has(track.id) || seen.has(track.id)) continue;
        seen.add(track.id);
        pool.push(track);
      }
    } catch (error) {
      logError("Radio top-tracks fetch failed", error);
    }
  }
  // Fisher–Yates shuffle so repeat sessions don't always queue the same top hits.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, 3 + Math.floor(Math.random() * 3));
}

// Append picks to the user's active-device queue sequentially with a small gap.
// No device_id param on purpose: playback may live on the phone, and the queue
// belongs to whichever device is active. A 429 aborts the batch and feeds the
// shared poll backoff so we respect Retry-After everywhere.
async function enqueueRadioTracks(tracks) {
  let queued = 0;
  for (const track of tracks) {
    try {
      const response = await spotifyApiFetch(`/v1/me/player/queue?uri=${encodeURIComponent(track.uri)}`, {
        method: "POST",
      });
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("Retry-After") || 30);
        state.playbackPollBackoffUntil = Math.max(state.playbackPollBackoffUntil, Date.now() + retryAfter * 1000);
        log(`Radio: rate-limited while queueing; stopped after ${queued} track${queued === 1 ? "" : "s"}.`, "warn");
        break;
      }
      if (!response.ok) {
        log(`Radio: couldn't queue ${track.name} (${response.status}).`, "warn");
        continue;
      }
      queued += 1;
      state.radioQueuedUris.add(track.uri);
      state.sessionQueuedUris.add(track.uri);
      await sleep(RADIO_QUEUE_DELAY_MS);
    } catch (error) {
      logError("Radio queue add failed", error);
      break;
    }
  }
  return queued;
}

// Explicit "Start Radio" from the track menu: same seed-and-queue, immediately.
async function startRadioFromTrack(track) {
  if (!track?.uri) return;
  requireAccessToken();
  closeTrackMenu();
  showToast("Finding similar tracks…", "info");
  const trackId = track.id || spotifyUriId(track.uri);
  let artistIds = (track.artistIds || []).filter(Boolean);
  let artistName = (track.artist || "").split(",")[0].trim();
  // Tiles built before artist ids were plumbed (or odd payloads) fall back to a
  // single track lookup for the seed artists.
  if (!artistIds.length && trackId) {
    const full = await spotifyApiJson(`/v1/tracks/${encodeURIComponent(trackId)}`);
    artistIds = (full?.artists || []).map((artist) => artist.id).filter(Boolean);
    artistName = full?.artists?.[0]?.name || artistName;
  }
  if (!artistIds.length) {
    showToast("Couldn't find artists to seed radio from.", "error");
    return;
  }
  const picked = await pickSimilarTracks({ artistIds, exclude: new Set(trackId ? [trackId] : []) });
  if (!picked.length) {
    showToast("No similar tracks found.", "warn");
    return;
  }
  const queuedCount = await enqueueRadioTracks(picked);
  if (!queuedCount) {
    showToast("Couldn't queue radio tracks. Start playing something first.", "error");
    return;
  }
  state.radioSeedArtist = artistName;
  showToast(`Radio: queued ${queuedCount} track${queuedCount === 1 ? "" : "s"} similar to ${artistName}.`, "success");
  log(`Radio: queued ${queuedCount} similar tracks (manual seed: ${artistName}).`, "success");
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
    // When another device (e.g. the phone) takes over, this SDK fires one last
    // `paused=true` event holding the LAST track the TV was playing. If our poll
    // has already advanced state.nowPlaying to whatever the phone is on, that
    // stale event would yank the UI backward to the old track + paused state.
    // Skip it: paused=true + mismatched track-id = "I just gave up control".
    const stalePauseFromTransfer =
      playerState.paused
      && track?.id
      && state.nowPlaying?.id
      && state.nowPlaying.id !== track.id;
    if (stalePauseFromTransfer) {
      log(`Spotify SDK paused-after-transfer for ${track.name} ignored; phone holds ${state.nowPlaying.title}.`);
      renderSpotifyFacts();
      return;
    }
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
  if (response.status === 429) {
    // Surface the Retry-After so the poller can back off rather than hammering.
    const retryAfter = Number(response.headers.get("Retry-After") || 30);
    const err = new Error(`Spotify getCurrentPlayback rate-limited (429); retry after ${retryAfter}s`);
    err.status = 429;
    err.retryAfter = retryAfter;
    throw err;
  }
  if (!response.ok) {
    throw new Error(`Spotify getCurrentPlayback failed (${response.status}): ${await readSpotifyError(response)}`);
  }
  const playback = await response.json();
  updateNowPlayingFromWebApi(playback);
  log(`Spotify current playback: device=${playback.device?.name || "unknown"} active=${playback.device?.is_active} playing=${playback.is_playing} item=${playback.item?.name || "unknown"}`);
}

// How often to re-fetch /v1/me/player. Fast cadence on the views where stale
// "now playing" data is glaringly visible (the bubbles/pills the user is
// staring at), slower elsewhere where it just feeds the corner pill.
function getPlaybackPollInterval() {
  if (state.currentView === "ambient" || state.currentView === "now") return 4000;
  return 15000;
}

// Drive periodic playback refreshes so a track change on the phone (or any
// external device) is picked up here within a few seconds. Polls are paused
// when the tab is hidden, when signed out, and during a Retry-After backoff.
function startPlaybackPolling(reason = "") {
  stopPlaybackPolling();
  if (typeof document !== "undefined" && document.hidden) return;
  const signedIn = Boolean(getStoredAccessToken() || localStorage.getItem(storageKeys.refreshToken));
  if (!signedIn) return;
  const tick = () => {
    if (typeof document !== "undefined" && document.hidden) return;
    if (state.playbackPollInFlight) return;
    if (Date.now() < state.playbackPollBackoffUntil) return;
    state.playbackPollInFlight = true;
    getCurrentPlayback()
      .catch((err) => {
        if (err && err.status === 429) {
          const ms = Math.max(5000, Number(err.retryAfter || 30) * 1000);
          state.playbackPollBackoffUntil = Date.now() + ms;
          log(`Spotify playback poll rate-limited; backing off ${Math.round(ms / 1000)}s.`, "warn");
          return;
        }
        // Transient failures (network blips, 5xx) just skip a beat — the next
        // tick will try again. Log so we can see them in Diagnostics.
        logError("Playback poll failed", err);
      })
      .finally(() => {
        state.playbackPollInFlight = false;
      });
  };
  state.playbackPollTimer = window.setInterval(tick, getPlaybackPollInterval());
  // Fire one immediately so view changes get fresh state without waiting a full
  // interval. Guarded by the in-flight + backoff checks inside tick.
  tick();
  if (reason) log(`Playback polling started (${reason}, ${getPlaybackPollInterval()}ms).`);
}

function stopPlaybackPolling() {
  if (state.playbackPollTimer) {
    window.clearInterval(state.playbackPollTimer);
    state.playbackPollTimer = 0;
  }
}

// Used when something that affects the cadence changes (view switch, tab
// visibility flip). No-op if polling wasn't running.
function restartPlaybackPolling(reason = "") {
  if (!state.playbackPollTimer && !(typeof document !== "undefined" && document.hidden)) {
    // Not currently running and we're visible — try to start (signed-in check
    // is inside startPlaybackPolling).
    startPlaybackPolling(reason);
    return;
  }
  if (state.playbackPollTimer) startPlaybackPolling(reason);
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
  stopPlaybackPolling();
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
  const hide = !pairCode || !pairUrl;
  if (elements.pairCard.hidden !== hide) invalidateFocusables();
  elements.pairCard.hidden = hide;
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
    // SDK artists carry uris ("spotify:artist:ID"), not ids — parse them out
    // so the radio auto-fill can seed from the current track everywhere.
    artistIds: (track.artists || []).map((artist) => spotifyUriId(artist.uri)).filter(Boolean),
    albumUri: track.album?.uri || "",
    contextUri: playerState.context?.uri || "",
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
    artistIds: (item.artists || []).map((artist) => artist.id).filter(Boolean),
    albumUri: item.album?.uri || "",
    contextUri: playback.context?.uri || "",
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
  maybeAutofillRadio(position, now);
}

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

// Room-mode artwork crossfade: two stacked <img> layers inside the art frame.
// On a real artwork change we load the new art into the hidden layer first,
// then flip data-art-active so CSS crossfades opacity (~600ms, transform/opacity
// only — TV-safe). renderAmbient runs on every playback update, so the URL
// guard keeps this a no-op unless the artwork actually changed.
const _roomArtState = { url: "", active: "a" };
function updateAmbientRoomArt(image) {
  const frame = elements.ambientRoomArtFrame;
  const a = elements.ambientRoomArt;
  const b = elements.ambientRoomArtB;
  if (!a) return;
  if (!frame || !b) {
    // No B layer in the DOM — fall back to the old direct swap.
    if (image) a.src = image;
    else a.removeAttribute("src");
    return;
  }
  if (image === _roomArtState.url) return;
  const hadArt = Boolean(_roomArtState.url);
  _roomArtState.url = image;
  if (!image) {
    _roomArtState.active = "a";
    frame.dataset.artActive = "a";
    a.removeAttribute("src");
    b.removeAttribute("src");
    return;
  }
  if (!hadArt) {
    // First artwork of the session: nothing to crossfade from, show directly.
    const visible = _roomArtState.active === "b" ? b : a;
    visible.src = image;
    return;
  }
  const incomingKey = _roomArtState.active === "a" ? "b" : "a";
  const incoming = incomingKey === "b" ? b : a;
  incoming.onload = () => {
    incoming.onload = null;
    if (_roomArtState.url !== image) return; // a newer track superseded this load
    _roomArtState.active = incomingKey;
    frame.dataset.artActive = incomingKey;
  };
  incoming.src = image;
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
  if (!palette) return;
  if (elements.viewAmbient) {
    const [a, b, c] = palette;
    if (a) elements.viewAmbient.style.setProperty("--ambient-accent-a", a);
    if (b) elements.viewAmbient.style.setProperty("--ambient-accent-b", b);
    if (c) elements.viewAmbient.style.setProperty("--ambient-accent-c", c);
  }
  // Now Playing shares the track palette: a subtle tint instead of flat black.
  applyPaletteChannels(elements.viewNow, "--np-rgb", palette);
  // Visualizer background wash picks up the palette via CSS rgba(var(--viz-rgb)).
  applyPaletteChannels(elements.viewAmbient, "--viz-rgb", palette);
  // The procedural Scene harmonizes with the playing album: re-tint sky/layers
  // in place (no geometry rebuild, so the slow parallax never jumps).
  applySceneTint();
}

// Writes a palette entry as bare "r, g, b" channels so CSS can compose its own
// alphas via rgba(var(--prop), a) — color-mix() is unavailable on TV Blink.
function applyPaletteChannels(el, prop, palette) {
  if (!el || !palette?.length) return;
  const match = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(palette[0] || "");
  if (!match) return;
  el.style.setProperty(prop, `${match[1]}, ${match[2]}, ${match[3]}`);
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
  // The pill can (dis)appear without a view change (first track of the session)
  // — drop the focusables cache only when its visibility actually flips.
  if (pill.hidden !== !shouldShow) invalidateFocusables();
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

function toggleAutoplaySimilar() {
  state.autoplaySimilar = !state.autoplaySimilar;
  try {
    localStorage.setItem(storageKeys.autoplaySimilar, state.autoplaySimilar ? "1" : "0");
  } catch {}
  applyAutoplaySimilarState();
  log(`Autoplay similar music ${state.autoplaySimilar ? "enabled" : "disabled"}.`);
}

function applyAutoplaySimilarState() {
  const btn = document.getElementById("toggleAutoplay");
  const label = document.getElementById("toggleAutoplayState");
  if (btn) btn.setAttribute("aria-checked", state.autoplaySimilar ? "true" : "false");
  if (label) label.textContent = state.autoplaySimilar ? "On" : "Off";
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
