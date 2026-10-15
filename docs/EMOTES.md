# Emote previews and Twitch effects

Hover over an emote in chat, the input preview, the picker, or completion results
to see a larger image and its name/provider. Picker buttons also show the preview
on keyboard focus. Zero-width overlays stay composed with the underlying emote.
Previews request higher-resolution images when the provider offers them.
Emotes preview at up to 192 pixels tall, with extra room for wide emotes and
overlays, and shrink to fit smaller windows. Chat autoscroll pauses while a chat
tooltip is open so incoming messages do not interrupt the preview. Scrolling a
different panel does not dismiss previews in the picker or composer. Live chat
resumes when the preview closes, unless you scroll away or enable pause on hover.
The first upward scroll pauses following, even close to the bottom. Scroll back
to the bottom or select **Jump to live** to resume.

Zero-width emotes layer onto the preceding emote. The full stack reserves room
for its widest layer and any shifted edges, so frames do not cover usernames or
get cut off by neighboring rows. Wide stacks can wrap to the next line sooner.

## Composing messages

Full emote names, such as `Kappa` or `catJAM`, render in the chat preview without
opening suggestions. Start with a colon, such as `:Kap`, to open emote
suggestions, or `@name` for username suggestions. A complete, recognized
`:Kappa:` code converts automatically to `Kappa` and appears in the preview.
Names are case-sensitive, as they are in Twitch chat; unknown codes stay as text.
Twitch emote previews use the account's available emotes and respect the Twitch
emotes setting.

Incoming replies show the direct recipient and a preview of the parent message.
Select the preview, or the reply arrow beside any message, to read its thread in
the chat panel. Choose **Reply** on a message to address it from the chat input;
the × above the input cancels the reply. **← CHAT** or `Escape` returns to live chat.

Threads contain messages retained locally, plus earlier parent text supplied by
Twitch's reply tags. Known parents retain their emotes and GIFs in previews.
Thread history is bounded to the chat limit (up to 5,000 messages; 1,000 when
live chat has no limit), so complete older conversations cannot be fetched.
Changing channel or opening a VOD clears the old thread and selected reply.
Deleted messages remain visible in gray with a small **Deleted** label, including
known parent previews and thread entries. Under **Settings → Chat → Behavior →
Deleted messages**, choose **Remove from chat** to discard their content instead.
Switching back cannot restore content that was already removed. Retained deleted
messages use the same local history limits and clear when changing channels;
filters still apply. Deleted messages that were never received locally show a
placeholder rather than text from reply tags.
See [Twitch's IRC reply documentation](https://dev.twitch.tv/docs/chat/irc/#replying-to-a-chat-message).

## Twitch GIFs and subscription messages

Twitch GIF messages display inline using animated GIPHY images. The original
caption stays selectable and remains visible if the image fails. Selecting a GIF
opens its GIPHY image in your browser. This supports incoming GIF messages; GIF
selection and sending through Twitch's GIF picker still happen on Twitch.
The format follows Chatterino's [GIF message support](https://github.com/Chatterino/chatterino2/pull/7223).

Subscription and resubscription messages include both the alert and the user's
attached text, badges, emotes, and GIFs. Turning off system messages hides the
alert header while retaining the subscriber's message. The header and body wait
for the same video position, so they appear together.

## Live 7TV updates

With 7TV emotes enabled, the app watches changes to the channel's active set and
the global set. Added emotes become available in chat, reply previews, completion
suggestions, and the picker automatically. Removals, aliases, and changes to the
channel's active set also update without reopening the stream.

The app refreshes authoritative sets after reconnecting and periodically checks
for missed changes. Brief network failures retain the last working emotes. Turning
off 7TV, changing channel, or entering VOD playback stops the old watch. Twitch,
FFZ, and BTTV emotes keep their existing catalog and priority during live refreshes.

The feed follows [7TV's Event API](https://github.com/SevenTV/SevenTV/tree/main/apps/event-api).

## Effects received in chat

- **Gigantify:** Twitch sends `msg-id=gigantified-emote-message` on an IRC
  `PRIVMSG`. wonkitch displays the final Twitch emote occurrence at 112 pixels,
  using the higher-resolution image. Other emotes and following text keep their
  normal size. This works with anonymous chat reading.
- **Modified Twitch emotes:** Greyscale (`BW`), horizontal flip (`HF`), squished
  (`SQ`), sunglasses (`SG`), and think (`TK`) are rendered by Twitch's CDN.
  wonkitch preserves the full emote ID, including its modifier suffix, for both
  the chat image and the larger preview. It does not apply the effect a second
  time. Animated image assets continue to animate.

These are display features for incoming chat. Purchasing/redeeming a Power-up or
choosing subscription/channel-point modifiers still happens on Twitch.

Twitch also has whole-message effects and on-screen celebrations. Those are
separate from emote modifiers and are not reproduced by this change. Chat text
and native emotes in message-effect messages still display normally.

## Protocol notes and sources

Checked September 2026. Twitch's official IRC documentation does not currently
describe the Gigantify tag; its handling is corroborated by established IRC chat
clients. EventSub documents the corresponding `power_ups_gigantified_emote` and
`power_ups_message_effect` message types, but switching to EventSub is unnecessary
for the emote display supported here.

- [Twitch: Modified Emotes](https://help.twitch.tv/s/article/modified-emotes?language=en_US)
- [Twitch: EventSub Channel Chat Message](https://dev.twitch.tv/docs/eventsub/eventsub-reference/#channel-chat-message-event)
- [Chatterino: IRC message handling](https://github.com/Chatterino/chatterino2/blob/master/src/providers/twitch/IrcMessageHandler.cpp)
- [Chatty: selecting the final emote for Gigantify](https://github.com/chatty/chatty/blob/master/src/chatty/gui/components/textpane/ChannelTextPane.java)
- [FrankerFaceZ: Twitch modifier IDs and image URLs](https://github.com/FrankerFaceZ/FrankerFaceZ/blob/master/src/sites/twitch-twilight/modules/chat/emote_menu.jsx)
