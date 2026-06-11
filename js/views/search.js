// Search view: on-screen keyboard, debounced query, result shelves.

import { spotifyApiJson } from "../api.js";
import { renderShelf } from "../cards.js";
import { log, logError } from "../diagnostics.js";
import { elements } from "../dom.js";
import { invalidateFocusables } from "../focus.js";

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

export { buildSearchKeyboard, renderSearchQuery };
