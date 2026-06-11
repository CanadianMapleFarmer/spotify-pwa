// Queue drawer, up-next card and radio auto-fill.

import { readSpotifyError, spotifyApiFetch, spotifyApiJson, withDeviceIdParam } from "./api.js";
import { requireAccessToken } from "./auth.js";
import { log, logError, showToast } from "./diagnostics.js";
import { elements } from "./dom.js";
import {
  activeFocusables,
  captureListFocusIndex,
  focusElement,
  invalidateFocusables,
  restoreListFocusIndex,
} from "./focus.js";
import { activateSpotifyElement, ensureSpotifyDeviceReady, noteRateLimitBackoff } from "./player.js";
import { state } from "./state.js";
import { closeTrackMenu, spotifyUriId } from "./track-menu.js";
import { escapeHtml, sleep } from "./utils.js";

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
  row.innerHTML = `
    <span class="queue-row__art"></span>
    <span class="queue-row__body">
      <span class="queue-row__title">${escapeHtml(track.name)}</span>
      <span class="queue-row__artist">${escapeHtml(track.artist)}</span>
    </span>
    <span class="queue-row__pos">${position}</span>
  `;
  // Set via the style API: inlining url("…") inside a double-quoted style
  // attribute terminates the attribute at the inner quotes — art never rendered.
  if (track.image) {
    row.querySelector(".queue-row__art").style.backgroundImage = `url("${track.image}")`;
  }
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
  const focusIdx = captureListFocusIndex(list);
  renderQueueDrawerContent(list, errorMessage);
  restoreListFocusIndex(list, focusIdx);
  // List collapsed to a non-focusable note (empty/error)? Land on Close so the
  // remote never goes dead inside the open drawer.
  if (focusIdx >= 0 && document.activeElement === document.body) {
    const close = elements.queueDrawer?.querySelector(".queue-drawer__close");
    if (close) focusElement(close);
  }
}

function renderQueueDrawerContent(list, errorMessage) {
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
    nowRow.innerHTML = `
      <span class="queue-row__art"></span>
      <span class="queue-row__body">
        <span class="queue-row__title">${escapeHtml(now.title)}</span>
        <span class="queue-row__artist">${escapeHtml(now.artist)}</span>
      </span>
      <span class="queue-row__pos">${now.paused ? "Paused" : "Playing"}</span>
    `;
    if (now.image) {
      nowRow.querySelector(".queue-row__art").style.backgroundImage = `url("${now.image}")`;
    }
    list.append(nowRow);
  }

  const items = state.queueItems || [];
  if (!items.length) {
    const note = document.createElement("p");
    note.className = "queue-drawer__note";
    note.textContent = "Nothing up next. Spotify's queue is append-only — hold OK on any track and choose Add to Queue, or leave Autoplay on to keep the music going.";
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
        noteRateLimitBackoff(retryAfter);
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

export {
  closeQueueDrawer,
  isQueueDrawerOpen,
  maybeAutofillRadio,
  maybeUpdateUpNext,
  openQueueDrawer,
  startRadioFromTrack,
};
