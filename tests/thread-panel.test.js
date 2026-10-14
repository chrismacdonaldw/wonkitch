import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { ChatThreadStore } from "../src/chat-thread.ts";
import { ChatThreadPanel } from "../src/chat-thread-panel.ts";

const cleanup = [];
afterEach(() => { while (cleanup.length) cleanup.pop()(); });
function message(id, parent = null, extra = {}) {
  return { id, login: id, displayName: id, color: "", text: id + " text", badges: [], emoteTag: "",
    isGigantifiedEmote: false, reply: parent ? { messageId: parent, login: parent, displayName: parent, userId: "",
      threadRootMessageId: "root" } : null, timestamp: 1, isAction: false, isNotice: false,
    isFirstMessage: false, ...extra };
}
function fixture(maximum = 1000, removeFiltered = false) {
  const dom = new JSDOM(readFileSync(new URL("../index.html", import.meta.url), "utf8"));
  const { document } = dom.window;
  const panel = document.querySelector("#reply-thread");
  const log = panel.querySelector(".thread-log");
  const store = new ChatThreadStore(maximum);
  Object.defineProperties(log, { scrollHeight: { get: () => log.children.length * 100 }, clientHeight: { value: 100 } });
  let closed = 0;
  const ui = new ChatThreadPanel(panel, store, {
    renderEntry: (entry) => {
      if (removeFiltered) return null;
      const row = document.createElement("article");
      row.dataset.messageId = entry.id;
      row.textContent = entry.text;
      if (entry.parentId) {
        const preview = document.createElement("button");
        preview.className = "message-reply";
        preview.textContent = "Parent preview";
        row.append(preview);
      }
      const reply = document.createElement("button");
      reply.className = "thread-reply-action";
      reply.textContent = "Reply";
      const gif = document.createElement("a");
      gif.href = "https://i.giphy.com/test.webp";
      gif.dataset.gifUrl = gif.href;
      gif.textContent = "GIF";
      row.append(reply, gif);
      return row;
    },
    onClose: () => { closed++; },
  });
  cleanup.push(() => { ui.dispose(); dom.window.close(); });
  const find = (id) => [...log.children].find((row) => row.dataset.messageId === id);
  return { dom, document, panel, log, store, ui, find, closed: () => closed };
}

test("thread opens in the chat panel and closing restores its source button", () => {
  const f = fixture();
  f.store.add(message("root"));
  f.store.add(message("child", "root"));
  const trigger = f.document.createElement("button");
  f.document.body.append(trigger);
  assert.equal(f.ui.open("child", trigger), true);
  assert.equal(f.panel.hidden, false);
  assert.equal(f.panel.parentElement.classList.contains("thread-open"), true);
  assert.equal(f.panel.querySelector(".thread-count").textContent, "2 messages");
  assert.equal(f.document.activeElement, f.panel.querySelector(".thread-close"));
  f.panel.querySelector(".thread-close").click();
  assert.equal(f.panel.hidden, true);
  assert.equal(f.document.activeElement, trigger);
  assert.equal(f.closed(), 1);
});

test("unrelated chat preserves thread nodes, while new replies follow only at the bottom", () => {
  const f = fixture();
  f.store.add(message("root"));
  f.store.add(message("child", "root"));
  f.ui.open("root");
  const original = f.find("root");
  f.store.add(message("unrelated"));
  f.ui.refresh();
  assert.equal(f.find("root"), original);
  f.log.scrollTop = f.log.scrollHeight - 100;
  f.store.add(message("new", "child"));
  f.ui.refresh();
  assert.equal(f.log.scrollTop, f.log.scrollHeight);
  assert.equal(f.find("root"), original, "GIFs in unchanged rows retain their image elements");
  f.log.scrollTop = 10;
  f.store.add(message("newest", "new"));
  f.ui.refresh();
  assert.equal(f.log.scrollTop, 10, "reading an older reply must not jump to the newest one");
});

test("refresh preserves focus on parent previews, reply buttons, and GIF links", () => {
  for (const selector of [".message-reply", ".thread-reply-action", "a[data-gif-url]"]) {
    const f = fixture();
    f.store.add(message("root"));
    f.store.add(message("child", "root"));
    f.ui.open("child");
    f.find("child").querySelector(selector).focus();
    f.store.add(message("new", "child"));
    f.ui.refresh(true);
    assert.equal(f.document.activeElement, f.find("child").querySelector(selector), selector);
  }
});

test("a thread that ages out clears old content and safely moves focus into the log", () => {
  const f = fixture(2);
  f.store.add(message("root"));
  f.store.add(message("child", "root"));
  f.ui.open("child");
  f.find("child").querySelector(".thread-reply-action").focus();
  f.store.add(message("other"));
  f.store.add(message("another"));
  f.ui.refresh();
  assert.match(f.log.textContent, /unavailable/);
  assert.equal(f.find("child"), undefined);
  assert.equal(f.document.activeElement, f.log);
});

test("Escape closes a thread but leaves an open modal in charge of its own Escape", () => {
  const f = fixture();
  f.store.add(message("root"));
  f.ui.open("root");
  const modal = f.document.querySelector("#auth-dialog");
  modal.setAttribute("open", "");
  f.document.dispatchEvent(new f.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(f.panel.hidden, false);
  modal.removeAttribute("open");
  f.document.dispatchEvent(new f.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(f.panel.hidden, true);
});

test("resetting a channel removes the thread contents and stale source focus", () => {
  const f = fixture();
  f.store.add(message("root", null, { text: "Old channel" }));
  f.ui.open("root");
  f.ui.close(false);
  f.store.clear();
  assert.equal(f.ui.open("root"), false);
  assert.equal(f.log.children.length, 0);
  f.store.add(message("root", null, { text: "New channel" }));
  f.ui.open("root");
  assert.equal(f.log.textContent.includes("Old channel"), false);
  assert.equal(f.log.textContent.includes("New channel"), true);
});

test("late parents update the root used after the originally selected reply ages out", () => {
  const f = fixture(3);
  f.store.add(message("b"));
  f.store.add(message("selected", "b", { reply: { messageId: "b", login: "b", displayName: "b", userId: "" } }));
  f.ui.open("selected");
  f.store.add(message("a"));
  f.store.add(message("b", "a", { reply: { messageId: "a", threadRootMessageId: "a", login: "a", displayName: "a", userId: "" } }));
  f.ui.refresh();
  f.store.add(message("x", "selected", { reply: { messageId: "selected", threadRootMessageId: "a", login: "selected", displayName: "selected", userId: "" } }));
  f.store.add(message("y", "x", { reply: { messageId: "x", threadRootMessageId: "a", login: "x", displayName: "x", userId: "" } }));
  f.ui.refresh();
  assert.ok(f.find("a"));
  assert.ok(f.find("y"));
  assert.equal(f.log.querySelector(".thread-empty"), null);
});

test("fully removed filtered threads show an empty state without exposing a hidden message count", () => {
  const f = fixture(1000, true);
  f.store.add(message("root"));
  f.store.add(message("child", "root"));
  f.ui.open("child");
  assert.equal(f.panel.querySelector(".thread-count").textContent, "0 messages");
  assert.match(f.log.textContent, /hidden by your filters/);
  assert.equal(f.log.textContent.includes("root text"), false);
});
