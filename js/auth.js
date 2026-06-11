// PKCE OAuth, token refresh, phone pair-login (Firestore pairSessions) and sign out.

import {
  PAIR_SESSION_COLLECTION,
  PAIR_SESSION_TTL_MS,
  PHONE_MODE_SESSION_KEY,
  SPOTIFY_CLIENT_ID,
  SPOTIFY_SCOPES,
  storageKeys,
} from "./config.js";
import { log, logError } from "./diagnostics.js";
import { elements } from "./dom.js";
import { scheduleSpotifyPlayerCreation, stopPlaybackPolling } from "./player.js";
import { state } from "./state.js";
import { refreshAll } from "./views/home.js";
import { renderPairInfo, renderSpotifyFacts } from "./views/settings.js";

function saveClientId() {
  localStorage.setItem(storageKeys.clientId, SPOTIFY_CLIENT_ID);
  log("Spotify Client ID is built into this TV app.", "success");
  renderSpotifyFacts();
}

async function loginSpotify() {
  const clientId = getClientId();
  const pairCode = getPairCode();
  const verifier = generateCodeVerifier();
  const challenge = await createCodeChallenge(verifier);
  localStorage.setItem(storageKeys.verifier, verifier);

  const authUrl = new URL("https://accounts.spotify.com/authorize");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", spotifyRedirectUri());
  authUrl.searchParams.set("scope", SPOTIFY_SCOPES.join(" "));
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("code_challenge", challenge);
  if (pairCode) {
    authUrl.searchParams.set("state", pairCode);
  }
  log("Redirecting to Spotify Accounts.");
  location.assign(authUrl.toString());
}

function createPairLogin() {
  const clientId = getClientId();
  const pairCode = generatePairCode();
  const loginUrl = new URL(location.origin + location.pathname);
  loginUrl.searchParams.set("pair", pairCode);
  loginUrl.searchParams.set("phone", "1");
  localStorage.setItem(storageKeys.pairCode, pairCode);
  localStorage.setItem(storageKeys.pairLoginUrl, loginUrl.toString());
  localStorage.setItem(storageKeys.clientId, clientId);
  log(`Pair login created. Code=${pairCode} URL=${loginUrl.toString()}`, "success");
  startPairPolling();
  renderPairInfo();
  renderSpotifyFacts();
}

async function checkPairToken() {
  const pairCode = getPairCode();
  if (!pairCode) throw new Error("Create a pair login first.");

  const db = await getFirestoreOrNull();
  if (!db) {
    // Firestore not available — stay quiet rather than crash polling.
    return false;
  }

  let snap;
  try {
    snap = await db.collection(PAIR_SESSION_COLLECTION).doc(pairCode).get();
  } catch (error) {
    if (error?.code === "permission-denied") {
      throw new Error("Pair session lookup denied. Check Firestore rules for pairSessions.");
    }
    throw error;
  }
  if (!snap.exists) {
    log(`Pair token not ready for ${pairCode}.`);
    return false;
  }
  const session = snap.data() || {};
  const expireAt = session.expireAt?.toDate ? session.expireAt.toDate() : null;
  if (expireAt && expireAt.getTime() < Date.now()) {
    log(`Pair session expired for ${pairCode}.`);
    await snap.ref.delete().catch(() => {});
    return false;
  }

  localStorage.setItem(storageKeys.accessToken, session.accessToken);
  if (session.refreshToken) localStorage.setItem(storageKeys.refreshToken, session.refreshToken);
  const tokenExpiresAtMs = session.expiresAt?.toDate
    ? session.expiresAt.toDate().getTime()
    : (typeof session.expiresAt === "number" ? session.expiresAt : Date.now() + 3600000);
  localStorage.setItem(storageKeys.expiresAt, String(tokenExpiresAtMs));

  // One-shot: consume and delete so the credentials don't linger.
  await snap.ref.delete().catch((error) => log(`Pair session cleanup failed: ${error.message}`));

  elements.connectionStatus.textContent = "Signed in via pair";
  log(`Pair token received for ${pairCode}.`, "success");
  stopPairPolling();
  renderSpotifyFacts();
  scheduleSpotifyPlayerCreation("pair login");
  await refreshAll();
  return true;
}

function startPairPolling() {
  stopPairPolling();
  state.pairPollTimer = window.setInterval(() => {
    checkPairToken().catch((error) => logError("Pair polling failed", error));
  }, 5000);
  log("Pair polling started.");
}

function stopPairPolling() {
  if (state.pairPollTimer) {
    window.clearInterval(state.pairPollTimer);
    state.pairPollTimer = 0;
  }
}

async function handleSpotifyRedirect() {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  const error = params.get("error");
  const pairCode = normalizePairCode(params.get("state") || localStorage.getItem(storageKeys.pairCode));
  log(`Spotify redirect check: code=${code ? "present" : "missing"} error=${error || "none"}`);
  if (error) {
    history.replaceState({}, "", location.pathname);
    throw new Error(`Spotify returned ${error}`);
  }
  if (!code) {
    renderSpotifyFacts();
    return;
  }

  const clientId = getClientId();
  const verifier = localStorage.getItem(storageKeys.verifier);
  if (!verifier) throw new Error("Missing PKCE verifier from localStorage.");

  const body = new URLSearchParams();
  body.set("client_id", clientId);
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("redirect_uri", spotifyRedirectUri());
  body.set("code_verifier", verifier);

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status}`);
  }

  const token = await response.json();
  const expiresAt = Date.now() + token.expires_in * 1000;
  localStorage.setItem(storageKeys.accessToken, token.access_token);
  if (token.refresh_token) localStorage.setItem(storageKeys.refreshToken, token.refresh_token);
  localStorage.setItem(storageKeys.expiresAt, String(expiresAt));

  const isPhonePair = document.body.classList.contains("is-phone-pair");
  let pairDeliveryError = null;
  if (pairCode) {
    try {
      await postPairToken(pairCode, token.access_token, token.refresh_token || "", expiresAt);
    } catch (deliveryError) {
      pairDeliveryError = deliveryError;
      logError("Pair token delivery failed", deliveryError);
    }
  }
  history.replaceState({}, "", location.pathname);
  if (elements.connectionStatus) elements.connectionStatus.textContent = "Signed in";
  log("Spotify token exchange completed.", "success");
  renderSpotifyFacts();

  if (isPhonePair) {
    if (pairDeliveryError) {
      renderPhonePairScreen("error", pairDeliveryError.message);
    } else if (pairCode) {
      renderPhonePairScreen("success");
    } else {
      renderPhonePairScreen("success", "You're signed in.");
    }
    return;
  }

  scheduleSpotifyPlayerCreation("redirect login");
  await refreshAll();
}

async function postPairToken(pairCode, accessToken, refreshToken, expiresAt) {
  const db = await getFirestoreOrNull();
  if (!db) {
    throw new Error("Pair backend not ready. Refresh the page and try again.");
  }
  const fbNs = window.firebase;
  const TimestampCtor = fbNs?.firestore?.Timestamp;
  const toTimestamp = (ms) => TimestampCtor ? TimestampCtor.fromDate(new Date(ms)) : new Date(ms);
  const expireAtMs = Date.now() + PAIR_SESSION_TTL_MS;

  try {
    await db.collection(PAIR_SESSION_COLLECTION).doc(pairCode).set({
      accessToken,
      refreshToken: refreshToken || "",
      expiresAt: toTimestamp(expiresAt),
      createdAt: toTimestamp(Date.now()),
      expireAt: toTimestamp(expireAtMs),
    });
  } catch (error) {
    if (error?.code === "permission-denied") {
      throw new Error("Pair session write denied. Firestore rules need to allow create on pairSessions.");
    }
    if (error?.code === "unavailable" || error?.message?.includes("offline")) {
      throw new Error("Pair backend not reachable (offline). Check your phone's connection and retry.");
    }
    throw new Error(`Pair token delivery failed: ${error?.message || error}`);
  }
  log(`Pair token posted for ${pairCode}.`, "success");
}

let firestoreReadyPromise = null;
function getFirestoreOrNull() {
  if (firestoreReadyPromise) return firestoreReadyPromise;
  firestoreReadyPromise = (async () => {
    const start = Date.now();
    while (!(window.firebase && typeof window.firebase.firestore === "function")) {
      if (Date.now() - start > 6000) return null;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    try {
      return window.firebase.firestore();
    } catch {
      return null;
    }
  })();
  return firestoreReadyPromise;
}

function resetSpotify() {
  if (state.spotifyPlayer) {
    state.spotifyPlayer.disconnect();
  }
  state.spotifyPlayer = null;
  state.spotifyPlayerPromise = null;
  state.spotifyDeviceId = "";
  stopPlaybackPolling();
  localStorage.removeItem(storageKeys.accessToken);
  localStorage.removeItem(storageKeys.refreshToken);
  localStorage.removeItem(storageKeys.expiresAt);
  localStorage.removeItem(storageKeys.verifier);
  localStorage.removeItem(storageKeys.pairCode);
  localStorage.removeItem(storageKeys.pairLoginUrl);
  stopPairPolling();
  elements.connectionStatus.textContent = "Not signed in";
  log("Spotify TV state reset.");
  renderSpotifyFacts();
}

function getClientId() {
  localStorage.setItem(storageKeys.clientId, SPOTIFY_CLIENT_ID);
  return SPOTIFY_CLIENT_ID;
}

function requireAccessToken() {
  if (!getStoredAccessToken() && !localStorage.getItem(storageKeys.refreshToken)) {
    throw new Error("Sign in with Spotify first.");
  }
}

function spotifyRedirectUri() {
  return location.origin + location.pathname;
}

function applyUrlState() {
  const params = new URLSearchParams(location.search);
  const pairCode = normalizePairCode(params.get("pair"));

  // Phone mode is sticky for the lifetime of the tab. The OAuth round-trip
  // drops the ?phone=1 querystring (redirect URI is just origin + path), so we
  // persist the flag in sessionStorage to survive that redirect.
  let isPhonePair = false;
  try {
    if (params.get("phone") === "1") {
      sessionStorage.setItem(PHONE_MODE_SESSION_KEY, "1");
    }
    isPhonePair = sessionStorage.getItem(PHONE_MODE_SESSION_KEY) === "1";
  } catch {
    isPhonePair = params.get("phone") === "1";
  }
  document.body.classList.toggle("is-phone-pair", isPhonePair);
  if (pairCode) {
    localStorage.setItem(storageKeys.pairCode, pairCode);
    log(`Pair login mode active. Code=${pairCode}`);
  }
}

function renderPhonePairScreen(stateName, message) {
  const screen = elements.phonePairScreen;
  if (!screen) return;
  if (stateName) screen.dataset.state = stateName;
  if (elements.phonePairCode) {
    const code = getPairCode();
    elements.phonePairCode.textContent = code ? code.padEnd(6, "•") : "------";
  }
  if (message) {
    if (stateName === "error" && elements.phonePairErrorMessage) {
      elements.phonePairErrorMessage.textContent = message;
    }
    if (stateName === "success" && elements.phonePairSuccessMessage) {
      elements.phonePairSuccessMessage.textContent = message;
    }
  }
}

function getPairCode() {
  return normalizePairCode(localStorage.getItem(storageKeys.pairCode));
}

function generatePairCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(6);
  if (crypto?.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

function normalizePairCode(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}

function getStoredAccessToken() {
  const token = localStorage.getItem(storageKeys.accessToken);
  const expiresAt = Number(localStorage.getItem(storageKeys.expiresAt) || 0);
  if (!token || Date.now() > expiresAt - 60000) return "";
  return token;
}

function getAccessToken() {
  const token = getStoredAccessToken();
  if (!token) throw new Error("Missing or expired Spotify access token. Log in again.");
  return token;
}

async function ensureAccessToken() {
  const storedToken = getStoredAccessToken();
  if (storedToken) return storedToken;

  const refreshToken = localStorage.getItem(storageKeys.refreshToken);
  if (!refreshToken) throw new Error("Missing or expired Spotify access token. Log in again.");

  const body = new URLSearchParams();
  body.set("client_id", getClientId());
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", refreshToken);

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    localStorage.removeItem(storageKeys.accessToken);
    localStorage.removeItem(storageKeys.expiresAt);
    throw new Error(`Spotify token refresh failed: ${response.status}`);
  }

  const token = await response.json();
  const expiresAt = Date.now() + token.expires_in * 1000;
  localStorage.setItem(storageKeys.accessToken, token.access_token);
  if (token.refresh_token) localStorage.setItem(storageKeys.refreshToken, token.refresh_token);
  localStorage.setItem(storageKeys.expiresAt, String(expiresAt));
  log("Spotify access token refreshed.", "success");
  renderSpotifyFacts();
  return token.access_token;
}

function generateCodeVerifier() {
  const bytes = new Uint8Array(64);
  if (crypto?.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    log("crypto.getRandomValues missing; used Math.random fallback for probe only.", "error");
  }
  return base64Url(bytes);
}

async function createCodeChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = crypto?.subtle?.digest
    ? await crypto.subtle.digest("SHA-256", data)
    : sha256(data);
  if (!crypto?.subtle?.digest) {
    log("crypto.subtle.digest missing; used JS SHA-256 fallback.", "error");
  }
  return base64Url(new Uint8Array(digest));
}

function sha256(bytes) {
  const rightRotate = (value, amount) => (value >>> amount) | (value << (32 - amount));
  const k = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
    0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
    0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
    0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
    0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
    0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
    0xc67178f2,
  ];
  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const message = Array.from(bytes);
  const bitLength = message.length * 8;
  message.push(0x80);
  while (message.length % 64 !== 56) message.push(0);
  for (let i = 7; i >= 0; i--) message.push((bitLength / Math.pow(256, i)) & 0xff);

  for (let i = 0; i < message.length; i += 64) {
    const w = new Array(64);
    for (let j = 0; j < 16; j++) {
      w[j] =
        (message[i + j * 4] << 24) |
        (message[i + j * 4 + 1] << 16) |
        (message[i + j * 4 + 2] << 8) |
        message[i + j * 4 + 3];
    }
    for (let j = 16; j < 64; j++) {
      const s0 = rightRotate(w[j - 15], 7) ^ rightRotate(w[j - 15], 18) ^ (w[j - 15] >>> 3);
      const s1 = rightRotate(w[j - 2], 17) ^ rightRotate(w[j - 2], 19) ^ (w[j - 2] >>> 10);
      w[j] = (w[j - 16] + s0 + w[j - 7] + s1) | 0;
    }

    let [a, b, c, d, e, f, g, hh] = h;
    for (let j = 0; j < 64; j++) {
      const s1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + s1 + ch + k[j] + w[j]) | 0;
      const s0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }

    h[0] = (h[0] + a) | 0;
    h[1] = (h[1] + b) | 0;
    h[2] = (h[2] + c) | 0;
    h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0;
    h[5] = (h[5] + f) | 0;
    h[6] = (h[6] + g) | 0;
    h[7] = (h[7] + hh) | 0;
  }

  const output = new Uint8Array(32);
  h.forEach((value, index) => {
    output[index * 4] = (value >>> 24) & 0xff;
    output[index * 4 + 1] = (value >>> 16) & 0xff;
    output[index * 4 + 2] = (value >>> 8) & 0xff;
    output[index * 4 + 3] = value & 0xff;
  });
  return output.buffer;
}

function base64Url(bytes) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export {
  applyUrlState,
  checkPairToken,
  createPairLogin,
  ensureAccessToken,
  getPairCode,
  getStoredAccessToken,
  handleSpotifyRedirect,
  loginSpotify,
  renderPhonePairScreen,
  requireAccessToken,
  resetSpotify,
  saveClientId,
  spotifyRedirectUri,
};
