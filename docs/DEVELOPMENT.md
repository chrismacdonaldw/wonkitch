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

Run the frontend production build:

```powershell
npm run build
```

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
path does not invoke it. Streamlink's license and the licenses required by
`mpegts.js` are bundled with the application. See
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) for details.
