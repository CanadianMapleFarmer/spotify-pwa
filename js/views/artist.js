// Artist page: top tracks and discography.

import { applyPaletteChannels, extractPalette } from "../ambient/palette.js";
import { spotifyApiJson } from "../api.js";
import { requireAccessToken } from "../auth.js";
import { playItem, renderShelf } from "../cards.js";
import { logError, showToast } from "../diagnostics.js";
import { elements } from "../dom.js";
import { invalidateFocusables } from "../focus.js";
import { setView } from "../shell.js";
import { state } from "../state.js";
import { spotifyUriId } from "../track-menu.js";
import { escapeHtml, formatDuration, formatFollowers, pickImageUrl } from "../utils.js";
import { renderCollectionPlayingState } from "./collection.js";

/* ------------------------------------------------------------------ *
 * W4 Artist page: hero + top tracks + albums shelf. Mirrors the
 * collection-view pattern (sibling view, return-view memory, palette tint).
 * ------------------------------------------------------------------ */

function artistBack() {
  setView(state.artistReturnView || "home");
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
      applyPaletteChannels(elements.viewArtist, "--coll-rgb", palette, { scrimBoost: true });
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

export { artistBack, openArtist };
