# Project Instructions

- Use Serena MCP when traversing or modifying this codebase.
- Keep `CLAUDE.md`, Codex notes, and related agent guidance up to date as the system evolves.
- Prefer clean, scalable TypeScript and web platform code for VIDAA OS TV/PWA constraints.
- Current focus: build the Spotify TV PWA now that Spotify Web Playback SDK playback is viable on VIDAA OS.
- App code is native ES modules under `js/` (entry `js/main.js`, no build step/bundler/import maps); see the Code Layout section in `README.md`.
- Preserve the hardcoded personal Spotify client ID, paired phone login flow, spatial TV focus behavior, and server-side browser log capture.
