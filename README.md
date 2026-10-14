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
- Automatic chat delay matching video, with a saved timing adjustment
- Local favorites and a live-only Twitch Following view
- Searchable Twitch, FrankerFaceZ, BetterTTV, and 7TV emote picker
- Automatic live 7TV emote additions, removals, renames, and active set changes
- Large emote hover previews, Twitch Gigantify, and native modified emote images
- Twitch badges, first-message banners, third-party zero-width emotes, and emote completion
- Inline Twitch GIFs and subscription messages with the subscriber's text and emotes
- Reply previews, readable threads, and replying to a selected message
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
| Adjust chat timing | Settings → Chat → Video sync; positive shows chat later, negative shows it earlier |
| Open favorites and following | Star/list button in the title bar |
| Favorite the tuned channel | Star inside the channel field |
| Open the emote picker | Face button beside the chat input |
| Complete an emote or username | Type `:emo` or `@user`, then use arrows and `Enter` or `Tab` |
| Preview an emote while typing | Enter its full name, with or without colons; known `:Emote:` codes convert automatically |
| Read a reply thread | Select its parent preview, or the reply arrow beside a chat message |
| Reply to a message | Select **Reply** in its thread, then write in the chat input |
| Cancel a reply | Select the × beside the reply preview above the input |
| Return to live chat | Select **← CHAT** or press `Escape` while reading a thread |

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

Chat and highlight alerts follow the displayed video and wait while it pauses or
buffers. Live HLS uses the stream's timestamps when available. Other streams
estimate timing from the live playlist or playback buffer; the player marks this
delay with `~`.
Use the timing adjustment in Settings → Chat to correct any remaining offset,
or turn sync off to receive chat immediately. Chat remains live when a stream
cannot be opened. A long pause retains up to 10,000 pending messages; older
pending messages are discarded without being displayed ahead of the video.

VOD playback includes seeking and quality selection, but historical VOD chat is
not available.

## Project Documentation

- [Development and testing](docs/DEVELOPMENT.md)
- [Emote previews and Twitch effects](docs/EMOTES.md)
- [PowerShell installation and updates](docs/INSTALL-SCRIPTS.md)
- [Release process](docs/RELEASING.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)
