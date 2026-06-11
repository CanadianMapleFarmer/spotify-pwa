// App-wide constants: Spotify client id/scopes, storage keys, ambient/scene mode tables.

const SPOTIFY_CLIENT_ID = "f090eff2edba4b17a1b0743e4080e755";

const SPOTIFY_SCOPES = [
  "streaming",
  "user-read-email",
  "user-read-private",
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "playlist-read-private",
  "playlist-modify-public",
  "playlist-modify-private",
  "user-library-read",
  "user-library-modify",
  "user-top-read",
  "user-read-recently-played",
];

const storageKeys = {
  clientId: "spotify-probe-client-id",
  verifier: "spotify-probe-code-verifier",
  accessToken: "spotify-probe-access-token",
  refreshToken: "spotify-probe-refresh-token",
  expiresAt: "spotify-probe-expires-at",
  pairCode: "spotify-probe-pair-code",
  pairLoginUrl: "spotify-probe-pair-login-url",
  debugVisible: "spotify-pwa.debug-visible",
  ambientMode: "spotify-pwa.ambient-mode",
  sceneCategory: "spotify-pwa.scene-category",
  autoplaySimilar: "spotify-pwa.autoplay-similar",
};

const PHONE_MODE_SESSION_KEY = "spotify-pwa.phone-mode";
const PAIR_SESSION_COLLECTION = "pairSessions";
const PAIR_SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes — long enough for a phone OAuth round trip

const AMBIENT_MODES = ["room", "screensaver", "visualizer"];
const AMBIENT_MODE_LABELS = {
  room: "Room Display",
  screensaver: "Scene",
  visualizer: "Visualizer",
};
// === Procedural Scene =========================================================
// Scene is rendered entirely client-side: layered silhouette SVGs with very slow
// CSS parallax drift + one 30fps-capped canvas for particles (stars, clouds, car
// streaks). No <video> ever plays — the TV firmware pauses Spotify whenever a
// video with an audio track engages the decoder, and even silent clips proved
// unreliable, so the whole video/Pexels/Firestore clip pipeline was removed.
const SCENE_CATEGORIES = ["nature", "skyline"];
const SCENE_CATEGORY_LABELS = { nature: "Nature", skyline: "City" };
// Time-of-day flavors tint the sky/glow. Entry picks by the local clock; Skip
// re-rolls everything (seed, flavor, palette mix) for a fresh variation.
const SCENE_FLAVORS = ["dawn", "evening", "night"];

export {
  AMBIENT_MODES,
  AMBIENT_MODE_LABELS,
  PAIR_SESSION_COLLECTION,
  PAIR_SESSION_TTL_MS,
  PHONE_MODE_SESSION_KEY,
  SCENE_CATEGORIES,
  SCENE_CATEGORY_LABELS,
  SCENE_FLAVORS,
  SPOTIFY_CLIENT_ID,
  SPOTIFY_SCOPES,
  storageKeys,
};
