# Emote previews and Twitch effects

Hover over an emote in chat, the input preview, the picker, or completion results
to see a larger image and its name/provider. Picker buttons also show the preview
on keyboard focus. Zero-width overlays stay composed with the underlying emote.
Previews request higher-resolution images when the provider offers them.

## Composing messages

Full emote names, such as `Kappa` or `catJAM`, render in the chat preview without
opening suggestions. Start with a colon, such as `:Kap`, to open emote
suggestions, or `@name` for username suggestions. A complete, recognized
`:Kappa:` code converts automatically to `Kappa` and appears in the preview.
Names are case-sensitive, as they are in Twitch chat; unknown codes stay as text.
Twitch emote previews use the account's available emotes and respect the Twitch
emotes setting.

Incoming replies show the direct recipient above the message, using Twitch's
`reply-parent-*` IRC tags. This also works when the original message is no longer
in local chat history. See [Twitch's IRC reply documentation](https://dev.twitch.tv/docs/chat/irc/#replying-to-a-chat-message).

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
