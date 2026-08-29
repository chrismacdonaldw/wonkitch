# wonkitch

wonkitch is a compact Windows desktop client for watching Twitch streams and
chat in one window. It uses Streamlink for playback and renders Twitch chat,
badges, and third-party emotes in a native Tauri application without loading
the Twitch website.

## Features

### Playback

- In-window live playback through Streamlink and `mpegts.js`
- Stream quality selection and low-latency playback
- Side-by-side and vertical video/chat layouts
- Automatic portrait-monitor layout
- Theater mode with chat, plus separate video-only fullscreen
- Mouse-draggable chat width with persistent sizing
- Custom borderless title bar and window controls
- Signed-out local favorites and optional Twitch following synchronization

### Chat

- Anonymous Twitch IRC reading without an account
- Optional Twitch Device Code login for sending messages
- Twitch badges with names and descriptions
- Compact searchable picker for available Twitch, FrankerFaceZ, BetterTTV, and 7TV emotes
- Per-provider emote controls and adjustable emote size
- Colon and plain-text emote completion, recent-user mention completion, and a live emote preview
- 7TV, BetterTTV, and FrankerFaceZ zero-width emote overlays with name tooltips
- User and term filters with wildcard support
- Mention, user, and keyword highlights
- Desktop, taskbar, title-count, and sound alerts for highlights

### Customization

- Chat font, size, line density, timestamps, badges, and scrollback length
- Configurable colors and username contrast correction
- Compact FFZ-inspired settings panel with live updates
- Built-in notification sounds, volume control, and local custom sound uploads
- Versioned preferences stored in the Windows application-data directory
- Signed in-app update checks, download progress, and one-click installation

## Requirements

- Windows 10 or Windows 11, x64
- Microsoft Edge WebView2 Runtime

The installer includes a pinned, verified Streamlink runtime. No separate media
tools, PATH changes, or administrator installation are required.

## Installation

1. Download `wonkitch_0.1.4_x64-setup.exe` from
   [GitHub Releases](https://github.com/chrismacdonaldw/wonkitch/releases).
2. Run the installer and launch wonkitch from the Start menu or desktop.
3. Enter a Twitch channel name and tune in.

The release is currently unsigned, so Windows SmartScreen may show an
unrecognized-app warning.

PowerShell alternatives are included with every release:

```powershell
# Normal NSIS installation; add -Silent for unattended setup
.\install.ps1

# Check the latest release and update only when a newer version exists
.\update.ps1
```

The scripts verify both `SHA256SUMS.txt` and the cryptographic updater signature
against wonkitch's pinned public key. If using a private fork, authenticate with
`gh auth login` or set `GITHUB_TOKEN` first.

## Twitch Login

Watching streams and reading chat do not require login. One Twitch login enables
sending chat messages, showing followed channels that are live, and loading the
Twitch emotes available to the account and current channel.

1. Select **LOG IN TO CHAT**.
2. wonkitch opens Twitch's official device-activation page.
3. Enter or approve the displayed code.
4. Return to wonkitch after Twitch confirms authorization.

Login requests `user:write:chat`, `user:read:follows`, and `user:read:emotes`
together. Existing installations with an older authorization
may ask for one reconnect when the emote picker is first opened. Access and
refresh tokens are owned by the Rust backend and stored in Windows Credential
Manager. They are never written to `localStorage` or exposed to the WebView.

Local favorites work without login and do not change the channels followed on
Twitch.

## Controls

| Action | Control |
| --- | --- |
| Tune to a channel | Enter a channel in the top-left field |
| Toggle theater mode | `F11` |
| Exit theater or fullscreen | `Escape` |
| Resize chat | Drag the chat panel's left edge |
| Move chat beside/below video | Layout button in the title bar |
| Show or hide chat | Chat button in the title bar or player controls |
| Video-only fullscreen | Fullscreen button in the player controls |
| Open settings | Gear button in the title bar |
| Open favorites and following | Star/list button in the title bar |
| Favorite the tuned channel | Star inside the channel field |
| Open the emote picker | Face button beside the chat input |
| Complete an emote or username | Type `:emo`, `emo`, or `@user`, then use arrows and `Enter`/`Tab` |

## Local Data

- Preferences: `%APPDATA%\com.chrismacdonaldw.wonkitch\preferences.json`
- Local favorites: stored inside the versioned preferences file
- Non-secret Twitch account metadata: the same application-data directory
- OAuth tokens: Windows Credential Manager
- Custom notification audio: WebView2 IndexedDB on the local app origin
- Last channel: WebView2 local storage

Removing a Twitch account from wonkitch deletes its stored credentials.

## Playback Notes

wonkitch includes Streamlink's Twitch plugin and relies on Twitch's undocumented
playback interfaces. Twitch can change those interfaces without notice, which
may temporarily break playback until wonkitch ships an updated Streamlink
runtime.

Streamlink currently filters Twitch's embedded ad segments. During an ad break,
playback may pause or buffer until the live stream resumes. wonkitch does not
promise uninterrupted or permanently ad-free playback.

## Development

Install Node.js, Rust, and the Tauri Windows prerequisites. Then run:

```powershell
npm install
npm run tauri dev
```

The first development or release build downloads the pinned official Streamlink
portable archive, verifies its SHA-256 checksum, and prepares the bundled
runtime. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for redistribution
notices.

The Apache 2.0 license for `mpegts.js` and MIT notices for its bundled browser
dependencies are also installed under the application's `licenses` directory.

Frontend-only checks:

```powershell
npm run build
```

Rust checks:

```powershell
npm run prepare:streamlink
cd src-tauri
cargo test
cargo clippy --all-targets -- -D warnings
```

## Packaging

Generate the Windows installer, cryptographically signed updater artifact,
updater manifest, checksums, and PowerShell release assets:

```powershell
.\scripts\build-release.ps1 -Notes "Summary of this release"
```

The updater signing key and its Windows-encrypted password default to
`%USERPROFILE%\.tauri\wonkitch.key` and `wonkitch.key.password`. Back up both
securely and never commit or distribute them. Existing installs cannot trust
updates signed with a replacement key.

When updating the pinned Streamlink build, change the versioned resource path in
`tauri.conf.json` and `src-tauri/src/lib.rs`, then add its previous directory to
the post-install cleanup in `src-tauri/windows/installer-hooks.nsh`.

Build only the standalone executable:

```powershell
npm run tauri build -- --no-bundle
```

Build outputs are written beneath `src-tauri/target/release/`.

The Twitch Client ID embedded in wonkitch is public by design. Custom builds can
override it at compile time with `WONKITCH_TWITCH_CLIENT_ID`. Never embed a
Twitch Client Secret.
