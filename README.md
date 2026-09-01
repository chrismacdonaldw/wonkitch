# wonkitch

wonkitch is a compact Windows desktop app for watching Twitch streams and chat
in one window. It keeps playback, chat, followed channels, favorites, emotes,
and chat controls together without loading the Twitch website.

[Download the latest release](https://github.com/chrismacdonaldw/wonkitch/releases/latest)

## Highlights

- Low-latency in-window playback with stream quality selection
- Twitch VOD playback with timeline seeking and quality selection
- Side-by-side and vertical video/chat layouts, including portrait-monitor support
- Theater mode with chat and separate video-only fullscreen
- Anonymous chat reading and optional Twitch login for sending messages
- Local favorites and a live-only Twitch Following view
- Searchable Twitch, FrankerFaceZ, BetterTTV, and 7TV emote picker
- Twitch badges, first-message banners, third-party zero-width emotes, and emote completion
- User and term filters with wildcard support
- Mention, user, and keyword highlights with optional desktop, sound, and taskbar alerts
- Custom chat fonts, colors, density, emote size, optional scrollback limit, and panel width
- Automatically saved playback volume
- Signed in-app update checks with one-click installation

## Requirements

- Windows 10 or Windows 11, x64
- Microsoft Edge WebView2 Runtime

The installer includes its own verified Streamlink runtime. Streamlink, FFmpeg,
PATH changes, and administrator installation are not required separately.

## Installation

1. Open the [latest GitHub release](https://github.com/chrismacdonaldw/wonkitch/releases/latest).
2. Download the Windows installer ending in `_x64-setup.exe`.
3. Run the installer, launch wonkitch, and enter a Twitch channel name.

The installer is not Authenticode-signed, so Windows SmartScreen may display an
unrecognized-app warning. In-app update packages are separately verified against
a cryptographic key pinned inside wonkitch.

Advanced and automated installation options are documented in
[PowerShell installation and updates](docs/INSTALL-SCRIPTS.md).

## Twitch Login

Watching streams and reading chat do not require an account. One Twitch approval
enables sending chat messages, loading live followed channels, and showing the
Twitch emotes available to the account and current channel.

1. Select **LOG IN TO CHAT**.
2. wonkitch opens Twitch's official device-activation page.
3. Enter the code displayed by wonkitch and approve access.
4. Return to wonkitch after Twitch confirms authorization.

An account authorized by an older wonkitch version may need to reconnect once
when opening the emote picker. Local favorites always work without Twitch login
and do not change the channels followed on Twitch.

## Controls

| Action | Control |
| --- | --- |
| Tune to a channel | Enter a channel in the top-left field |
| Open a Twitch VOD | Paste its Twitch video link into the top-left field |
| Toggle theater mode | `F11` |
| Exit theater or fullscreen | `Escape` |
| Resize chat | Drag the chat panel's left edge |
| Move chat beside or below video | Layout button in the title bar |
| Show or hide chat | Chat button in the title bar or player controls |
| Enter video-only fullscreen | Fullscreen button in the player controls |
| Open settings | Gear button in the title bar |
| Open favorites and following | Star/list button in the title bar |
| Favorite the tuned channel | Star inside the channel field |
| Open the emote picker | Face button beside the chat input |
| Complete an emote or username | Type `:emo`, `emo`, or `@user`, then use arrows and `Enter` or `Tab` |

## Privacy and Local Data

- Preferences and local favorites: `%APPDATA%\com.chrismacdonaldw.wonkitch\preferences.json`
- Non-secret Twitch account metadata: `%APPDATA%\com.chrismacdonaldw.wonkitch\settings.json`
- OAuth tokens: Windows Credential Manager
- Custom notification audio: WebView2 local IndexedDB storage
- Last channel: WebView2 local storage

OAuth tokens remain in the native backend and are not exposed to the web-based
interface. Logging out of Twitch through wonkitch removes the stored credentials.

## Playback Limitations

wonkitch uses Streamlink's Twitch integration and relies on playback interfaces
that Twitch can change without notice. Such changes may temporarily interrupt
playback until wonkitch ships an updated runtime.

Playback may pause or buffer during Twitch ad breaks. wonkitch does not promise
uninterrupted or permanently ad-free playback.

VOD playback includes seeking and quality selection, but historical VOD chat is
not available.

## Project Documentation

- [Development and testing](docs/DEVELOPMENT.md)
- [PowerShell installation and updates](docs/INSTALL-SCRIPTS.md)
- [Release process](docs/RELEASING.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)
