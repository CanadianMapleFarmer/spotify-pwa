// Web Playback SDK device lifecycle, transport actions, transfer, volume,
// playback polling and now-playing sync.

import { readSpotifyError, spotifyApiFetch, withDeviceIdParam } from "./api.js";
import { ensureAccessToken, getStoredAccessToken } from "./auth.js";
import { storageKeys } from "./config.js";
import { log, logError, showToast } from "./diagnostics.js";
import { elements } from "./dom.js";
import { state } from "./state.js";
import { spotifyUriId } from "./track-menu.js";
import { renderNowPlaying, renderTransportState } from "./views/now.js";
import { loadDevices, renderSpotifyFacts } from "./views/settings.js";

// #4: a missing TV player is the most common dead-end on a fresh session.
// Surface one actionable toast (latched to once a minute so transport mashing
// doesn't spam) and keep throwing so callers abort cleanly — controls stay
// visible and focusable, the user just gets told what to do.
const NO_DEVICE_TOAST_EVERY_MS = 60000;
let _noDeviceToastAt = 0;

async function ensureSpotifyDeviceReady() {
  if (state.spotifyDeviceId && state.spotifyPlayer) return state.spotifyDeviceId;
  try {
    return await createSpotifyPlayer();
  } catch (error) {
    const now = Date.now();
    if (now - _noDeviceToastAt >= NO_DEVICE_TOAST_EVERY_MS) {
      _noDeviceToastAt = now;
      showToast("No TV player yet — open Settings and press Create TV Player.", "warn");
    }
    const err = new Error(`TV player not ready: ${error?.message || error}`);
    err.handled = true; // logError logs it as a warning, no duplicate toast
    throw err;
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
    state.spotifyDeviceOffline = false;
    elements.deviceStatus.textContent = `TV player ready`;
    log(`Spotify player ready. Device ID: ${device_id}`, "success");
    renderSpotifyFacts();
  });

  state.spotifyPlayer.addListener("not_ready", ({ device_id }) => {
    // #15: keep the status strip honest — the SDK device dropped off Connect.
    state.spotifyDeviceOffline = true;
    log(`Spotify device went offline: ${device_id}`, "error");
    renderSpotifyFacts();
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

// Resolve a Connect device id to a name worth toasting. knownDevices is the
// last /me/player/devices payload; the TV's own SDK device may not be in it yet.
function deviceDisplayName(deviceId) {
  const match = (state.knownDevices || []).find((device) => device.id === deviceId);
  if (match?.name) return match.name;
  if (deviceId && deviceId === state.spotifyDeviceId) return "this TV";
  return "the selected device";
}

async function transferToDevice(deviceId) {
  if (!deviceId) throw new Error("Missing Spotify device id.");
  const response = await spotifyApiFetch("/v1/me/player", {
    method: "PUT",
    body: JSON.stringify({ device_ids: [deviceId], play: true }),
  });
  if (!response.ok) {
    const detail = await readSpotifyError(response);
    showToast(`Couldn't move playback: ${detail}`, "error");
    log(`Spotify transfer playback returned ${response.status}: ${detail}`, "warn");
    const error = new Error(`Spotify transfer failed (${response.status})`);
    error.handled = true; // friendly toast already shown
    throw error;
  }
  log(`Spotify transfer playback returned ${response.status}.`, "success");
  showToast(`Playback moved to ${deviceDisplayName(deviceId)}.`, "success");
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

// #16: feed a 429 Retry-After into the shared poll backoff and show one
// low-profile toast per backoff window (not per suppressed request).
let _rateLimitToastWindowEnd = 0;
function noteRateLimitBackoff(retryAfterSec) {
  const until = Date.now() + retryAfterSec * 1000;
  state.playbackPollBackoffUntil = Math.max(state.playbackPollBackoffUntil, until);
  if (Date.now() >= _rateLimitToastWindowEnd) {
    _rateLimitToastWindowEnd = state.playbackPollBackoffUntil;
    showToast(`Spotify rate-limited — retrying in ${Math.max(1, Math.round(retryAfterSec))}s.`, "info");
  }
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
          const sec = Math.max(5, Number(err.retryAfter || 30));
          noteRateLimitBackoff(sec);
          log(`Spotify playback poll rate-limited; backing off ${sec}s.`, "warn");
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
  // SDK state means this TV is the active player.
  if (state.spotifyDeviceId) {
    state.activeDevice = { id: state.spotifyDeviceId, name: "" };
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
  if (playback.device?.id) {
    state.activeDevice = { id: playback.device.id, name: playback.device.name || "" };
  }
  renderNowPlaying();
}

export {
  activateSpotifyElement,
  changeSpotifyVolume,
  createSpotifyPlayer,
  cycleRepeat,
  ensureSpotifyDeviceReady,
  getCurrentPlayback,
  loadSpotifySdk,
  nextTrack,
  noteRateLimitBackoff,
  previousTrack,
  restartPlaybackPolling,
  scheduleSpotifyPlayerCreation,
  startPlaybackPolling,
  stopPlaybackPolling,
  toggleShuffle,
  toggleSpotifyPlayback,
  transferPlayback,
  transferToDevice,
  volumeDown,
  volumeUp,
};
