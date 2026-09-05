import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { JSDOM } from "jsdom";
import { TwitchChat } from "../src/chat.ts";
import { createReplyContext } from "../src/chat-reply.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const originalGlobals = new Map();

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

before(() => {
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    WebSocket: FakeWebSocket,
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
  return receiveIrc(`@id=reply-message;display-name=Viewer;${tags} :viewer!viewer@viewer.tmi.twitch.tv PRIVMSG #example :${text}`);
}

test("incoming IRC replies identify their parent without needing the parent in chat history", () => {
  const message = receiveChat("@alice I agree", "reply-parent-msg-id=older-message;reply-parent-user-id=42;reply-parent-user-login=alice;reply-parent-display-name=Alice;reply-parent-msg-body=An\\searlier\\smessage");
  assert.deepEqual(message.reply, {
    messageId: "older-message",
    userId: "42",
    login: "alice",
    displayName: "Alice",
  });
  assert.equal(message.text, "@alice I agree");
  const context = createReplyContext(message.reply);
  assert.equal(context.className, "message-reply");
  assert.equal(context.textContent, "↪ Replying to @Alice");
  assert.equal(context.querySelector(".message-reply-label").title, "@alice");
  assert.equal(context.querySelector(".message-reply-arrow").getAttribute("aria-hidden"), "true");
  assert.equal(context.textContent.includes("An earlier message"), false);
});

test("nested replies refer to the direct parent rather than the original thread author", () => {
  const message = receiveChat("That makes sense", "reply-parent-msg-id=direct-message;reply-parent-user-id=20;reply-parent-user-login=bob;reply-parent-display-name=Bob;reply-thread-parent-msg-id=original-message;reply-thread-parent-user-id=10;reply-thread-parent-user-login=alice;reply-thread-parent-display-name=Alice");
  assert.deepEqual(message.reply, {
    messageId: "direct-message",
    userId: "20",
    login: "bob",
    displayName: "Bob",
  });
  assert.equal(createReplyContext(message.reply).textContent, "↪ Replying to @Bob");
});

test("reply names use existing IRC tag unescaping and preserve Unicode", () => {
  const message = receiveChat("hello", String.raw`reply-parent-msg-id=parent;reply-parent-user-login=alice;reply-parent-display-name=星のAlice\s\:me\\you`);
  assert.equal(message.reply.displayName, "星のAlice ;me\\you");
  assert.equal(createReplyContext(message.reply).textContent, "↪ Replying to @星のAlice ;me\\you");
});

test("missing reply display names fall back to login and fully missing names remain readable", () => {
  for (const displayNameTag of ["", ";reply-parent-display-name="]) {
    const message = receiveChat("hello", `reply-parent-msg-id=parent;reply-parent-user-login=alice${displayNameTag}`);
    assert.equal(message.reply.displayName, "alice");
    const context = createReplyContext(message.reply);
    assert.equal(context.textContent, "↪ Replying to @alice");
    assert.equal(context.querySelector(".message-reply-label").hasAttribute("title"), false);
  }
  const missingNames = receiveChat("hello", "reply-parent-msg-id=parent");
  assert.deepEqual(missingNames.reply, { messageId: "parent", userId: "", login: "", displayName: "" });
  assert.equal(createReplyContext(missingNames.reply).textContent, "↪ Replying to a user");
  const displayOnly = receiveChat("hello", "reply-parent-msg-id=parent;reply-parent-display-name=Alice");
  assert.equal(createReplyContext(displayOnly.reply).textContent, "↪ Replying to @Alice");
});

test("mentions and incomplete or thread-only tags do not turn ordinary messages into replies", () => {
  for (const tags of [
    "",
    "reply-parent-msg-id=;reply-parent-user-login=alice;reply-parent-display-name=Alice",
    "reply-parent-user-id=42;reply-parent-user-login=alice;reply-parent-display-name=Alice",
    "reply-thread-parent-msg-id=original;reply-thread-parent-user-login=alice",
  ]) {
    assert.equal(receiveChat("@alice hello", tags).reply, null, tags);
  }
});

test("reply names are rendered as literal text without creating markup", () => {
  const message = receiveChat("hello", String.raw`reply-parent-msg-id=parent;reply-parent-user-login=<script>;reply-parent-display-name=<img\ssrc=x\sonerror=alert(1)>`);
  const context = createReplyContext(message.reply);
  assert.equal(context.textContent, "↪ Replying to @<img src=x onerror=alert(1)>");
  assert.equal(context.querySelector(".message-reply-label").title, "@<script>");
  assert.equal(context.querySelector("img, script"), null);
});

test("action and emote metadata coexist with incoming reply context", () => {
  const message = receiveChat("\u0001ACTION Kappa\u0001", "reply-parent-msg-id=parent;reply-parent-user-login=alice;emotes=25:0-4;msg-id=gigantified-emote-message");
  assert.equal(message.text, "Kappa");
  assert.equal(message.isAction, true);
  assert.equal(message.isGigantifiedEmote, true);
  assert.equal(message.emoteTag, "25:0-4");
  assert.equal(createReplyContext(message.reply).textContent, "↪ Replying to @alice");
});

test("system notices never acquire reply context", () => {
  for (const line of [
    "@reply-parent-msg-id=parent;reply-parent-user-login=alice :tmi.twitch.tv NOTICE #example :A notice",
    "@reply-parent-msg-id=parent;system-msg=Viewer\\ssubscribed :tmi.twitch.tv USERNOTICE #example",
  ]) {
    const message = receiveIrc(line);
    assert.equal(message.isNotice, true);
    assert.equal(message.reply, null);
  }
});
