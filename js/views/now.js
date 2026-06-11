// Now Playing view: artwork, transport state, progress, and the shell now-playing pill.

import { renderAmbient } from "../ambient/index.js";
import { refreshAmbientPalette } from "../ambient/palette.js";
import { elements } from "../dom.js";
import { invalidateFocusables } from "../focus.js";
import { maybeAutofillRadio, maybeUpdateUpNext } from "../queue.js";
import { state } from "../state.js";
import { formatDuration } from "../utils.js";
import { renderCollectionPlayingState } from "./collection.js";

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
  if (elements.npPillArtist) {
    // When another device holds playback, fold "· on <device>" into the artist
    // line — same footprint, the line already ellipsizes.
    elements.npPillArtist.replaceChildren(document.createTextNode(now.artist || ""));
    const remote = state.activeDevice?.id && state.activeDevice.id !== state.spotifyDeviceId;
    if (remote) {
      const dev = document.createElement("span");
      dev.className = "np-pill__device";
      dev.textContent = ` · on ${state.activeDevice.name || "another device"}`;
      elements.npPillArtist.append(dev);
    }
  }
  if (elements.npPillPlayBtn) {
    const isPlaying = !now.paused;
    elements.npPillPlayBtn.setAttribute("aria-label", isPlaying ? "Pause" : "Play");
    const svg = elements.npPillPlayBtn.querySelector("svg path");
    if (svg) {
      svg.setAttribute("d", isPlaying ? "M6 5h4v14H6zm8 0h4v14h-4z" : "M8 5v14l11-7z");
    }
  }
}

export { renderNowPlaying, renderNpPill, renderTransportState, startProgressTimer };
