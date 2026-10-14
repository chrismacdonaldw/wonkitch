import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { JSDOM } from "jsdom";
import { TwitchChat } from "../src/chat.ts";
import { ChatSynchronizer } from "../src/chat-sync.ts";
import { appendRichText, EmoteCatalog } from "../src/emotes.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const originalGlobals = new Map();
const catalog = new EmoteCatalog();

class FakeWebSocket {
  static instances = [];
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;

  constructor() {
    FakeWebSocket.instances.push(this);
  }

  send() {}
  close() { this.onclose?.({}); }
}

before(() => {
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    Node: dom.window.Node,
    HTMLElement: dom.window.HTMLElement,
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
    return messages;
  } finally {
    chat.disconnect();
  }
}

function receiveNotice(body, tags = "") {
  const trailing = body === undefined ? "" : ` :${body}`;
  return receiveIrc(`@id=sub-event;login=viewer;display-name=Viewer;msg-id=resub;system-msg=Viewer\\ssubscribed!;${tags} :tmi.twitch.tv USERNOTICE #example${trailing}`);
}

test("subscription messages retain the author, system header and all rich-body metadata in one event", () => {
  for (const type of ["sub", "resub"]) {
    const timestamp = 1_780_000_000_123;
    const [message, duplicate] = receiveNotice("Kappa Thanks for the streams!", `msg-id=${type};user-id=42;color=#008000;badges=moderator/1,subscriber/12;emotes=25:0-4;tmi-sent-ts=${timestamp}`);
    assert.equal(duplicate, undefined);
    assert.equal(message.id, "sub-event");
    assert.equal(message.userId, "42");
    assert.equal(message.login, "viewer");
    assert.equal(message.displayName, "Viewer");
    assert.equal(message.color, "#008000");
    assert.deepEqual(message.badges, ["moderator/1", "subscriber/12"]);
    assert.equal(message.text, "Kappa Thanks for the streams!");
    assert.equal(message.noticeText, "Viewer subscribed!");
    assert.equal(message.noticeType, type);
    assert.equal(message.emoteTag, "25:0-4");
    assert.equal(message.timestamp, timestamp);
    assert.equal(message.isNotice, false);
    assert.equal(message.reply, null);

    const target = document.createElement("div");
    assert.equal(appendRichText(target, message.text, message.emoteTag, catalog), 1);
    assert.equal(target.querySelector(".chat-emote").alt, "Kappa");
    assert.equal(target.textContent, " Thanks for the streams!");
  }
});

test("header-only subscription and gift alerts never acquire a phantom channel or empty body", () => {
  for (const type of ["sub", "resub", "subgift", "submysterygift"]) {
    for (const body of [undefined, "", "   "]) {
      const messages = receiveNotice(body, `msg-id=${type};emotes=25:0-4;reply-parent-msg-id=parent`);
      assert.equal(messages.length, 1);
      const [message] = messages;
      assert.equal(message.id, "sub-event");
      assert.equal(message.text, "Viewer subscribed!");
      assert.equal(message.isNotice, true);
      assert.equal(message.login, "");
      assert.equal(message.emoteTag, "");
      assert.equal(message.reply, null);
      assert.equal(message.noticeText, undefined);
    }
  }
});

test("a USERNOTICE's user body remains visible when Twitch omits the system header", () => {
  for (const type of ["resub", "modiversary", "viewermilestone", "announcement", "sharedchatnotice"]) {
    const messages = receiveNotice("Glad to be here", `system-msg=;msg-id=${type}`);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].text, "Glad to be here");
    assert.equal(messages[0].noticeType, type);
    assert.equal(messages[0].noticeText, undefined);
    assert.equal(messages[0].isNotice, false);
  }
  assert.deepEqual(receiveNotice(undefined, "system-msg="), []);
  assert.deepEqual(receiveNotice("", "system-msg="), []);
});

test("IRC tag escapes do not modify literal user body text, including markup and backslashes", () => {
  const [message] = receiveNotice(String.raw`<img src=x onerror=alert(1)> \s <3`, String.raw`display-name=星のViewer\s\:friend;system-msg=Viewer\ssubscribed\:\s12\smonths!`);
  assert.equal(message.displayName, "星のViewer ;friend");
  assert.equal(message.noticeText, "Viewer subscribed; 12 months!");
  assert.equal(message.text, String.raw`<img src=x onerror=alert(1)> \s <3`);
  const target = document.createElement("div");
  appendRichText(target, message.text, message.emoteTag, catalog);
  assert.equal(target.querySelector("img, script"), null);
  assert.equal(target.textContent, message.text);
});

test("subscription actions retain emote offsets and GIF metadata without using the Twitch server as author", () => {
  const gifTag = "6-13|gif-id|https://media4.giphy.com/media/gif-id/giphy.gif?cid=twitch&rid=giphy.gif&ct=g";
  const [message] = receiveNotice("\u0001ACTION Kappa [Hi GIF]\u0001", `emotes=25:0-4;gifs=${gifTag}`);
  assert.equal(message.isAction, true);
  assert.equal(message.text, "Kappa [Hi GIF]");
  assert.equal(message.emoteTag, "25:0-4");
  assert.equal(message.gifTag, gifTag);
  assert.equal(message.login, "viewer");
  const [missingLogin] = receiveNotice("Hello", "login=;display-name=DisplayOnly");
  assert.equal(missingLogin.login, "unknown");
  assert.equal(missingLogin.displayName, "DisplayOnly");
  assert.notEqual(missingLogin.login, "tmi.twitch.tv");
});

test("subscription header and user message cross the video's chat delay together exactly once", () => {
  const timestamp = 1_780_000_000_000;
  const messages = receiveNotice("Thanks for a great year", `tmi-sent-ts=${timestamp}`);
  const sync = new ChatSynchronizer();
  sync.setVideoActive(true);
  for (const message of messages) sync.enqueue(message, timestamp + 12_000);
  sync.update({ currentTime: 10, bufferedEnd: 22, playingDate: timestamp - 1_000, advancing: true }, timestamp + 12_000);
  assert.deepEqual(sync.drain(timestamp + 12_000), []);
  sync.update({ currentTime: 11, bufferedEnd: 23, playingDate: timestamp, advancing: true }, timestamp + 13_000);
  const displayed = sync.drain(timestamp + 13_000);
  assert.equal(displayed.length, 1);
  assert.equal(displayed[0].noticeText, "Viewer subscribed!");
  assert.equal(displayed[0].text, "Thanks for a great year");
  assert.deepEqual(sync.drain(timestamp + 14_000), []);
});

test("CLEARMSG emits one timed moderation notice without leaking the deleted message body", () => {
  const timestamp = 1_780_000_000_456;
  const deletedBody = "private deleted text <img src=x> Kappa";
  const messages = receiveIrc(`@login=viewer;target-msg-id=removed-message;tmi-sent-ts=${timestamp};emotes=25:32-36;reply-parent-msg-id=older :tmi.twitch.tv CLEARMSG #example :${deletedBody}`);
  assert.equal(messages.length, 1);
  const [notice] = messages;
  assert.equal(notice.isNotice, true);
  assert.equal(notice.timestamp, timestamp);
  assert.deepEqual(notice.moderation, { messageId: "removed-message", login: "viewer" });
  assert.equal(notice.text, "A message was deleted by a moderator.");
  assert.equal(notice.login, "");
  assert.equal(notice.emoteTag, "");
  assert.equal(notice.reply, null);
  assert.equal(JSON.stringify(notice).includes(deletedBody), false);
});

test("CLEARMSG without a target message ID never falls back to deleting all messages from its author", () => {
  for (const targetTag of ["", ";target-msg-id="]) {
    const messages = receiveIrc(`@login=viewer${targetTag} :tmi.twitch.tv CLEARMSG #example :removed text`);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].moderation, undefined);
    assert.equal(messages[0].isNotice, true);
    assert.equal(messages[0].text.includes("removed text"), false);
  }
});

test("CLEARCHAT distinguishes a timeout or ban target from the channel parameter", () => {
  const timestamp = 1_780_000_000_789;
  for (const [duration, expected] of [
    ["", "viewer was removed from chat."],
    [";ban-duration=350", "viewer was timed out for 350s."],
  ]) {
    const messages = receiveIrc(`@target-user-id=42;tmi-sent-ts=${timestamp}${duration} :tmi.twitch.tv CLEARCHAT #example :viewer`);
    assert.equal(messages.length, 1);
    const [notice] = messages;
    assert.equal(notice.isNotice, true);
    assert.equal(notice.timestamp, timestamp);
    assert.equal(notice.text, expected);
    assert.deepEqual(notice.moderation, { login: "viewer", userId: "42" });
  }
  const [loginOnly] = receiveIrc(":tmi.twitch.tv CLEARCHAT #example :viewer");
  assert.deepEqual(loginOnly.moderation, { login: "viewer" });
  const [idOnly] = receiveIrc("@target-user-id=42 :tmi.twitch.tv CLEARCHAT #example");
  assert.deepEqual(idOnly.moderation, { userId: "42" });
  assert.equal(idOnly.text, "A user was removed from chat.");
});

test("a channel-wide CLEARCHAT marks the full clear and never treats #channel as a chatter", () => {
  for (const trailing of ["", " :"]) {
    const messages = receiveIrc(`@room-id=12345678;tmi-sent-ts=1780000000123 :tmi.twitch.tv CLEARCHAT #example${trailing}`);
    assert.equal(messages.length, 1);
    const [notice] = messages;
    assert.deepEqual(notice.moderation, { clearAll: true });
    assert.equal(notice.text, "Chat was cleared by a moderator.");
    assert.equal(notice.timestamp, 1_780_000_000_123);
    assert.equal(notice.text.includes("#example"), false);
  }
});

test("moderation follows the same video clock as messages and reaches consumers only once", () => {
  const timestamp = 1_780_000_000_000;
  const [notice] = receiveIrc(`@login=viewer;target-msg-id=removed;tmi-sent-ts=${timestamp} :tmi.twitch.tv CLEARMSG #example :deleted`);
  const sync = new ChatSynchronizer();
  sync.setVideoActive(true);
  sync.enqueue(notice, timestamp + 12_000);
  sync.update({ currentTime: 10, bufferedEnd: 22, playingDate: timestamp - 1_000, advancing: true }, timestamp + 12_000);
  assert.deepEqual(sync.drain(timestamp + 12_000), []);
  sync.update({ currentTime: 11, bufferedEnd: 23, playingDate: timestamp, advancing: true }, timestamp + 13_000);
  const displayed = sync.drain(timestamp + 13_000);
  assert.equal(displayed.length, 1);
  assert.deepEqual(displayed[0].moderation, { messageId: "removed", login: "viewer" });
  assert.deepEqual(sync.drain(timestamp + 14_000), []);
});
