// Home view: shelves, signed-out hero, refresh.

import { spotifyApiJson } from "../api.js";
import { ensureAccessToken, getStoredAccessToken, requireAccessToken } from "../auth.js";
import { renderShelf, shelfPlaceholder } from "../cards.js";
import { storageKeys } from "../config.js";
import { log, logError, showToast } from "../diagnostics.js";
import { elements } from "../dom.js";
import { invalidateFocusables } from "../focus.js";
import { getCurrentPlayback, startPlaybackPolling } from "../player.js";
import { state } from "../state.js";
import { loadLibrary } from "./library.js";
import { loadDevices } from "./settings.js";

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

export { bootstrapData, refreshAll, splitPlaylists };
