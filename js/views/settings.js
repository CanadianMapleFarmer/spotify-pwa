// Settings view: device picker, Spotify facts, pair info, autoplay toggle.

import { spotifyApiJson } from "../api.js";
import { getPairCode, getStoredAccessToken, requireAccessToken } from "../auth.js";
import { storageKeys } from "../config.js";
import { log, logError } from "../diagnostics.js";
import { elements, emptyState, renderFacts } from "../dom.js";
import { invalidateFocusables } from "../focus.js";
import { transferToDevice } from "../player.js";
import { renderShellState } from "../shell.js";
import { state } from "../state.js";
import { escapeHtml } from "../utils.js";

async function loadDevices() {
  requireAccessToken();
  const data = await spotifyApiJson("/v1/me/player/devices");
  state.knownDevices = data.devices || []; // transfer toasts resolve names from here
  elements.devicesGrid.replaceChildren();
  for (const device of data.devices || []) {
    const button = document.createElement("button");
    button.className = "focusable device-card";
    button.dataset.deviceId = device.id || "";
    button.innerHTML = `<strong>${escapeHtml(device.name)}</strong><span>${escapeHtml(device.type)}${device.is_active ? " - active" : ""}</span>`;
    button.addEventListener("click", () => {
      transferToDevice(device.id).catch((error) => logError("Device transfer failed", error));
    });
    elements.devicesGrid.append(button);
  }
  if (!elements.devicesGrid.children.length) {
    elements.devicesGrid.append(emptyState("No Spotify Connect devices found."));
  }
  invalidateFocusables();
}

function renderSpotifyFacts() {
  const expiresAt = Number(localStorage.getItem(storageKeys.expiresAt) || 0);
  const facts = {
    "Client ID": "built in",
    "Access token": getStoredAccessToken() ? "present" : "missing",
    "Refresh token": localStorage.getItem(storageKeys.refreshToken) ? "present" : "missing",
    "Token expires": expiresAt ? new Date(expiresAt).toLocaleString() : "n/a",
    "SDK": window.Spotify?.Player ? "loaded" : "not loaded",
    "Player": state.spotifyPlayer ? "created" : "not created",
    "Device ID": state.spotifyDeviceId || "not ready",
    "Volume": Math.round(state.spotifyVolume * 100) + "%",
    "Pair code": getPairCode() || "not created",
    "Pair login URL": localStorage.getItem(storageKeys.pairLoginUrl) || "not created",
  };
  renderFacts(elements.spotifyFacts, facts);
  renderPairInfo();
  renderShellState();
}

function renderPairInfo() {
  const pairCode = getPairCode();
  const pairUrl = localStorage.getItem(storageKeys.pairLoginUrl) || "";
  const hide = !pairCode || !pairUrl;
  if (elements.pairCard.hidden !== hide) invalidateFocusables();
  elements.pairCard.hidden = hide;
  if (!pairCode || !pairUrl) return;
  elements.pairCode.textContent = pairCode;
  elements.pairUrl.textContent = pairUrl;
  elements.pairQr.hidden = false;
  elements.pairQr.src = `https://api.qrserver.com/v1/create-qr-code/?size=420x420&margin=10&data=${encodeURIComponent(pairUrl)}`;
}

function toggleAutoplaySimilar() {
  state.autoplaySimilar = !state.autoplaySimilar;
  try {
    localStorage.setItem(storageKeys.autoplaySimilar, state.autoplaySimilar ? "1" : "0");
  } catch {}
  applyAutoplaySimilarState();
  log(`Autoplay similar music ${state.autoplaySimilar ? "enabled" : "disabled"}.`);
}

function applyAutoplaySimilarState() {
  const btn = document.getElementById("toggleAutoplay");
  const label = document.getElementById("toggleAutoplayState");
  if (btn) btn.setAttribute("aria-checked", state.autoplaySimilar ? "true" : "false");
  if (label) label.textContent = state.autoplaySimilar ? "On" : "Off";
}

export { applyAutoplaySimilarState, loadDevices, renderPairInfo, renderSpotifyFacts, toggleAutoplaySimilar };
