# CLAUDE.md

This repo is currently a VIDAA OS Spotify TV PWA.

- Start with `README.md` for local run and TV install instructions.
- The app is dependency-free static web code under the repository root and `public/`.
- Spotify Web Playback SDK viability has been confirmed on the target TV through a Cloudflare Tunnel and VIDAA app tile.
- Preserve TV remote diagnostics, spatial focus behavior, and toast error reporting when extending the app.
- The Spotify client ID is intentionally hardcoded for this personal TV app; do not reintroduce a visible client ID input.
- Pairing/auth controls live in the Settings view; do not move them back into the global shell.
- Spotify Web Playback player creation should remain resilient and idempotent: auto-create after login/token restore, and retry creation before transfer/playback actions if the device ID is missing.
- Ambient is a real room-display view with visible artwork/skyline modes and playback controls; keep it useful, not just a Now Playing shortcut.
- Known VIDAA key mappings from testing: arrows 37/38/39/40, Enter 13, Back 8/27/166/461, channel up/down 427/428, volume 447/448/449, media keys 19/179/412/413/415/417.
