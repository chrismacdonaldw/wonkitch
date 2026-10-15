import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { ChatConnectionStatus } from "../src/chat-connection-status.ts";

const cleanup = [];
afterEach(() => { while (cleanup.length) cleanup.pop()(); });

function fixture() {
  const dom = new JSDOM(readFileSync(new URL("../index.html", import.meta.url), "utf8"));
  const { document } = dom.window;
  const status = document.querySelector("#chat-status");
  const dot = document.querySelector("#chat-dot");
  const banner = document.querySelector("#chat-connection-banner");
  const message = document.querySelector("#chat-connection-message");
  const retry = document.querySelector("#chat-retry");
  const log = document.querySelector("#chat-log");
  const thread = document.querySelector("#reply-thread");
  const threadLog = thread.querySelector(".thread-log");
  let retries = 0;
  const ui = new ChatConnectionStatus({
    status, dot, banner, message, retry,
    focusTarget: () => thread.hidden ? log : threadLog,
  }, () => { retries++; });
  cleanup.push(() => { ui.dispose(); dom.window.close(); });
  return { document, status, dot, banner, message, retry, log, thread, threadLog, ui, retries: () => retries };
}

test("chat reports connecting, reconnecting, and waiting above the messages with an accessible retry", () => {
  const f = fixture();
  const expected = {
    connecting: "Connecting to chat…",
    reconnecting: "Reconnecting to chat…",
    waiting: "Waiting for internet…",
  };
  for (const [state, message] of Object.entries(expected)) {
    f.ui.update(state);
    assert.equal(f.status.textContent, state);
    assert.equal(f.status.title, message);
    assert.equal(f.status.parentElement.dataset.state, state);
    assert.equal(f.banner.hidden, false);
    assert.equal(f.banner.dataset.state, state);
    assert.equal(f.message.textContent, message);
    assert.equal(f.dot.classList.contains("active"), false);
    f.retry.click();
  }
  assert.equal(f.retries(), 3);
  assert.equal(f.message.getAttribute("role"), "status");
  assert.equal(f.message.getAttribute("aria-live"), "polite");
  assert.equal(f.message.getAttribute("aria-atomic"), "true");
  assert.equal(f.retry.type, "button");
  assert.equal(f.banner.closest(".chat-head"), f.document.querySelector(".chat-head"));
  assert.equal(f.log.contains(f.banner), false, "connection feedback must not enter the video-delayed chat log");
});

test("connected and intentional offline states hide retry and keep the header accurate", () => {
  const f = fixture();
  for (const state of ["connected", "offline"]) {
    f.ui.update("reconnecting");
    f.ui.update(state);
    assert.equal(f.status.textContent, state);
    assert.equal(f.dot.classList.contains("active"), state === "connected");
    assert.equal(f.banner.hidden, true);
    assert.equal(f.message.textContent, "");
    f.retry.click();
  }
  assert.equal(f.retries(), 0);
});

test("connection updates preserve message nodes, thread contents, scroll position, and composer draft", () => {
  const f = fixture();
  const row = f.document.createElement("article");
  row.textContent = "Already received message";
  f.log.append(row);
  const threadRow = f.document.createElement("article");
  threadRow.textContent = "Existing reply";
  f.threadLog.append(threadRow);
  const input = f.document.querySelector("#chat-input");
  input.value = "Unsent reply";
  input.focus();
  f.log.scrollTop = 125;
  for (const state of ["reconnecting", "waiting", "reconnecting", "connected"]) f.ui.update(state);
  assert.equal(f.log.firstElementChild, row);
  assert.equal(f.threadLog.firstElementChild, threadRow);
  assert.equal(f.log.scrollTop, 125);
  assert.equal(input.value, "Unsent reply");
  assert.equal(f.document.activeElement, input);
});

test("retry focus returns to the active conversation when the connection recovers", () => {
  const f = fixture();
  for (const threadOpen of [false, true]) {
    f.thread.hidden = !threadOpen;
    f.ui.update("reconnecting");
    f.retry.focus();
    assert.equal(f.document.activeElement, f.retry);
    f.ui.update("connected");
    assert.equal(f.document.activeElement, threadOpen ? f.threadLog : f.log);
  }
});

test("repeated states preserve the announcement text and disposing disables the retry callback", () => {
  const f = fixture();
  f.ui.update("reconnecting");
  const announcement = f.message.firstChild;
  f.ui.update("reconnecting");
  assert.equal(f.message.firstChild, announcement, "unchanged states should not repeat live announcements");
  f.ui.dispose();
  f.retry.click();
  assert.equal(f.retries(), 0);
});
