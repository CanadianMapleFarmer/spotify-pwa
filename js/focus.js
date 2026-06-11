// Spatial-focus engine: focusables cache, directional movement, remote key
// normalization/repeat, long-press OK, Back handling and the exit dialog.

// Module-dependency note: the focus engine dispatches remote keys and Back
// into the feature modules (queue, track-menu, views, player, ambient), while
// those same modules import focus helpers (focusElement, invalidateFocusables,
// ...) — static import cycles. That is safe here because every cyclic
// reference is a hoisted function declaration resolved through live ES-module
// bindings at call time; no module reads an imported binding during module
// evaluation.

import { handleAmbientModeArrow } from "./ambient/index.js";
import { isDiagnosticsOpen, log, logError, logRemoteEvent, scrollDiagnostics, toggleDebugView } from "./diagnostics.js";
import { elements } from "./dom.js";
import { changeSpotifyVolume, nextTrack, previousTrack, toggleSpotifyPlayback } from "./player.js";
import { closeQueueDrawer, isQueueDrawerOpen } from "./queue.js";
import { setView } from "./shell.js";
import { state } from "./state.js";
import { closeTrackMenu, isTrackMenuOpen, openTrackMenuFromFocus } from "./track-menu.js";
import { artistBack } from "./views/artist.js";
import { collectionBack } from "./views/collection.js";

function focusableElements() {
  return activeFocusables();
}

// Mirrors :focus-within as a .has-focus class — the VIDAA browser predates the
// pseudo-class, and the rail/ambient-control reveals depend on it.
function wireFocusWithinClass(container) {
  if (!container) return;
  container.addEventListener("focusin", () => container.classList.add("has-focus"));
  container.addEventListener("focusout", (event) => {
    const next = event.relatedTarget;
    if (!next || !container.contains(next)) container.classList.remove("has-focus");
  });
}

// --- W4: focusables memoization ---------------------------------------------
// Resolving the focus pool walks the DOM (querySelectorAll + getComputedStyle +
// getBoundingClientRect per element) and used to run on every arrow keypress —
// expensive on the TV's CPU. Cache the resolved array and invalidate it from
// every render/visibility mutation site (invalidateFocusables). The cache key
// captures modal/view context so view switches and modal opens re-resolve on
// their own; the isConnected sweep self-heals after any replaceChildren path
// that slipped through without an explicit invalidate.
let _focusablesCache = null;
let _focusablesCacheKey = "";

function invalidateFocusables() {
  _focusablesCache = null;
}

function focusablesContextKey() {
  return [
    isExitDialogOpen() ? "exit" : "",
    isTrackMenuOpen() ? "menu" : "",
    isQueueDrawerOpen() ? "drawer" : "",
    state.currentView,
    isDiagnosticsOpen() ? "diag" : "",
  ].join("|");
}

function activeFocusables() {
  const key = focusablesContextKey();
  if (_focusablesCache && _focusablesCacheKey === key) {
    let intact = true;
    for (const el of _focusablesCache) {
      if (!el.isConnected) { intact = false; break; }
    }
    if (intact) return _focusablesCache;
  }
  const result = computeActiveFocusables();
  _focusablesCache = result;
  _focusablesCacheKey = key;
  return result;
}

// Scope the focus pool to the chrome (nav) + the active view + the now-playing pill.
// This stops "down"/"right" from teleporting into an off-screen view's controls.
function computeActiveFocusables() {
  // While the exit dialog is open it owns the focus pool — trap the remote on its
  // Cancel/Exit buttons so arrows can't escape to the (covered) view behind it.
  if (isExitDialogOpen()) {
    return Array.from(elements.exitDialog.querySelectorAll(".focusable:not([disabled])")).filter(isVisibleElement);
  }
  // The track menu and queue drawer are modal too — trap the remote inside them
  // so arrows can't escape to the view behind. Back closes (see handleBack).
  if (isTrackMenuOpen()) {
    return Array.from(elements.trackMenu.querySelectorAll(".focusable:not([disabled])")).filter(isVisibleElement);
  }
  if (isQueueDrawerOpen()) {
    return Array.from(elements.queueDrawer.querySelectorAll(".focusable:not([disabled])")).filter(isVisibleElement);
  }
  const roots = [];
  const nav = document.querySelector(".nav");
  if (nav) roots.push(nav);
  const activeView = document.getElementById(`view-${state.currentView}`);
  if (activeView) roots.push(activeView);
  const pill = document.getElementById("npPill");
  if (pill) roots.push(pill);
  // Diagnostics is a body-level panel — when Debug View is on, include its
  // focusables (including the scrollable log) so the remote can reach them.
  const diagnostics = document.getElementById("diagnostics");
  if (diagnostics && !diagnostics.hidden) roots.push(diagnostics);

  const seen = new Set();
  const result = [];
  for (const root of roots) {
    const matches = root.matches?.(".focusable:not([disabled])") ? [root] : [];
    for (const el of matches.concat(Array.from(root.querySelectorAll(".focusable:not([disabled])")))) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (isVisibleElement(el)) result.push(el);
    }
  }
  return result;
}

// Overlap length of two 1D segments; positive means they share span on that axis.
function overlap1D(aStart, aEnd, bStart, bEnd) {
  return Math.min(aEnd, bEnd) - Math.max(aStart, bStart);
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
  // preventScroll stops the browser's automatic scroll-on-focus, which on
  // VIDAA scrolls the fixed ambient overlay and leaves a stuck bar at the
  // bottom. keepElementVisible handles any intentional scrolling instead.
  try {
    element.focus({ preventScroll: true });
  } catch {
    element.focus();
  }
  keepElementVisible(element);
}

function keepElementVisible(element) {
  // The ambient view is a fixed, full-bleed overlay (position:fixed; inset:0) —
  // nothing in it is ever in normal scroll flow. scrollIntoView there still
  // scrolls the document on VIDAA and leaves a "bar" stuck at the bottom that
  // never scrolls back, so skip it entirely and hard-pin the page to the top.
  if (document.body.dataset.view === "ambient") {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    return;
  }
  // During held-key repeats smooth scrolling piles up queued animations and the
  // viewport lags behind focus — repeats scroll instantly instead.
  const behavior = _repeatScrollInstant ? "auto" : "smooth";
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
        rail.scrollTo({ left: Math.max(0, nextLeft), behavior });
      } catch {
        rail.scrollLeft = Math.max(0, nextLeft);
      }
    }
    try {
      rail.closest(".shelf")?.scrollIntoView({ block: "nearest", inline: "nearest", behavior });
    } catch {
      rail.closest(".shelf")?.scrollIntoView();
    }
    return;
  }

  try {
    element.scrollIntoView({ block: "nearest", inline: "nearest", behavior });
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

  // Rail items expand to full open-rail width while focused, which would put
  // their right edge *past* the leftmost content and make "right" skip it.
  // Measure from the (collapsed-size) icon box instead so geometry matches
  // what the user sees as the rail's resting column.
  const railIcon = active.closest?.(".nav-rail") ? active.querySelector(".nav-item__icon") : null;
  const a = (railIcon || active).getBoundingClientRect();
  const horizontal = direction === "left" || direction === "right";

  const candidates = focusables
    .filter((element) => element !== active)
    .map((element) => {
      const r = element.getBoundingClientRect();
      // "ahead" = edge-to-edge gap in the travel direction; must clear the active box.
      let ahead;
      if (direction === "right") ahead = r.left - a.right;
      else if (direction === "left") ahead = a.left - r.right;
      else if (direction === "down") ahead = r.top - a.bottom;
      else ahead = a.top - r.bottom;
      // Require the candidate to genuinely lie ahead (allow slight overlap of edges).
      if (ahead < -Math.min(a.width, a.height) * 0.5) return null;
      const aheadDist = Math.max(0, ahead);

      // Cross-axis overlap: prefer candidates that share span on the perpendicular axis.
      const overlap = horizontal
        ? overlap1D(a.top, a.bottom, r.top, r.bottom)
        : overlap1D(a.left, a.right, r.left, r.right);
      // Negative overlap means a gap; turn it into a penalty distance.
      const offAxisGap = overlap > 0 ? 0 : -overlap;
      // Overlapping candidates win decisively; otherwise fall back to nearest by gap.
      const score = aheadDist + offAxisGap * 3 + (overlap > 0 ? 0 : 1000);
      return { element, score, overlap };
    })
    .filter(Boolean)
    .sort((x, y) => x.score - y.score);

  // No-wrap: if nothing lies ahead in this direction, stay put at the edge.
  if (candidates.length) {
    focusElement(candidates[0].element);
  }
}

function isEditableTarget(node) {
  const el = node instanceof HTMLElement ? node : null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

// --- W4: key-repeat acceleration ---------------------------------------------
// Holding a D-pad arrow (or ChannelUp/Down) keeps moving focus/scrolling with
// mild acceleration: first repeat after ~350ms, then every ~120ms, dropping to
// ~80ms after 8 repeats. Native auto-repeat keydowns (event.repeat, or repeated
// same-key keydowns without an intervening keyup) are gated to that cadence; a
// fallback timer covers TVs that deliver only a single keydown while held. The
// timer is armed only once we've ever seen a keyup from this device — without
// keyups we could never tell "released" from "held" and a single tap would
// scroll forever.
const KEY_REPEAT_FIRST_MS = 350;
const KEY_REPEAT_MS = 120;
const KEY_REPEAT_FAST_MS = 80;
const KEY_REPEAT_FAST_AFTER = 8;
const REPEATABLE_KEYS = new Set([
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ChannelUp", "ChannelDown",
]);

const keyRepeat = {
  key: "",
  count: 0, // repeats performed since the initial press
  nextAt: 0, // earliest timestamp the next repeat may fire
  timer: 0, // fallback timer handle
  sawNativeRepeat: false,
};
let _keyupEverSeen = false;
let _repeatScrollInstant = false; // keepElementVisible/pageScroll: behavior:auto during repeats

// Long-press OK: holding Enter on a track row/tile opens its context menu; a
// quick tap still clicks (plays). Right-arrow is pure spatial navigation again —
// the old Right-opens-menu binding made track lists impossible to cross. The
// hold is only armed once a keyup has been observed (same rule as key-repeat):
// on a keydown-only device the timer would fire on every tap, so those fall
// back to instant click.
const ENTER_HOLD_MS = 650;
const enterHold = {
  el: null,
  timer: 0,
  fired: false, // menu opened — swallow the matching keyup
};

function clearEnterHold() {
  if (enterHold.timer) window.clearTimeout(enterHold.timer);
  if (enterHold.el) enterHold.el.classList.remove("is-holding");
  enterHold.el = null;
  enterHold.timer = 0;
  enterHold.fired = false;
}

// Mirrors openTrackMenuFromFocus's two resolution paths: collection rows inside
// the collection list, and any tile carrying data-track-uri (shelves, artist
// rows, search results).
function trackMenuCapable(el) {
  if (!(el instanceof HTMLElement)) return false;
  const row = el.closest(".collection-track");
  if (row && elements.collectionTracks?.contains(row)) return true;
  const tile = el.closest("[data-track-uri]");
  return Boolean(tile && tile.dataset.trackUri);
}

function beginEnterHold(el) {
  clearEnterHold();
  enterHold.el = el;
  el.classList.add("is-holding");
  enterHold.timer = window.setTimeout(() => {
    enterHold.timer = 0;
    enterHold.fired = true;
    el.classList.remove("is-holding");
    openTrackMenuFromFocus();
  }, ENTER_HOLD_MS);
}

function keyRepeatInterval(count) {
  if (count <= 0) return KEY_REPEAT_FIRST_MS;
  return count >= KEY_REPEAT_FAST_AFTER ? KEY_REPEAT_FAST_MS : KEY_REPEAT_MS;
}

function clearKeyRepeat() {
  if (keyRepeat.timer) {
    window.clearTimeout(keyRepeat.timer);
    keyRepeat.timer = 0;
  }
  keyRepeat.key = "";
  keyRepeat.count = 0;
  keyRepeat.nextAt = 0;
  keyRepeat.sawNativeRepeat = false;
}

function performKeyStep(normalized, isRepeat) {
  _repeatScrollInstant = isRepeat;
  try {
    dispatchDirectionalKey(normalized);
  } finally {
    _repeatScrollInstant = false;
  }
}

function scheduleKeyRepeatFallback() {
  if (!_keyupEverSeen) return; // see header comment — no keyups means no timer
  if (keyRepeat.timer) window.clearTimeout(keyRepeat.timer);
  const delay = Math.max(0, keyRepeat.nextAt - Date.now());
  keyRepeat.timer = window.setTimeout(() => {
    keyRepeat.timer = 0;
    if (!keyRepeat.key || keyRepeat.sawNativeRepeat) return; // native repeats took over
    keyRepeat.count += 1;
    keyRepeat.nextAt = Date.now() + keyRepeatInterval(keyRepeat.count);
    performKeyStep(keyRepeat.key, true);
    scheduleKeyRepeatFallback();
  }, delay);
}

function handleRepeatableKey(normalized, event) {
  const heldSameKey = keyRepeat.key === normalized;
  // event.repeat is authoritative where supported; otherwise a same-key keydown
  // with no intervening keyup counts as a repeat (only trustworthy on devices
  // that do deliver keyups).
  const isRepeat = Boolean(event.repeat) || (heldSameKey && _keyupEverSeen);
  if (!isRepeat) {
    clearKeyRepeat();
    keyRepeat.key = normalized;
    keyRepeat.nextAt = Date.now() + keyRepeatInterval(0);
    performKeyStep(normalized, false);
    scheduleKeyRepeatFallback();
    return;
  }
  keyRepeat.sawNativeRepeat = true;
  if (keyRepeat.timer) {
    window.clearTimeout(keyRepeat.timer);
    keyRepeat.timer = 0;
  }
  if (!heldSameKey) {
    // Rolled onto a different key while another was held — restart on it.
    keyRepeat.key = normalized;
    keyRepeat.count = 0;
    keyRepeat.nextAt = 0;
  }
  if (Date.now() < keyRepeat.nextAt) return; // throttle native repeats to our cadence
  keyRepeat.count += 1;
  keyRepeat.nextAt = Date.now() + keyRepeatInterval(keyRepeat.count);
  performKeyStep(normalized, true);
}

// The actual per-press work for the repeatable keys, shared by the initial
// press, native repeats, and the fallback timer.
function dispatchDirectionalKey(normalized) {
  switch (normalized) {
    case "ArrowRight":
      // Pure navigation — the track context menu opens via long-press OK instead.
      if (handleAmbientModeArrow("right")) return;
      if (!moveRailFocus("right")) moveFocusDirectional("right");
      return;
    case "ArrowDown":
      // When the queue drawer is open, let normal focus navigation flow through
      // the focusable rows — focusElement → keepElementVisible scrolls them
      // into view automatically, so we no longer need a dedicated scroll path.
      if (isDiagnosticsOpen()) {
        scrollDiagnostics("down");
        return;
      }
      moveFocusDirectional("down");
      return;
    case "ArrowLeft":
      if (handleAmbientModeArrow("left")) return;
      if (!moveRailFocus("left")) moveFocusDirectional("left");
      return;
    case "ArrowUp":
      if (isDiagnosticsOpen()) {
        scrollDiagnostics("up");
        return;
      }
      moveFocusDirectional("up");
      return;
    case "ChannelUp":
      pageScroll(-1);
      return;
    case "ChannelDown":
      pageScroll(1);
      return;
  }
}

function handleRemoteEvent(event) {
  const normalized = normalizeRemoteKey(event);
  logRemoteEvent(event, normalized);
  if (event.type === "keyup") {
    _keyupEverSeen = true;
    if (keyRepeat.key && normalized === keyRepeat.key) clearKeyRepeat();
    if (normalized === "Enter" && enterHold.el) {
      const el = enterHold.el;
      const fired = enterHold.fired;
      clearEnterHold();
      // Released before the hold threshold → it was a tap: click (play).
      if (!fired && document.activeElement === el) el.click();
    }
    return;
  }
  if (event.type !== "keydown") return;

  // When a text field is focused, let the browser handle keys natively. Otherwise
  // the numpad-digit→D-pad aliases (2/4/5/6/8) would hijack numeric typing and the
  // arrows would navigate focus instead of moving the caret.
  if (isEditableTarget(event.target) || isEditableTarget(document.activeElement)) {
    return;
  }

  if (REPEATABLE_KEYS.has(normalized)) {
    event.preventDefault();
    handleRepeatableKey(normalized, event);
    return;
  }

  switch (normalized) {
    case "Enter":
    case "Space": {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !active.matches("button")) break;
      event.preventDefault();
      // Auto-repeat never clicks: holding OK must not machine-gun the focused
      // button (and once the hold menu opens, repeats would land on its first
      // action). A hold in progress also swallows further keydowns until keyup.
      if (event.repeat || enterHold.timer || enterHold.fired) return;
      // Long-press OK on a track opens its context menu; the click happens on
      // keyup instead so a tap still plays. Needs keyups (see enterHold note).
      if (normalized === "Enter" && _keyupEverSeen && trackMenuCapable(active)) {
        beginEnterHold(active);
        return;
      }
      active.click();
      break;
    }
    case "Back":
      event.preventDefault();
      handleBack();
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
    // Numpad alias for D-pad (phone keypad layout: 2 top → 8 bottom). Lets the
    // user keep navigating when the regular arrows get stuck — particularly
    // useful for scrolling the diagnostics log on the TV. Top-row digits.
    50: "ArrowUp",      // 2
    52: "ArrowLeft",    // 4
    53: "Enter",        // 5
    54: "ArrowRight",   // 6
    56: "ArrowDown",    // 8
    // Numpad codes (some firmwares emit these for the actual keypad keys).
    98: "ArrowUp",      // Numpad2
    100: "ArrowLeft",   // Numpad4
    101: "Enter",       // Numpad5
    102: "ArrowRight",  // Numpad6
    104: "ArrowDown",   // Numpad8
  };
  if (codeMap[keyCode]) return codeMap[keyCode];
  if (event.key === " ") return "Space";
  if (event.key === "Escape" || event.key === "BrowserBack" || event.key === "Backspace") return "Back";
  return event.key || event.code || `keyCode:${keyCode}`;
}

function pageScroll(direction) {
  const distance = Math.round(window.innerHeight * 0.78) * direction;
  window.scrollBy({ top: distance, behavior: _repeatScrollInstant ? "auto" : "smooth" });
  // Held-key repeats would spam the log (and its server beacon) — log taps only.
  if (!_repeatScrollInstant) {
    log(`Channel scroll ${direction > 0 ? "down" : "up"} by ${Math.abs(distance)}px.`);
  }
}

function handleBack() {
  // Exit dialog is modal: Back dismisses it (cancel) rather than navigating.
  if (isExitDialogOpen()) {
    cancelExit();
    return;
  }
  // Modal overlays close on Back before any view navigation.
  if (isTrackMenuOpen()) {
    closeTrackMenu();
    return;
  }
  if (isQueueDrawerOpen()) {
    closeQueueDrawer();
    return;
  }
  // Debug overlay traps up/down for scrolling — Back closes it so the remote
  // isn't stuck unable to navigate the rest of the screen.
  if (isDiagnosticsOpen()) {
    toggleDebugView();
    return;
  }
  if (state.currentView === "collection") {
    collectionBack();
    log("Back: returned to collection source.");
    return;
  }
  if (state.currentView === "artist") {
    artistBack();
    log("Back: returned from artist page.");
    return;
  }
  if (state.currentView === "now" || state.currentView === "ambient") {
    const target = state.previousView && state.previousView !== state.currentView ? state.previousView : "home";
    setView(target);
    log(`Back: returned to ${target}.`);
    return;
  }
  // Top-level views (home/library/settings): Back first hops focus to the nav
  // rail (the TV convention — nav is one Back away from any scroll depth).
  // Only once focus is already on the rail does Back escalate: Home shows the
  // exit dialog, other views return Home.
  if (focusNavRail()) {
    log("Back: focused the navigation rail.");
    return;
  }
  // At the Home root, Back asks whether to close the app instead of being a no-op.
  if (state.currentView === "home") {
    openExitDialog();
    return;
  }
  setView("home");
  log("Back key observed. Returned to Home.");
}

// Moves focus to the nav rail's active item. Returns false when focus is
// already inside the rail (so Back can escalate) or the rail is unavailable.
function focusNavRail() {
  const rail = elements.navRail || document.querySelector(".nav-rail");
  if (!rail || !isVisibleElement(rail.querySelector(".nav-item"))) return false;
  if (rail.contains(document.activeElement)) return false;
  const target = rail.querySelector(".nav-item.is-active") || rail.querySelector(".focusable:not([disabled])");
  if (!target) return false;
  focusElement(target);
  return true;
}

function isExitDialogOpen() {
  return Boolean(elements.exitDialog) && !elements.exitDialog.hidden;
}

let exitDialogReturnFocus = null;

function openExitDialog() {
  const dialog = elements.exitDialog;
  if (!dialog || isExitDialogOpen()) return;
  exitDialogReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  dialog.hidden = false;
  // Default to Cancel so an accidental extra Enter doesn't close the app.
  if (elements.exitDialogCancel) focusElement(elements.exitDialogCancel);
  log("Exit dialog opened.");
}

function closeExitDialog() {
  const dialog = elements.exitDialog;
  if (!dialog || dialog.hidden) return;
  dialog.hidden = true;
  if (exitDialogReturnFocus && document.contains(exitDialogReturnFocus)) {
    focusElement(exitDialogReturnFocus);
  } else {
    const focusables = activeFocusables();
    if (focusables.length) focusElement(focusables[0]);
  }
  exitDialogReturnFocus = null;
}

function cancelExit() {
  closeExitDialog();
  log("Exit cancelled.");
}

function confirmExit() {
  log("Exit confirmed — attempting to close the app.");
  closeExitDialog();
  // Best-effort exit. On the VIDAA app container window.close() returns the user to
  // the launcher; some firmware exposes a Hisense exit hook. Desktop browsers ignore
  // window.close() for non-script-opened windows — that's fine, the dialog is already
  // gone. Each call is wrapped because some TV builds throw on unsupported APIs.
  try {
    if (typeof window.Hisense_exitApp === "function") window.Hisense_exitApp();
  } catch {}
  try { window.close(); } catch {}
}

// #14: list re-renders replaceChildren() their container; if the focused row is
// inside, focus drops to <body> and the D-pad goes dead until a blind keypress.
// Capture the focused row's index before the wipe and, if focus didn't survive,
// restore the same index (clamped) or the container's first focusable.
function captureListFocusIndex(container) {
  const active = document.activeElement;
  if (!container || !(active instanceof HTMLElement) || !container.contains(active)) return -1;
  const rows = container.querySelectorAll(".focusable");
  return Math.max(0, Array.prototype.indexOf.call(rows, active.closest(".focusable")));
}

function restoreListFocusIndex(container, index) {
  if (!container || index < 0) return;
  const active = document.activeElement;
  // Focus survived (e.g. it was on a sibling control that wasn't re-rendered).
  if (active && active !== document.body && active !== document.documentElement) return;
  const rows = container.querySelectorAll(".focusable");
  const target = rows.length ? rows[Math.min(index, rows.length - 1)] : null;
  if (target instanceof HTMLElement) focusElement(target);
}

export {
  _repeatScrollInstant,
  activeFocusables,
  cancelExit,
  captureListFocusIndex,
  clearEnterHold,
  clearKeyRepeat,
  confirmExit,
  focusElement,
  focusFirst,
  handleRemoteEvent,
  invalidateFocusables,
  restoreListFocusIndex,
  wireFocusWithinClass,
};
