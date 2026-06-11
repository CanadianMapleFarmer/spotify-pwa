# Spotify VIDAA TV

Static Spotify TV PWA for VIDAA OS browser tiles installed with [`weinzii/vidaa-edge`](https://github.com/weinzii/vidaa-edge).

## Current Features

- Paired Spotify login so the TV does not leave the app for OAuth.
- QR code and phone login URL for pairing.
- Spotify Web Playback SDK player creation and Spotify Connect transfer.
- Home shelves: recently played, top tracks, saved albums, saved songs.
- Library shelves: playlists, saved albums, and saved tracks.
- Now Playing screen with artwork, progress, play/pause, previous, next, transfer, and refresh.
- Device picker for Spotify Connect devices.
- Ambient artwork/skyline room display with playback controls.
- Settings view for pairing, sign-out, and explicit TV player creation.
- Automatic Spotify Web Playback player creation after login/token restore.
- VIDAA remote support for arrows, Enter, Back, channel up/down page scrolling, volume, and common media keys.
- Toast messages for success/error feedback on the TV.

## Code Layout

The app is dependency-free static web code shipped as native ES modules — no
build step, no bundler, no import maps (the VIDAA Chromium build predates
them), only relative static imports. `index.html` loads `/js/main.js` as
`<script type="module">` and the browser resolves the rest of the graph:

```text
js/
  main.js            entry: data-action registry, boot wiring, init()
  config.js          constants: client id/scopes, storage keys, mode tables
  state.js           the single shared mutable state object
  dom.js             the elements registry + tiny DOM render helpers
  utils.js           formatters, image pickers, escaping, PRNG
  diagnostics.js     log/logError, toasts, debug panel, device checks
  auth.js            PKCE OAuth, token refresh, pair-login, sign out
  api.js             Spotify API fetch helpers + error humanizer
  player.js          Web Playback SDK device, transport, polling, NP sync
  focus.js           spatial-focus engine, remote keys, Back/exit dialog
  shell.js           setView router + shell status chrome
  cards.js           shared shelf/card renderers
  queue.js           queue drawer, up-next card, radio auto-fill
  track-menu.js      track context menu + playlist picker
  views/             home, search, library, collection, artist, now, settings
  ambient/           index (modes), room, palette, scene (procedural), visualizer
```

The shared mutable `state` (from `state.js`) and `elements` (from `dom.js`)
objects are imported and mutated directly by every module, exactly like the
old single-file app did. Feature modules form a few static import cycles
(e.g. `focus.js` dispatches Back into views that import focus helpers); this
is safe because the cyclic references are all hoisted function declarations
resolved at call time — see the note at the top of `js/focus.js`.

When changing any `js/` file, bump the `?v=` query on `/js/main.js` in
`index.html` and the `CACHE_NAME`/precache list in `service-worker.js`.

## Local Run

```sh
node server.mjs
```

Open:

```text
http://localhost:5173
```

The custom server also prints browser-side logs posted to `/__probe-log`, which is useful when testing from the TV.

For Spotify testing through Cloudflare Tunnel, add the active tunnel URL to the Spotify Developer Dashboard redirect URIs, for example:

```text
https://decide-space-enables-interaction.trycloudflare.com/
```

## Spotify Setup

1. Create an app in the Spotify Developer Dashboard.
2. Add the active Cloudflare/or production HTTPS URL as a redirect URI.
3. Select **Create Pair Login** on the TV.
4. Scan the QR code on your phone.
5. Select **Login Here** on the phone page.
6. Return to the TV and select **Create Player**, then **Transfer Here**.

Required scopes are requested by the app:

```text
streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private user-library-read user-top-read user-read-recently-played
```

Spotify browser playback requires a Premium account and a browser runtime capable of the Web Playback SDK.

## Cloudflare Tunnel Testing

Run the local app server:

```sh
node server.mjs
```

In a second terminal:

```sh
cloudflared tunnel --url http://localhost:5173
```

Open the HTTPS forwarding URL on the TV. Add that exact URL with a trailing slash as a Spotify redirect URI, for example:

```text
https://example.trycloudflare.com/
```

The app uses the current page origin/path as the Spotify redirect URI.

## VIDAA Edge Tile Values

Use `vidaa-edge` with:

```text
App ID: spotify-tv
App Name: Spotify TV
App URL: https://<your-host>/
Icon URL: https://<your-host>/public/icons/spotify-logo.png
```

Restart the TV after installation if VIDAA does not show the tile immediately.

## Scene (procedural ambient scenery)

VIDAA pauses Spotify whenever a `<video>` decoder engages, so Scene never plays
video. Instead the client renders a Roku-City-style layered illustration
entirely on-device: a palette-tinted gradient sky, seeded silhouette layers
(nature mountains/treeline or a city skyline with lit windows) drifting in slow
parallax, and a 30fps-capped particle canvas for stars, clouds and car-light
streaks. The album palette and the local clock (dawn/evening/night) tint each
scene; the **Skip** button re-seeds a fresh variation, and the **Nature/City**
buttons switch categories. No backend, no network, no setup required.

The old video/image-sequence backend (`functions/`, Pexels key, `sceneClips`
Firestore collection, Storage clips) is decommissioned — the client no longer
reads any of it. Firestore itself is still required for phone pair-login
(`pairSessions`).

## Interpreting Results

- If remote keys are not logged, we need VIDAA-specific key code handling before building the real app.
- If basic audio cannot play after pressing OK/Enter, autoplay/media policy may block browser playback.
- If the Spotify SDK never becomes ready, VIDAA likely cannot be a native Spotify playback device.
- If the Spotify SDK is ready and creates a device ID, the full Spotify TV PWA is viable.
