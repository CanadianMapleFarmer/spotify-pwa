// Track context menu (long-press OK) + add-to-playlist picker.

import { readSpotifyError, spotifyApiFetch, spotifyApiJson, withDeviceIdParam } from "./api.js";
import { log, logError, showToast } from "./diagnostics.js";
import { elements } from "./dom.js";
import { activeFocusables, clearEnterHold, focusElement, invalidateFocusables } from "./focus.js";
import { ensureSpotifyDeviceReady } from "./player.js";
import { startRadioFromTrack } from "./queue.js";
import { state } from "./state.js";
import { openArtist } from "./views/artist.js";
import { openCollection } from "./views/collection.js";

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
  // #3 safety net: a long-press interrupted by menu-open/navigation must never
  // leave a stale .is-holding tint on the row it was charging.
  clearEnterHold();
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
    log(`Load playlists failed: ${error?.message || error}`, "warn");
    showToast("Couldn't load your playlists.", "error");
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

export { closeTrackMenu, isTrackMenuOpen, openTrackMenuFromFocus, spotifyUriId };
