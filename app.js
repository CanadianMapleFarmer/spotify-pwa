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
};

const PHONE_MODE_SESSION_KEY = "spotify-pwa.phone-mode";
const PAIR_SESSION_COLLECTION = "pairSessions";
const PAIR_SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes — long enough for a phone OAuth round trip

const AMBIENT_MODES = ["room", "screensaver", "visualizer"];
const AMBIENT_MODE_LABELS = {
  room: "Room Display",
  screensaver: "Screensaver",
  visualizer: "Visualizer",
};
const BUBBLE_CORNERS = ["bl", "br", "tr", "tl"];

const state = {
  focusIndex: 0,
  spotifyPlayer: null,
  spotifyPlayerPromise: null,
  spotifyDeviceId: "",
  spotifyVolume: 0.7,
  pairPollTimer: 0,
  currentView: "home",
  ambientMode: "room",
  nowPlaying: null,
  progressTimer: 0,
  remoteEvents: [],
  debugVisible: false,
  paletteCache: { url: "", palette: null },
  bubbleCornerIndex: 0,
  bubbleCornerTimer: 0,
  pillDimTimer: 0,
  visualizerRaf: 0,
  visualizerPhase: 0,
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
  recentShelf: document.querySelector("#recentShelf"),
  topShelf: document.querySelector("#topShelf"),
  albumShelf: document.querySelector("#albumShelf"),
  savedShelf: document.querySelector("#savedShelf"),
  playlistShelf: document.querySelector("#playlistShelf"),
  libraryAlbumsShelf: document.querySelector("#libraryAlbumsShelf"),
  libraryTracksShelf: document.querySelector("#libraryTracksShelf"),
  devicesGrid: document.querySelector("#devicesGrid"),
  nowArtwork: document.querySelector("#nowArtwork"),
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
  ambientBubbleArt: document.querySelector("#ambientBubbleArt"),
  ambientBubbleTitle: document.querySelector("#ambientBubbleTitle"),
  ambientBubbleArtist: document.querySelector("#ambientBubbleArtist"),
  ambientDriftA: document.querySelector("#ambientDriftA"),
  ambientDriftB: document.querySelector("#ambientDriftB"),
  ambientDriftC: document.querySelector("#ambientDriftC"),
  ambientDriftD: document.querySelector("#ambientDriftD"),
  ambientVisualizerCanvas: document.querySelector("#ambientVisualizerCanvas"),
  ambientVisualizerArt: document.querySelector("#ambientVisualizerArt"),
  ambientControls: document.querySelector("#ambientControls"),
  ambientProgressFill: document.querySelector("#ambientProgressFill"),
  ambientProgressTime: document.querySelector("#ambientProgressTime"),
  toastStack: document.querySelector("#toastStack"),
  npPill: document.querySelector("#npPill"),
  npPillArt: document.querySelector("#npPillArt"),
  npPillTitle: document.querySelector("#npPillTitle"),
  npPillArtist: document.querySelector("#npPillArtist"),
  npPillProgressFill: document.querySelector("#npPillProgressFill"),
  npPillPlayBtn: document.querySelector("#npPillPlayBtn"),
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
  runDeviceChecks,
  refreshAll,
  loadLibrary,
  loadDevices,
  setAmbientMode,
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
  handleSpotifyRedirect().catch((error) => logError("Spotify redirect failed", error));
  renderPairInfo();
  renderShellState();
  renderNpPill();
  renderAmbient();
  startProgressTimer();
  startBubbleCornerTimer();
  scheduleSpotifyPlayerCreation("app init");
  focusFirst();
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
    const savedDebug = localStorage.getItem(storageKeys.debugVisible);
    state.debugVisible = savedDebug === "1";
  } catch {
    // localStorage unavailable; defaults already set
  }
  applyDebugVisibility();
  for (const button of document.querySelectorAll("[data-action='setAmbientMode']")) {
    button.classList.toggle("is-active", button.dataset.mode === state.ambientMode);
  }
}

function focusableElements() {
  return Array.from(document.querySelectorAll(".focusable:not([disabled])")).filter(isVisibleElement);
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

  const source = getElementCenter(active);
  const candidates = focusables
    .filter((element) => element !== active)
    .map((element) => {
      const target = getElementCenter(element);
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const inDirection =
        (direction === "right" && dx > 12 && Math.abs(dx) >= Math.abs(dy) * 0.45) ||
        (direction === "left" && dx < -12 && Math.abs(dx) >= Math.abs(dy) * 0.45) ||
        (direction === "down" && dy > 12 && Math.abs(dy) >= Math.abs(dx) * 0.35) ||
        (direction === "up" && dy < -12 && Math.abs(dy) >= Math.abs(dx) * 0.35);
      if (!inDirection) return null;
      const primary = direction === "left" || direction === "right" ? Math.abs(dx) : Math.abs(dy);
      const secondary = direction === "left" || direction === "right" ? Math.abs(dy) : Math.abs(dx);
      return { element, score: primary + secondary * 2.2 };
    })
    .filter(Boolean)
    .sort((a, b) => a.score - b.score);

  if (candidates.length) {
    focusElement(candidates[0].element);
    return;
  }

  if (direction === "down" || direction === "right") moveFocus(1);
  if (direction === "up" || direction === "left") moveFocus(-1);
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
      setView("home");
      log("Back key observed. Returned to Home.");
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
  try {
    const result = action(event);
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
  await Promise.allSettled([loadHome(), loadLibrary(), loadDevices(), getCurrentPlayback()]);
  log("Spotify app data refreshed.", "success");
}

async function loadHome() {
  requireAccessToken();
  const [recent, top, albums, saved] = await Promise.allSettled([
    spotifyApiJson("/v1/me/player/recently-played?limit=12"),
    spotifyApiJson("/v1/me/top/tracks?limit=12&time_range=short_term"),
    spotifyApiJson("/v1/me/albums?limit=12"),
    spotifyApiJson("/v1/me/tracks?limit=12"),
  ]);
  renderShelf(
    elements.recentShelf,
    "Recently Played",
    uniqueTracks((recent.value?.items || []).map((item) => item.track)).slice(0, 12),
    "track"
  );
  renderShelf(elements.topShelf, "Your Top Tracks", top.value?.items || [], "track");
  renderShelf(
    elements.albumShelf,
    "Saved Albums",
    (albums.value?.items || []).map((item) => item.album),
    "album"
  );
  renderShelf(
    elements.savedShelf,
    "Saved Songs",
    (saved.value?.items || []).map((item) => item.track),
    "track"
  );
}

async function loadLibrary() {
  requireAccessToken();
  const [playlists, albums, tracks] = await Promise.all([
    spotifyApiJson("/v1/me/playlists?limit=24"),
    spotifyApiJson("/v1/me/albums?limit=24"),
    spotifyApiJson("/v1/me/tracks?limit=24"),
  ]);
  renderShelf(elements.playlistShelf, "Playlists", playlists.items || [], "playlist");
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

function renderShelf(container, title, items, type) {
  if (!container) return;
  container.replaceChildren();
  const heading = document.createElement("h3");
  heading.textContent = title;
  const rail = document.createElement("div");
  rail.className = "rail";
  rail.setAttribute("role", "list");
  rail.setAttribute("aria-label", title);
  for (const item of items.filter(Boolean)) {
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
  button.addEventListener("click", () => playItem(item, type));
  return button;
}

async function playItem(item, type) {
  requireAccessToken();
  if (type === "playlist" || type === "album") {
    await spotifyApiFetch("/v1/me/player/play", {
      method: "PUT",
      body: JSON.stringify({ context_uri: item.uri }),
    });
  } else {
    await spotifyApiFetch("/v1/me/player/play", {
      method: "PUT",
      body: JSON.stringify({ uris: [item.uri] }),
    });
  }
  log(`Requested playback: ${item.name}`, "success");
  await getCurrentPlayback();
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
  if (state.currentView === "ambient") {
    startVisualizerIfNeeded();
  }
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
  await spotifyApiFetch("/v1/me/player/next", { method: "POST" });
  log("Spotify next track requested.", "success");
  window.setTimeout(() => getCurrentPlayback().catch((error) => logError("Playback refresh failed", error)), 800);
}

async function previousTrack() {
  await spotifyApiFetch("/v1/me/player/previous", { method: "POST" });
  log("Spotify previous track requested.", "success");
  window.setTimeout(() => getCurrentPlayback().catch((error) => logError("Playback refresh failed", error)), 800);
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
    log("Spotify current playback: no active playback.", "error");
    return;
  }
  const playback = await response.json();
  updateNowPlayingFromWebApi(playback);
  log(
    `Spotify current playback: device=${playback.device?.name || "unknown"} active=${playback.device?.is_active} playing=${playback.is_playing} item=${playback.item?.name || "unknown"}`,
    response.ok ? "success" : "error"
  );
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
    title: track.name,
    artist: (track.artists || []).map((artist) => artist.name).join(", "),
    image: track.album?.images?.[0]?.url || "",
    paused: playerState.paused,
    position: playerState.position || 0,
    duration,
    updatedAt: Date.now(),
  };
  renderNowPlaying();
}

function updateNowPlayingFromWebApi(playback) {
  const item = playback.item;
  if (!item) return;
  state.nowPlaying = {
    title: item.name,
    artist: (item.artists || []).map((artist) => artist.name).join(", "),
    image: item.album?.images?.[0]?.url || "",
    paused: !playback.is_playing,
    position: playback.progress_ms || 0,
    duration: item.duration_ms || 0,
    updatedAt: Date.now(),
  };
  renderNowPlaying();
}

function renderNowPlaying() {
  const now = state.nowPlaying;
  if (!now) {
    renderNpPill();
    return;
  }
  elements.nowArtwork.src = now.image;
  elements.nowContext.textContent = now.paused ? "Paused" : "Playing";
  elements.nowTitle.textContent = now.title;
  elements.nowArtist.textContent = now.artist;
  elements.ambientTitle.textContent = now.title;
  elements.ambientSubtitle.textContent = now.artist;
  refreshAmbientPalette(now.image);
  renderProgress();
  renderAmbient();
  renderNpPill();
}

function renderProgress() {
  const now = state.nowPlaying;
  if (!now) return;
  const elapsed = now.paused ? now.position : now.position + (Date.now() - now.updatedAt);
  const position = Math.min(elapsed, now.duration || elapsed);
  const ratio = now.duration ? position / now.duration : 0;
  const percent = Math.max(0, Math.min(100, ratio * 100));
  elements.progressFill.style.width = `${percent}%`;
  elements.positionText.textContent = formatDuration(position);
  elements.durationText.textContent = formatDuration(now.duration);
  if (elements.npPillProgressFill) {
    elements.npPillProgressFill.style.width = `${percent}%`;
  }
  if (elements.ambientProgressFill) {
    elements.ambientProgressFill.style.width = `${percent}%`;
  }
  if (elements.ambientProgressTime) {
    elements.ambientProgressTime.textContent = `${formatDuration(position)} / ${formatDuration(now.duration)}`;
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

  if (elements.ambientBubbleArt) {
    if (image) {
      elements.ambientBubbleArt.src = image;
    } else {
      elements.ambientBubbleArt.removeAttribute("src");
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
  const inAmbient = state.currentView === "ambient";
  const shouldShow = Boolean(now) && !inAmbient;
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
  const draw = () => {
    if (state.ambientMode !== "visualizer" || state.currentView !== "ambient") {
      stopVisualizer();
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    state.visualizerPhase += prefersReduced ? 0 : 0.06;
    drawVisualizerFrame(ctx, w, h, state.visualizerPhase, state.paletteCache.palette);
    state.visualizerRaf = prefersReduced ? 0 : window.requestAnimationFrame(draw);
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
  const accent = (palette && palette[0]) || "#1ed760";
  const accentB = (palette && palette[1]) || "#70a6ff";
  ctx.clearRect(0, 0, w, h);
  const bars = 48;
  const barWidth = w / bars;
  const baseY = h * 0.78;
  const now = state.nowPlaying;
  const positionMs = now ? (now.paused ? now.position : now.position + (Date.now() - now.updatedAt)) : 0;
  const beat = now ? (positionMs / 350) : phase;
  const energy = now && !now.paused ? 1 : 0.35;
  for (let i = 0; i < bars; i++) {
    const t = i / bars;
    const seed = Math.sin(phase * 0.9 + i * 0.42) * 0.5 + 0.5;
    const beatPulse = Math.abs(Math.sin(beat + i * 0.18)) * 0.6;
    const amplitude = (seed * 0.55 + beatPulse * 0.45) * energy;
    const barH = amplitude * h * 0.42 + 4;
    const x = i * barWidth + barWidth * 0.18;
    const wBar = barWidth * 0.64;
    const grad = ctx.createLinearGradient(0, baseY - barH, 0, baseY);
    grad.addColorStop(0, accent);
    grad.addColorStop(1, accentB);
    ctx.fillStyle = grad;
    ctx.fillRect(x, baseY - barH, wBar, barH);
    // mirror
    ctx.globalAlpha = 0.18;
    ctx.fillRect(x, baseY, wBar, barH * 0.6);
    ctx.globalAlpha = 1;
  }
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

function uniqueTracks(tracks) {
  const seen = new Set();
  return tracks.filter((track) => {
    if (!track?.id || seen.has(track.id)) return false;
    seen.add(track.id);
    return true;
  });
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
