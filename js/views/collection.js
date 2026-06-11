// Collection view: album/playlist track list with windowed rendering, shuffle and save.

import { applyPaletteChannels, extractPalette } from "../ambient/palette.js";
import { readSpotifyError, spotifyApiFetch, spotifyApiJson, withDeviceIdParam } from "../api.js";
import { requireAccessToken } from "../auth.js";
import { log, logError, showToast } from "../diagnostics.js";
import { elements } from "../dom.js";
import { captureListFocusIndex, focusElement, invalidateFocusables, restoreListFocusIndex } from "../focus.js";
import { activateSpotifyElement, ensureSpotifyDeviceReady, getCurrentPlayback } from "../player.js";
import { setView } from "../shell.js";
import { state } from "../state.js";
import { escapeHtml, formatDuration, formatTotalDuration, getImage } from "../utils.js";
import { renderTransportState } from "./now.js";

// W4: bounded pagination + windowed rendering for big collections. The first
// page paints immediately, the rest stream in the background; rows only enter
// the DOM in chunks as focus approaches the end of what's rendered.
const COLLECTION_MAX_TRACKS = 500;
const COLLECTION_RENDER_CHUNK = 60;
const COLLECTION_RENDER_LOOKAHEAD = 25; // rows of headroom before extending (covers accelerated key-repeat)

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
      applyPaletteChannels(elements.viewCollection, "--coll-rgb", palette, { scrimBoost: true });
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
  const focusIdx = captureListFocusIndex(list); // #14: full re-render may vaporize the focused row
  list.replaceChildren();
  coll.renderedCount = 0;
  invalidateFocusables();

  if (coll.loading) {
    const note = document.createElement("p");
    note.className = "collection-note";
    note.textContent = "Loading tracks…";
    list.append(note);
  } else if (coll.error) {
    const note = document.createElement("p");
    note.className = "collection-note collection-note--error";
    note.textContent = coll.error;
    list.append(note);
  } else if (!coll.tracks.length) {
    const note = document.createElement("p");
    note.className = "collection-note";
    note.textContent = "No tracks here.";
    list.append(note);
  } else {
    renderMoreCollectionRows();
  }

  restoreListFocusIndex(list, focusIdx);
  // List collapsed to a non-focusable note — fall back to the header controls.
  if (focusIdx >= 0 && document.activeElement === document.body && elements.collectionShuffleBtn) {
    focusElement(elements.collectionShuffleBtn);
  }
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
    // #21: shuffled starts are otherwise indistinguishable from a mis-tap that
    // landed on the wrong song — say so.
    if (state.collectionShuffle) showToast("Playing — shuffle on", "success");
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

export {
  collectionBack,
  handleCollectionTracksFocusIn,
  openCollection,
  playCollection,
  renderCollectionPlayingState,
  toggleCollectionSaved,
  toggleCollectionShuffle,
};
