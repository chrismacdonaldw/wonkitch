# Development

This document covers local development, testing, and non-release builds. Release
signing and publication are documented separately in [RELEASING.md](RELEASING.md).

## Prerequisites

- Windows 10 or Windows 11, x64
- Node.js `^20.19.0` or `>=22.12.0`, with npm
- A current Rust toolchain
- The [Tauri 2 Windows prerequisites](https://v2.tauri.app/start/prerequisites/)
- Windows PowerShell 5.1

## Setup

Install dependencies and start the Tauri development app:

```powershell
npm install
npm run tauri dev
```

The first Tauri development or production build downloads the pinned official
Streamlink portable archive, verifies its size and SHA-256 checksum, and prepares
the private runtime under `src-tauri/resources/`. The archive is cached beneath
`%LOCALAPPDATA%\wonkitch-build-cache`.

The generated Streamlink resource directories and build outputs are ignored by
Git.

## Checks

Run the frontend regression tests and production build:

```powershell
npm test
npm run build
```

The tests run with Node's test runner, `tsx`, and a local DOM. They cover incoming
Twitch IRC messages and replies, composer suggestions and previews, emote effects
and stacking, provider preview assets, and live playback recovery without
connecting to Twitch or third-party services. Playback tests include the HLS
fallback for fragmented MP4 streams, quality changes, and stale requests during
channel or VOD switches.

Chat sync tests exercise HLS wall-clock timestamps and live playlist latency,
different stream delays with a shared adjustment, the MPEG-TS buffer estimate,
startup, pause/buffering, live catch-up, timing adjustments, queue limits, offline
chat, and resets across quality/channel/VOD changes. Preferences tests use the
actual settings markup and mocked Tauri commands to verify saving and reloading
the sync controls. Rust tests cover migration and adjustment normalization.

Interaction tests exercise volume-control focus, keyboard navigation, interrupted
pointer capture, and chat follow-live state across hover previews, native window
move/resize cleanup, scroll anchoring, and deliberate scrolling. Small upward
wheel, keyboard, touch, and scrollbar gestures must pause immediately; forward
scrolling resumes at the live edge even when incoming messages move that edge.
Tests use DOM events, controlled animation frames, and gesture timers without
opening or moving the live app.

Chat connection tests use fake sockets, clocks, and network events to cover silent
connection loss, five-second idle probes and matching-PONG deadlines, an
eight-second connection/join timeout, bounded reconnect backoff, manual retries,
network restoration, stale callbacks, and cleanup. Connection status tests verify
immediate notices, retry actions, focus recovery, and preservation of conversation
nodes, reply threads, drafts, and scroll positions. Retry requests are paced to
at most one socket attempt per second and can override a stale offline hint.

GIF tests cover Twitch's code-point ranges, trusted GIPHY assets, overlapping
emotes, original text, and image failure fallback. Subscription tests cover
USERNOTICE bodies and synchronized alert/body delivery. Reply and thread tests
cover rich previews, out-of-order parents, bounded history, deletion scrubbing,
keyboard navigation, preserved scroll positions, focus and GIF elements during
updates, and resets across channels. Moderation tests cover dimmed rich content,
removal and mode-switch purging, pending-message races, unavailable parents,
bounded tombstones, and deletion following the same video clock. Preferences
tests cover the deleted-message setting, older-file migration, saving, and reset.
Rust tests also verify optional reply IDs and normal/reply Helix request bodies
without sending messages to Twitch.

Live 7TV tests use mocked sockets, clocks, and REST responses. They cover new
emotes, removals, aliases, active sets, provider precedence, stale requests,
reconnection and heartbeat watchdogs, subscription acknowledgement, event batching,
missed-change reconciliation, and disabling/resetting a watch without touching
the live app. Unchanged snapshots avoid repainting chat and interrupting previews.

Prepare the bundled runtime and run the Rust checks:

```powershell
npm run prepare:streamlink
cd src-tauri
cargo fmt --all -- --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
```

## Standalone Build

Build the executable without creating an installer:

```powershell
npm run tauri build -- --no-bundle
```

Build outputs are written beneath `src-tauri/target/release/`.

## Project Layout

- `src/`: TypeScript frontend, Twitch chat, preferences, badges, and emotes
- `src-tauri/src/`: Rust backend, playback process management, OAuth, and Tauri commands
- `src-tauri/windows/`: NSIS installer hooks
- `scripts/`: runtime preparation, release building, installation, and update scripts
- `licenses/` and `THIRD_PARTY_NOTICES.md`: bundled dependency notices

## Twitch Application Configuration

The embedded Twitch Client ID is public by design. A custom build can override it
at compile time with `WONKITCH_TWITCH_CLIENT_ID`.

Do not embed a Twitch Client Secret. wonkitch uses the Device Code flow and does
not require one.

## Third-Party Runtime

The prepared Streamlink runtime excludes FFmpeg because wonkitch's HTTP playback
path does not invoke it. Live playback starts with `mpegts.js`; when Streamlink's
output is fragmented MP4, the app automatically retries the selected rendition
with `hls.js` through the shared local HLS relay. Quality changes retain HLS for
that channel, and tuning another channel resets format detection. Both live HLS
and VOD playback relay playlists, initialization fragments, and media segments.
Streamlink's license and the licenses required by
`mpegts.js` are bundled with the application. See
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) for details.
