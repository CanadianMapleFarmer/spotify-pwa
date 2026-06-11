# Improvement Plan — Spotify TV PWA

Derived from the June 2026 full audit (architecture/UX, ambient pipeline, queue/playback, TV-PWA research). Executed in four workstreams; W1+W2 run in parallel worktrees, W3 and W4 run sequentially after merge.

## Hard constraints (all workstreams)

- Vanilla JS / CSS only — no frameworks, no build step. Match existing code style in the `js/` modules / `styles.css`. (Historical: at the time of this audit the app was a single `app.js`; line references below point into that monolith.)
- Preserve: TV remote diagnostics, spatial focus behavior, toast error reporting, hardcoded client ID, Settings-based pairing/auth, resilient/idempotent Web Playback player creation.
- Animations: `transform` + `opacity` only. No new `backdrop-filter` / large `filter: blur()` — the VIDAA GPU cannot handle them.
- Do NOT bump `service-worker.js` CACHE_NAME in workstream branches (done once at integration to avoid conflicts).
- Known API limits: `/v1/recommendations` + related-artists are dead (403/404) for this dev-mode app. Queue API is append-only (`POST /v1/me/player/queue`); no remove/reorder/jump. `GET /v1/me/player/queue` returns ~2 real items with shuffle off, padded 20 with shuffle on.

## W1 — Ambient rescue (backend + Scene + Room)

Problem: Scene image-sequence (120× 1280×720 JPEG, 10fps, `img.src` swap) ≈ 440MB decoded bitmap + per-frame CPU decode/texture upload → unusable on the TV. Video was abandoned because any `<video>` with an audio track engages the firmware audio pipeline and pauses Spotify.

Fix: strip audio **server-side**, play silent MP4s with the existing plain `<video>` A/B crossfade (hardware H.264 decode).

1. `functions/index.js`: replace frame extraction with silent-MP4 production:
   - Pick the Pexels `video_files` rendition closest to 1920 wide (≤1920).
   - `ffmpeg -i in.mp4 -an -c:v copy -movflags +faststart out.mp4` (re-encode to H.264 Main L4.0 ~5Mbps `scale=1920:-2` only if source >1080p).
   - Upload to `scene-clips-v3/<id>.mp4`, public, `Cache-Control: public, max-age=604800`.
   - Firestore `sceneClips` docs gain `videoUrl` + `kind: "video"`; keep pruning (incl. old `scene-frames-v2` objects).
2. `app.js` Scene playback priority: silent `videoUrl` clips (plain `src=`, no MSE/mp4box) → image-sequence (debug fallback) → Pexels-direct → local loops → generative drift. Keep existing A/B crossfade.
3. Room mode: two-layer artwork crossfade on track change + slow Ken Burns (`scale 1.0→1.08`, ~30s, transform only).
4. CSS: replace `blur(44px)` room backdrop with darkened image + gradient scrim; cut Scene drift layers 4 → 2.

## W2 — Queue & continuation

1. Context everywhere: single-track plays must use `{ context_uri: album, offset: { uri: track } }` — fix `playItem` (bare-URI branch), `playQueueTrack`, and plumb album URI through card/tile datasets.
2. Radio auto-fill ("Autoplay similar music", Settings toggle, default on, persisted): when repeat=off, autoplay on, and the up-next window is nearly empty near track end, seed from current track's artists via `GET /v1/artists/{id}/top-tracks`, dedupe vs recently played/queued, `POST /v1/me/player/queue` 3–5 tracks. Once per track; respect 429 backoff.
3. Queue drawer → honest "Up Next" panel: Now Playing → Queued → "Continuing from: <context>" → "Radio: similar to <artist>". Queue-row click plays track with album context (not bare URI).
4. Track context menu additions: Save/Like (`PUT /v1/me/tracks`, state via `/v1/me/tracks/contains`), Go to album (existing collection view), Start radio from this track. Visible "⋯" affordance on focusable rows.

## W3 — Look & feel (after W1+W2 merge)

1. Left nav rail (icons, labels expand on focus) replacing top bar; Back from content focuses rail.
2. Safe areas (≥48px sides, ≥27px top/bottom for text/focusables), body text ≥24px at 1080p CSS.
3. Collection billboard header: full-bleed artwork backdrop + vertical gradient scrim + palette tint (reuse `extractPalette`), Save-to-library button, duration visible on playlist rows, EQ `animation-play-state: paused` when paused.
4. Focus states: outline + background tint `rgba(30,215,96,0.08)` + scale 1.03–1.05, ~200ms.
5. Strip remaining `backdrop-filter`s (toasts etc.) → solid panels/scrims; halve large shadow radii; global `prefers-reduced-motion` guard.
6. Now Playing: palette-tinted background.

## W4 — Performance & features (after W3)

1. Memoize `activeFocusables()` (invalidate on view change / modal toggle / list render).
2. Key-repeat acceleration for arrows + ChannelUp/Down.
3. Virtualize collection track lists (>100 tracks); paginate collection fetch past 50 (current silent truncation bug).
4. `loading="lazy"` on shelf images; right-sized Spotify image variants.
5. Search view (TV grid keyboard) and artist page (top tracks + albums).

## Integration

- Merge W1+W2 branches into main, resolve conflicts, bump SW cache version once per deployed round.
- Functions deploy is manual (`firebase deploy --only functions` / gcloud — CI is hosting-only). Scene library rebuild via the gcloud scheduler job.
- On-device validation gate for W1: a muted, audio-track-free MP4 in `<video>` must not pause Spotify playback.
