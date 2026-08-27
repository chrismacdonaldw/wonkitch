# MoonDeck

MoonDeck is a lightweight Windows desktop client for watching Twitch streams and
reading chat without loading the Twitch website. Enter any Twitch channel to
open its live feed and chat in one window.

## Features

- Direct Twitch playback through Streamlink
- Low-latency in-window MPEG-TS playback
- Anonymous Twitch IRC chat
- Twitch, 7TV, BetterTTV, and FrankerFaceZ emotes
- Channel switching and quality selection
- Collapsible chat and fullscreen video
- Last-channel persistence

Chat is currently read-only. Sending messages will require Twitch OAuth and a
registered Twitch application.

## Requirements

- Windows 10 or 11 with WebView2
- Streamlink installed at its standard per-user or Program Files location
- Node.js and Rust for development

## Development

```sh
npm install
npm run tauri dev
```

## Build

```sh
npm run tauri build -- --no-bundle
```

The standalone executable is written to
`src-tauri/target/release/moondeck.exe`.

## Architecture

The Tauri backend launches Streamlink as a hidden local transport and relays its
processed output through a loopback-only HTTP proxy. The WebView uses
`mpegts.js` for playback and connects directly to Twitch IRC for chat. Emote
metadata is loaded independently from 7TV, BetterTTV, and FrankerFaceZ so one
provider failing does not take down chat.
