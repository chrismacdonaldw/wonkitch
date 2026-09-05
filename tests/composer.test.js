import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { JSDOM } from "jsdom";
import { findChatSuggestionContext, normalizeColonEmotes } from "../src/chat-composer.ts";
import { appendEmotePreview, appendRichText, EmoteCatalog } from "../src/emotes.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const originalGlobals = new Map();
const catalog = new EmoteCatalog();

before(async () => {
  const replacements = {
    document: dom.window.document,
    Node: dom.window.Node,
    HTMLElement: dom.window.HTMLElement,
    fetch: async (url) => {
      assert.ok([
        "https://api.betterttv.net/3/cached/emotes/global",
        "https://api.betterttv.net/3/cached/users/twitch/42",
      ].includes(url), `Unexpected network request: ${url}`);
      return {
        ok: true,
        json: async () => url.endsWith("/global") ? [
          { id: "wave", code: "Wave" },
          { id: "snow", code: "SoSnowy" },
          { id: "alternate-kappa", code: "Kappa" },
        ] : {},
      };
    },
  };
  for (const [name, value] of Object.entries(replacements)) {
    originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  await catalog.load("42", { ffz: false, bttv: true, sevenTv: false });
  catalog.setTwitchEmotes([
    { name: "Kappa", id: "25" },
    { name: "Keepo", id: "1902" },
  ].map(({ name, id }) => ({
    name,
    provider: "TWITCH",
    url: `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/1.0`,
    zeroWidth: false,
    overlayX: 0,
    overlayY: 0,
  })));
});

after(() => {
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
  dom.window.close();
});

function preview(text, includeTwitch = true) {
  const target = document.createElement("div");
  const count = appendEmotePreview(target, text, catalog, includeTwitch);
  return { target, count };
}

test("plain full native and third-party emote names render in the preview, with Twitch taking precedence", () => {
  const { target, count } = preview("hello Kappa Wave Keepo");
  assert.equal(count, 3);
  assert.equal(target.textContent, "hello   ");
  assert.deepEqual([...target.querySelectorAll("img")].map((image) => [
    image.alt, image.dataset.emoteProvider,
  ]), [["Kappa", "TWITCH"], ["Wave", "BTTV"], ["Keepo", "TWITCH"]]);
  assert.equal(catalog.find("Kappa").provider, "BTTV");
  assert.equal(catalog.findAvailable("Kappa").provider, "TWITCH");
  assert.equal(catalog.findAvailable("Kappa", false).provider, "BTTV");
});

test("preview lookup requires exact full whitespace-separated tokens", () => {
  const { target, count } = preview("Keepo\tkeepo Keepo! :Keepo: Keep\nWave");
  assert.equal(count, 2);
  assert.equal(target.textContent, "\tkeepo Keepo! :Keepo: Keep\n");
});

test("preview native emotes honor the setting while third-party emotes remain available", () => {
  const { target, count } = preview("Keepo Wave Kappa", false);
  assert.equal(count, 2);
  assert.equal(target.textContent, "Keepo  ");
  assert.equal(target.querySelector('[data-emote-provider="TWITCH"]'), null);
  assert.equal(target.querySelector('img[alt="Kappa"]').dataset.emoteProvider, "BTTV");
});

test("native preview emotes retain stacked overlays, hover assets, and accessible labels", () => {
  const { target, count } = preview("Keepo SoSnowy");
  assert.equal(count, 2);
  assert.equal(target.querySelectorAll(".emote-stack").length, 1);
  const stack = target.querySelector(".emote-stack");
  assert.equal(stack.querySelectorAll("img").length, 2);
  assert.equal(stack.querySelector(".chat-emote--overlay").alt, "SoSnowy");
  assert.equal(stack.querySelector('img[alt="Keepo"]').dataset.emotePreviewUrl,
    "https://static-cdn.jtvnw.net/emoticons/v2/1902/default/dark/3.0");
  assert.equal(stack.querySelector('img[alt="SoSnowy"]').dataset.emotePreviewUrl,
    "https://cdn.betterttv.net/emote/snow/3x.webp");
  assert.equal(stack.dataset.tooltipTitle, "Keepo + SoSnowy");
  assert.equal(stack.getAttribute("aria-label"), "Keepo (TWITCH), SoSnowy (BTTV)");
});

test("incoming native emotes still require IRC ranges even when available in the composer catalog", () => {
  const target = document.createElement("div");
  assert.equal(appendRichText(target, "Keepo Wave", "", catalog), 1);
  assert.equal(target.textContent, "Keepo ");
  assert.equal(target.querySelector('[data-emote-provider="TWITCH"]'), null);
  target.replaceChildren();
  assert.equal(appendRichText(target, "Keepo Wave", "1902:0-4", catalog), 2);
  assert.equal(target.querySelector('[data-emote-provider="TWITCH"]').alt, "Keepo");
});

test("suggestions require an explicit colon or mention trigger", () => {
  for (const value of ["Kappa", "ordinary chat", ":Kappa:", ":Unknown:", "https://example.com", "word:Ka", ":K"]) {
    assert.equal(findChatSuggestionContext(value, value.length), null, value);
  }
  assert.deepEqual(findChatSuggestionContext("hi :Ka", 6), {
    query: "Ka", range: { start: 3, end: 6 }, trigger: "colon",
  });
  assert.deepEqual(findChatSuggestionContext("hi @us", 6), {
    query: "us", range: { start: 3, end: 6 }, trigger: "mention",
  });
  assert.deepEqual(findChatSuggestionContext("hi :Kappa", 6), {
    query: "Ka", range: { start: 3, end: 9 }, trigger: "colon",
  });
});

test("completed known colon emotes normalize to sendable names and immediately render in preview", () => {
  const value = "hello :Keepo: :Wave:";
  const normalized = normalizeColonEmotes(value, value.length, value.length,
    (name) => catalog.findAvailable(name));
  assert.deepEqual(normalized, {
    value: "hello Keepo Wave", selectionStart: 16, selectionEnd: 16,
  });
  assert.equal(preview(normalized.value).count, 2);
});

test("colon normalization preserves unknown, partial, plain, and embedded tokens", () => {
  const value = ":Unknown: :keepo: :Kee Keepo http://:Keepo: word:Wave: :Keepo:!";
  assert.deepEqual(normalizeColonEmotes(value, value.length, value.length,
    (name) => catalog.findAvailable(name)), {
    value, selectionStart: value.length, selectionEnd: value.length,
  });
});

test("colon normalization preserves selection around converted tokens and the caret before them", () => {
  const value = "hello :Keepo: world";
  assert.deepEqual(normalizeColonEmotes(value, 6, 13, (name) => catalog.findAvailable(name)), {
    value: "hello Keepo world", selectionStart: 6, selectionEnd: 11,
  });
  assert.deepEqual(normalizeColonEmotes(value, 2, 2, (name) => catalog.findAvailable(name)), {
    value: "hello Keepo world", selectionStart: 2, selectionEnd: 2,
  });
});
