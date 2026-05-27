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

## Interpreting Results

- If remote keys are not logged, we need VIDAA-specific key code handling before building the real app.
- If basic audio cannot play after pressing OK/Enter, autoplay/media policy may block browser playback.
- If the Spotify SDK never becomes ready, VIDAA likely cannot be a native Spotify playback device.
- If the Spotify SDK is ready and creates a device ID, the full Spotify TV PWA is viable.
