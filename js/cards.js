// Shared shelf/card renderers used by Home, Library, Search and Artist.

import { readSpotifyError, spotifyApiFetch, withDeviceIdParam } from "./api.js";
import { requireAccessToken } from "./auth.js";
import { log, logError } from "./diagnostics.js";
import { emptyState } from "./dom.js";
import { invalidateFocusables } from "./focus.js";
import { activateSpotifyElement, ensureSpotifyDeviceReady, getCurrentPlayback } from "./player.js";
import { escapeAttribute, escapeHtml, getImage } from "./utils.js";
import { openArtist } from "./views/artist.js";
import { openCollection } from "./views/collection.js";

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

export { playItem, renderShelf, shelfPlaceholder };
