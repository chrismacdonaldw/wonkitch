import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { JSDOM } from "jsdom";
import { parseTwitchGifRanges } from "../src/chat-gif.ts";
import { appendRichText, EmoteCatalog } from "../src/emotes.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const originalGlobals = new Map();
const catalog = new EmoteCatalog();
const wave = {
  name: "Wave",
  url: "https://cdn.betterttv.net/emote/wave/1x.webp",
  provider: "BTTV",
  zeroWidth: false,
  overlayX: 0,
  overlayY: 0,
};
catalog.find = (name) => name === wave.name ? wave : undefined;

before(() => {
  for (const [name, value] of Object.entries({
    document: dom.window.document,
    Node: dom.window.Node,
    HTMLElement: dom.window.HTMLElement,
  })) {
    originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});

after(() => {
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
  dom.window.close();
});

const id = "joSNxeswxuc74Juo8X";
const source = `https://media4.giphy.com/media/${id}/giphy.gif?cid=twitch&rid=giphy.gif`;
const label = "[Y A Y Yes GIF by Djemilah Birnie]";

function gifTag(text, token = label, gifId = id) {
  const characters = Array.from(text);
  const start = Array.from(text.slice(0, text.indexOf(token))).length;
  const end = start + Array.from(token).length - 1;
  assert.equal(characters.slice(start, end + 1).join(""), token);
  return `${start}-${end}|${gifId}|${source}`;
}

function render(text, tag, nativeEmoteTag = "", showNativeEmotes = true, gigantified = false) {
  const target = document.createElement("div");
  const count = appendRichText(target, text, nativeEmoteTag, catalog, showNativeEmotes, gigantified, tag);
  return { target, count };
}

test("Chatterino's Twitch GIF sample renders animated CDN assets and retains its original text", () => {
  const { target, count } = render(label, `0-33|${id}|${source}`);
  const link = target.querySelector(".chat-gif");
  const image = link.querySelector("img");
  assert.equal(count, 0, "GIF content does not count as an emote-only message");
  assert.equal(target.textContent, label);
  assert.equal(link.href, `https://i.giphy.com/${id}.webp`);
  assert.equal(link.dataset.gifUrl, link.href);
  assert.equal(link.rel, "noopener noreferrer");
  assert.equal(link.target, "_blank");
  assert.equal(image.src, `https://media4.giphy.com/media/${id}/100.webp`);
  assert.equal(image.srcset, `https://media4.giphy.com/media/${id}/200.webp 2x`);
  assert.equal(image.referrerPolicy, "no-referrer");
  assert.equal(image.getAttribute("aria-hidden"), "true");
  assert.equal(link.getAttribute("aria-label"), `${label} (Twitch GIF, powered by GIPHY)`);
});

test("GIF ranges count Unicode code points and keep text before and after the image", () => {
  const text = `😀 café ${label} 🌙 after`;
  const { target } = render(text, gifTag(text));
  assert.equal(target.querySelectorAll(".chat-gif").length, 1);
  assert.equal(target.querySelector(".chat-gif__label").textContent, label);
  assert.equal(target.textContent, text);
});

test("multiple unsorted GIFs coexist with native, provider, and Gigantified emotes", () => {
  const first = "[one GIF]";
  const second = "[two GIF]";
  const text = `Kappa ${first} Keepo ${second} Wave tail`;
  const firstStart = text.indexOf(first);
  const secondStart = text.indexOf(second);
  const keepoStart = text.indexOf("Keepo");
  const tag = `${secondStart}-${secondStart + second.length - 1}|otherID|${source},` +
    `${firstStart}-${firstStart + first.length - 1}|${id}|${source}`;
  const { target, count } = render(text, tag, `1902:${keepoStart}-${keepoStart + 4}/25:0-4`, true, true);
  assert.equal(count, 3);
  assert.equal(target.querySelectorAll(".chat-gif").length, 2);
  assert.deepEqual([...target.querySelectorAll(".chat-gif__label")].map((node) => node.textContent), [first, second]);
  assert.equal(target.querySelector(".emote-stack--gigantified img").alt, "Keepo");
  assert.equal(target.querySelectorAll(".emote-stack--gigantified").length, 1);
  assert.equal(target.querySelector('[data-emote-provider="BTTV"]').alt, "Wave");
  assert.ok(target.textContent.endsWith(" tail"));
});

test("GIFs remain visible when native Twitch emotes are disabled", () => {
  const text = `Kappa ${label} Wave`;
  const { target, count } = render(text, gifTag(text), "25:0-4", false, true);
  assert.equal(target.querySelectorAll(".chat-gif").length, 1);
  assert.equal(target.querySelector('[data-emote-provider="TWITCH"]'), null);
  assert.equal(target.querySelector('[data-emote-provider="BTTV"]').alt, "Wave");
  assert.equal(target.querySelector(".emote-stack--gigantified"), null);
  assert.equal(count, 1);
  assert.equal(target.textContent, `Kappa ${label} `);
});

test("invalid ranges, IDs, and untrusted source URLs preserve the plain text", () => {
  for (const tag of [
    "", `-1-4|${id}|${source}`, `4-1|${id}|${source}`, `0-99|${id}|${source}`,
    `9007199254740992-9007199254740993|${id}|${source}`,
    `0-4||${source}`, `0-4|../escape|${source}`, `0-4|%2Fescape|${source}`,
    `0-4|${"a".repeat(129)}|${source}`, `0-4|${id}|`,
    `0-4|${id}|javascript:alert(1)`, `0-4|${id}|data:image/gif;base64,AAAA`,
    `0-4|${id}|http://media4.giphy.com/a.gif`,
    `0-4|${id}|https://media4.giphy.com.evil.test/a.gif`,
    `0-4|${id}|https://evil.test/media/${id}/a.gif`,
    `0-4|${id}|https://user@media4.giphy.com/a.gif`,
    `0-4|${id}|https://media4.giphy.com:8443/a.gif`,
  ]) {
    const { target, count } = render("hello", tag);
    assert.equal(count, 0, tag);
    assert.equal(target.querySelector("img"), null, tag);
    assert.equal(target.textContent, "hello", tag);
  }
});

test("GIF assets and links are constructed from the ID rather than the tag URL", () => {
  const tag = `0-4|${id}|https://media1.giphy.com/another/path.gif?redirect=https://evil.test/`;
  const { target } = render("hello", tag);
  assert.equal(target.querySelector("img").src, `https://media4.giphy.com/media/${id}/100.webp`);
  assert.equal(target.querySelector("a").href, `https://i.giphy.com/${id}.webp`);
});

test("overlapping native emotes and GIF tags render each text range once", () => {
  const { target, count } = render("Kappa tail", `0-4|${id}|${source}`, "25:0-4");
  assert.equal(count, 1);
  assert.equal(target.querySelector(".chat-gif"), null);
  assert.equal(target.querySelectorAll("img").length, 1);
  assert.equal(target.textContent, " tail");

  const { target: duplicate } = render("hello world", `0-4|${id}|${source},0-10|otherID|${source}`);
  assert.equal(duplicate.querySelectorAll(".chat-gif").length, 1);
  assert.equal(duplicate.textContent, "hello world");
});

test("a failed GIF image keeps the selectable label and safe link", () => {
  const { target } = render(label, gifTag(label));
  const image = target.querySelector("img");
  image.dispatchEvent(new dom.window.Event("error"));
  const link = target.querySelector("a");
  assert.equal(link.classList.contains("chat-gif--failed"), true);
  assert.equal(link.querySelector("img"), null);
  assert.equal(link.textContent, label);
  assert.equal(link.href, `https://i.giphy.com/${id}.webp`);
});

test("GIF labels are rendered as text even when they contain HTML", () => {
  const token = "[<img src=x onerror=alert(1)> GIF]";
  const { target } = render(token, gifTag(token, token));
  assert.equal(target.querySelectorAll("img").length, 1);
  assert.equal(target.querySelector(".chat-gif__label").textContent, token);
  assert.equal(target.querySelector("[onerror]"), null);
});

test("the parser ignores malformed entries without discarding a later valid GIF", () => {
  assert.deepEqual(parseTwitchGifRanges(`bad,0-4|${id}|${source},9-2|bad|${source}`, 5), [{ id, start: 0, end: 4 }]);
});
