// The single shared mutable state object. Every module imports { state } and mutates it directly,
// exactly as the old monolith did — the object identity is the contract.

const state = {
  focusIndex: 0,
  spotifyPlayer: null,
  spotifyPlayerPromise: null,
  spotifyDeviceId: "",
  spotifyElementActivated: false,
  spotifyVolume: 0.7,
  pairPollTimer: 0,
  currentView: "home",
  previousView: "home",
  ambientMode: "room",
  nowPlaying: null,
  shuffle: false,
  repeat: "off",
  sceneCategory: "nature",
  sceneSeed: 0, // PRNG seed for the procedural scene; Skip re-rolls it
  sceneFlavor: "", // "dawn" | "evening" | "night" — clock-picked on entry, re-rolled on Skip
  sceneBuiltKey: "", // `${category}:${seed}` of the scene currently in the DOM
  sceneRaf: 0, // rAF handle for the scene particle canvas (30fps capped)
  sceneRect: null, // cached canvas CSS-pixel size — measured outside the draw loop
  sceneResizeHandler: null,
  sceneParticles: null, // seeded stars/clouds/car streaks consumed by the draw loop
  sceneTintables: null, // node refs the palette re-tint touches without rebuilding geometry
  // The Web Playback SDK only emits player_state_changed for the TV's own device.
  // When playback is on the phone (or any other device) we'd never hear about
  // track changes — so we poll /v1/me/player here as the truth source. Cadence
  // adapts to the current view (fast on Now/Ambient where staleness is visible).
  playbackPollTimer: 0,
  playbackPollInFlight: false,
  playbackPollBackoffUntil: 0,
  progressTimer: 0,
  remoteEvents: [],
  debugVisible: false,
  paletteCache: { url: "", palette: null },
  pillDimTimer: 0,
  visualizerRaf: 0,
  visualizerPhase: 0,
  visualizerRect: null,
  visualizerResizeHandler: null,
  collection: null,
  collectionShuffle: false,
  collectionReturnView: "home",
  artist: null, // artist-page state (id, name, image, topTracks, albums)
  artistReturnView: "home",
  dataLoaded: false,
  dataLoading: false,
  queueItems: [], // last-fetched upcoming queue (from /me/player/queue)
  queueReturnFocus: null,
  // The queue API can't tell us *why* an item is queued, so we remember the URIs
  // we POSTed ourselves this session. Anything else in GET /me/player/queue is
  // context continuation (album/playlist Spotify keeps playing by itself).
  sessionQueuedUris: new Set(), // every uri we queued (menu + radio)
  radioQueuedUris: new Set(), // subset queued by radio auto-fill
  radioSeedArtist: "", // artist name the last radio batch was seeded from
  radioSeededTrackId: "", // latch: radio fires at most once per playing track
  radioToastShown: false, // first-fire toast, once per session
  autoplaySimilar: true, // "Autoplay similar music" Settings toggle (persisted)
  recentlyPlayedCache: null, // { ids:Set, fetchedAt } — radio dedupe source
  contextNameCache: {}, // context uri → resolved album/playlist name
  trackMenuTrack: null, // track object the context menu is acting on
  trackMenuReturnFocus: null,
  userPlaylists: null, // cached editable playlists for the add-to-playlist picker
  upNextTrackId: "", // nowPlaying id the up-next card was last shown for (once per song)
  knownDevices: [], // last /me/player/devices payload — resolves transfer-toast names
  spotifyDeviceOffline: false, // SDK fired not_ready — status strip shows "offline"
};

export { state };
