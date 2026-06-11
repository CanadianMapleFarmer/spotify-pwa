// Spotify Web API fetch helpers, error reader/humanizer and device-id query param.

import { ensureAccessToken } from "./auth.js";
import { log } from "./diagnostics.js";
import { state } from "./state.js";

function withDeviceIdParam(path) {
  if (!state.spotifyDeviceId) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}device_id=${encodeURIComponent(state.spotifyDeviceId)}`;
}

// #6: map the statuses users actually hit to actionable 10-foot copy. The raw
// Spotify body goes to the diagnostics log only — toasts stay human.
const SPOTIFY_ERROR_COPY = {
  401: "Session expired — re-pair from Settings",
  403: "Spotify Premium or permissions issue — try re-pairing from Settings",
  404: "No active device — create the TV player in Settings",
  429: "Spotify is rate-limiting; retrying shortly",
};

async function readSpotifyError(response) {
  let raw = "";
  try {
    const text = await response.text();
    if (text) {
      try {
        const parsed = JSON.parse(text);
        raw = parsed?.error?.message || parsed?.error?.reason || text.slice(0, 200);
      } catch {
        raw = text.slice(0, 200);
      }
    }
  } catch {
    raw = "unreadable body";
  }
  const friendly = SPOTIFY_ERROR_COPY[response.status];
  if (friendly) {
    if (raw) log(`Spotify ${response.status} detail: ${raw}`, "warn");
    return friendly;
  }
  return raw || "no body";
}

async function spotifyApiJson(path, init = {}) {
  const response = await spotifyApiFetch(path, init);
  if (!response.ok) {
    throw new Error(`Spotify API failed ${response.status} for ${path}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function spotifyApiFetch(path, init) {
  const token = await ensureAccessToken();
  return fetch(`https://api.spotify.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
}

export { readSpotifyError, spotifyApiFetch, spotifyApiJson, withDeviceIdParam };
