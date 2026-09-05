import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { JSDOM } from "jsdom";
import { TwitchChat } from "../src/chat.ts";
import { appendRichText, EmoteCatalog, getEmotePreviewUrl } from "../src/emotes.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const originalGlobals = new Map();
const catalog = new EmoteCatalog();

class FakeWebSocket {
  static instances = [];
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  sent = [];

  constructor(url) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(message) {
    this.sent.push(message);
  }

  close() {
    this.onclose?.({});
  }
}

const providerResponses = new Map([
  ["https://api.frankerfacez.com/v1/set/global", {
    default_sets: [1],
    sets: {
      1: {
        emoticons: [
          { id: 1, name: "FfzHi", urls: { 1: "//cdn.example/ffz-small.png", 4: "//cdn.example/ffz-large.png" } },
          { id: 2, name: "FfzTiny", urls: { 1: "//cdn.example/ffz-tiny.png" } },
        ],
      },
    },
  }],
  ["https://api.frankerfacez.com/v1/room/id/42", {}],
  ["https://api.betterttv.net/3/cached/emotes/global", [
    { id: "wave", code: "Wave" },
    { id: "snow", code: "SoSnowy" },
  ]],
  ["https://api.betterttv.net/3/cached/users/twitch/42", {}],
  ["https://7tv.io/v3/emote-sets/global", {
    emotes: [
      {
        name: "SevenHi",
        data: { host: { url: "//cdn.example/seven-hi", files: [
          { name: "1x.webp", format: "WEBP" },
          { name: "4x.webp", format: "WEBP" },
        ] } },
      },
      {
        name: "SevenTiny",
        data: { host: { url: "//cdn.example/seven-tiny", files: [
          { name: "1x.webp", format: "WEBP" },
        ] } },
      },
    ],
  }],
  ["https://7tv.io/v3/users/twitch/42", {}],
]);

before(async () => {
  const replacements = {
    window: dom.window,
    document: dom.window.document,
    Node: dom.window.Node,
    HTMLElement: dom.window.HTMLElement,
    WebSocket: FakeWebSocket,
    fetch: async (url) => {
      assert.ok(providerResponses.has(url), `Unexpected network request: ${url}`);
      return { ok: true, json: async () => providerResponses.get(url) };
    },
  };
  for (const [name, value] of Object.entries(replacements)) {
    originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  await catalog.load("42", { ffz: true, bttv: true, sevenTv: true });
});

after(() => {
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
  dom.window.close();
});

function receiveIrc(line) {
  const messages = [];
  const chat = new TwitchChat({
    onState() {},
    onRoom() {},
    onMessage: (message) => messages.push(message),
  });
  try {
    chat.connect("example");
    const socket = FakeWebSocket.instances.at(-1);
    socket.onopen({});
    socket.onmessage({ data: `${line}\r\n` });
    assert.equal(messages.length, 1);
    return messages[0];
  } finally {
    chat.disconnect();
  }
}

function receiveChat(text, tags = "") {
  return receiveIrc(`@id=test-message;display-name=Viewer;${tags} :viewer!viewer@viewer.tmi.twitch.tv PRIVMSG #example :${text}`);
}

function render(message, showNativeEmotes = true) {
  const target = document.createElement("div");
  const count = appendRichText(
    target,
    message.text,
    message.emoteTag,
    catalog,
    showNativeEmotes,
    message.isGigantifiedEmote,
  );
  return { target, count };
}

test("IRC Gigantify enlarges the final Twitch emote even when tag groups are unsorted and third-party emotes follow", () => {
  const message = receiveChat("Kappa Keepo Wave tail", "emotes=1902:6-10/25:0-4;msg-id=gigantified-emote-message");
  assert.equal(message.isGigantifiedEmote, true);
  const { target, count } = render(message);
  const enlarged = target.querySelectorAll(".emote-stack--gigantified");
  assert.equal(count, 3);
  assert.equal(enlarged.length, 1);
  assert.equal(enlarged[0].querySelector("img").alt, "Keepo");
  assert.equal(enlarged[0].querySelector("img").src, "https://static-cdn.jtvnw.net/emoticons/v2/1902/default/dark/3.0");
  assert.equal(target.querySelector('img[alt="Kappa"]').src, "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0");
  assert.ok(target.textContent.endsWith(" tail"));
});

test("ordinary modified Twitch emote IDs survive IRC parsing and select their modified CDN assets", () => {
  const message = receiveChat(
    "Kappa_BW Kappa_HF Kappa_SQ Kappa_SG Kappa_TK",
    "emotes=25_BW:0-7/25_HF:9-16/25_SQ:18-25/25_SG:27-34/25_TK:36-43",
  );
  assert.equal(message.isGigantifiedEmote, false);
  const { target, count } = render(message);
  assert.equal(count, 5);
  assert.equal(target.querySelector(".emote-stack--gigantified"), null);
  for (const suffix of ["BW", "HF", "SQ", "SG", "TK"]) {
    const image = target.querySelector(`img[alt="Kappa_${suffix}"]`);
    assert.equal(image.src, `https://static-cdn.jtvnw.net/emoticons/v2/25_${suffix}/default/dark/1.0`);
    assert.equal(image.dataset.emotePreviewUrl, `https://static-cdn.jtvnw.net/emoticons/v2/25_${suffix}/default/dark/3.0`);
  }
});

test("Gigantify affects only the final occurrence when a Twitch emote is repeated", () => {
  const message = receiveChat("Kappa Kappa", "emotes=25:0-4,6-10;msg-id=gigantified-emote-message");
  const { target, count } = render(message);
  const stacks = target.querySelectorAll(".emote-stack");
  assert.equal(count, 2);
  assert.equal(stacks.length, 2);
  assert.equal(stacks[0].classList.contains("emote-stack--gigantified"), false);
  assert.equal(stacks[1].classList.contains("emote-stack--gigantified"), true);
  assert.equal(stacks[0].querySelector("img").src, "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0");
  assert.equal(stacks[1].querySelector("img").src, "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/3.0");
});

test("emote positions count Unicode code points before a Gigantified emote", () => {
  const message = receiveChat("😀 Kappa café", "emotes=25:2-6;msg-id=gigantified-emote-message");
  const { target, count } = render(message);
  assert.equal(count, 1);
  assert.equal(target.querySelector(".emote-stack--gigantified img").alt, "Kappa");
  assert.equal(target.textContent, "😀  café");
});

test("invalid native ranges stay as text and cannot steal the Gigantify effect", () => {
  for (const invalid of ["1902:-1-4", "1902:10-6", "1902:6-99", "1902:6-", "1902:nope-10"]) {
    const message = receiveChat("Kappa Keepo", `emotes=${invalid}/25:0-4;msg-id=gigantified-emote-message`);
    const { target, count } = render(message);
    assert.equal(count, 1, invalid);
    assert.equal(target.querySelectorAll("img").length, 1, invalid);
    assert.equal(target.querySelector(".emote-stack--gigantified img").alt, "Kappa", invalid);
    assert.equal(target.textContent, " Keepo", invalid);
  }
});

test("disabling native Twitch emotes preserves their text while third-party emotes still render", () => {
  const message = receiveChat("Kappa Wave", "emotes=25_BW:0-4;msg-id=gigantified-emote-message");
  const { target, count } = render(message, false);
  assert.equal(count, 1);
  assert.equal(target.querySelector(".emote-stack--gigantified"), null);
  assert.equal(target.querySelector('[data-emote-provider="TWITCH"]'), null);
  assert.equal(target.querySelector("img").alt, "Wave");
  assert.equal(target.textContent, "Kappa ");
});

test("a zero-width overlay stays on the enlarged native emote with both preview layers retained", () => {
  const message = receiveChat("Kappa SoSnowy", "emotes=25:0-4;msg-id=gigantified-emote-message");
  const { target, count } = render(message);
  const stack = target.querySelector(".emote-stack--gigantified");
  assert.equal(count, 2);
  assert.equal(target.querySelectorAll(".emote-stack").length, 1);
  assert.equal(stack.querySelectorAll("img").length, 2);
  const overlay = stack.querySelector(".chat-emote--overlay");
  assert.equal(overlay.alt, "SoSnowy");
  assert.equal(overlay.dataset.emotePreviewUrl, "https://cdn.betterttv.net/emote/snow/3x.webp");
  assert.equal(stack.dataset.tooltipTitle, "Kappa + SoSnowy");
  assert.match(stack.getAttribute("aria-label"), /^Kappa \(TWITCH\), SoSnowy \(BTTV\)/);
});

test("Gigantify without a native Twitch emote does not enlarge third-party emotes", () => {
  const { target, count } = render(receiveChat("Wave", "msg-id=gigantified-emote-message"));
  assert.equal(count, 1);
  assert.equal(target.querySelector(".emote-stack--gigantified"), null);
});

test("other message types and unrelated msg-id values do not enable Gigantify", () => {
  for (const message of [
    receiveChat("Kappa", "emotes=25:0-4;msg-id=highlighted-message"),
    receiveIrc("@msg-id=gigantified-emote-message :tmi.twitch.tv NOTICE #example :A notice"),
    receiveIrc("@system-msg=Viewer\\ssubscribed :tmi.twitch.tv USERNOTICE #example"),
  ]) {
    assert.equal(message.isGigantifiedEmote, false);
  }
});

test("provider loaders use advertised large preview assets and fall back to available small assets", () => {
  for (const [name, previewUrl] of [
    ["FfzHi", "https://cdn.example/ffz-large.png"],
    ["FfzTiny", "https://cdn.example/ffz-tiny.png"],
    ["SevenHi", "https://cdn.example/seven-hi/4x.webp"],
    ["SevenTiny", "https://cdn.example/seven-tiny/1x.webp"],
  ]) {
    assert.equal(getEmotePreviewUrl(catalog.find(name)), previewUrl, name);
    const { target } = render(receiveChat(name));
    assert.equal(target.querySelector("img").dataset.emotePreviewUrl, previewUrl, name);
  }
});

test("explicit preview URLs take precedence and known CDN sizes preserve query strings", () => {
  assert.equal(getEmotePreviewUrl({
    provider: "TWITCH",
    url: "https://static-cdn.jtvnw.net/emoticons/v2/25_BW/default/dark/1.0?v=1",
  }), "https://static-cdn.jtvnw.net/emoticons/v2/25_BW/default/dark/3.0?v=1");
  assert.equal(getEmotePreviewUrl({
    provider: "BTTV",
    url: "https://cdn.betterttv.net/emote/wave/1x.webp?v=1",
  }), "https://cdn.betterttv.net/emote/wave/3x.webp?v=1");
  assert.equal(getEmotePreviewUrl({
    provider: "BTTV",
    url: "https://cdn.betterttv.net/emote/wave/1x.webp",
    previewUrl: "https://cdn.example/custom-preview.webp",
  }), "https://cdn.example/custom-preview.webp");
});
