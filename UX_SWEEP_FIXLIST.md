# UX Sweep Fix List (June 2026 final-polish audit)

Triaged from the full UX/UI/HCI audit. Execute after the procedural-Scene rework merges.
Items referencing the old video/MJPEG Scene pipeline were dropped (feature deleted).

## P0 — broken / severe

1. `transferToDevice` shows no error toast on non-ok response (app.js ~3759) — add toast + throw; also ADD a success toast "Playback moved to <device>" (audit #28).
2. Toast level styling: only `.toast.error` exists — "success"/"info"/"warn" levels render unstyled or as error. Add per-level left-border colors (green/blue/amber) in styles.css (~331).
3. Stale `is-holding` class: clear enterHold state in `closeTrackMenu()` as a safety net so a hold interrupted by menu-open/navigation never leaves the class behind.
4. No feedback when no Spotify device exists: attempting Play/Next/transport with `!state.spotifyDeviceId` and no active device should toast "Create the TV player in Settings first" (once, not spammy) — wire into ensureSpotifyDeviceReady failure path; also keep transport visible (don't disable — TV users need focusable targets) but give clear feedback.

## P1 — confusing / ugly

5. Toast duration too short for 10-foot reading: success 3s → 5s, error 4.5s → 7s (app.js ~5722).
6. Humanize Spotify API errors: parse `error.message`/`error.reason` from response bodies in the shared error reader; map common cases (401 "Session expired — re-pair from Settings", 403 "Spotify Premium/permissions issue", 404 "No active device — create the TV player in Settings", 429 "Spotify is rate-limiting; retrying shortly"). Apply at playback start, queue add, save, search.
7. Long-press discoverability: extend the focus-only "⋯" affordance with a small "Hold OK" caption (focus state only, no layout shift) on collection/artist rows and track tiles.
8. `.up-next` has no z-index — can render under the queue drawer (z 110). Set ~105 (above np-pill 30, below drawer).
9. Phone-pair screen and exit dialog both z 100 — bump phone-pair above (it pre-empts the app).
10. np-pill transport buttons 44px/38px < 48px Fitts minimum — raise to ≥48px.
11. ~~np-pill ellipsis~~ — already present in CSS (verified); instead: confirm .np-pill__device suffix (implemented) truncates gracefully.
12. Collection track list renders blank during initial load — add placeholder "Loading tracks…" row(s) before the first page lands.
13. Manifest icons: single 939×940 PNG. Generate 192/512 PNGs (use `sips` from the existing logo) + declare `maskable` purpose entries.

## P2 — polish

14. Focus recovery when the focused row disappears during re-render (queue refresh, windowed render): after replaceChildren, if document.activeElement is body, focus the nearest row by remembered index.
15. Device status strip: update on SDK `not_ready` (currently stays "TV player ready").
16. 429 backoff: one low-profile toast "Spotify rate-limited — retrying in Ns" (dedupe per backoff window).
17. Radio autofill: always toast the FIRST auto-queue of a session ("Radio: queued N similar tracks") — keep subsequent fires silent.
18. Palette-tinted billboard text contrast: derive --coll-rgb/--np-rgb luminance; if bright, deepen the scrim alpha (don't flip text color — simpler + safer).
19. `role="log"` on the diagnostics log element (index.html ~544).
20. Focus ring: 4px outline + 1px dark outer halo for dark-on-dark cases (styles.css ~130).
21. Shuffle feedback: toast "Playing — shuffle on" when collection Play applies shuffle.
22. Playlist picker load failure: toast in openPlaylistPicker catch.
23. Settings toggles: set aria-checked/visual state from the same code path to avoid stale announcements.
24. Collection window lookahead: bump COLLECTION_RENDER_LOOKAHEAD 15 → 25 to keep ahead of accelerated key-repeat.

## Dropped (obsolete or intentional)

- Scene/Firestore library failure toasts (pipeline deleted — Scene is procedural now).
- Search grid no-wrap at edges (intentional TV behavior).
- Ambient dim/undim on focus (correct behavior).
- "Verify only" items: 403 save flow copy, np-pill focus ring inheritance.
