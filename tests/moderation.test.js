import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatThreadStore } from "../src/chat-thread.ts";
import { ChatSynchronizer } from "../src/chat-sync.ts";
import { applyChatModeration } from "../src/chat-moderation.ts";

function message(id, extra = {}) {
  return { id, login: "alice", userId: "1", displayName: "Alice", color: "", text: "Private text",
    badges: [], emoteTag: "", reply: null, timestamp: 1000, isNotice: false, isAction: false,
    isGigantifiedEmote: false, isFirstMessage: false, ...extra };
}
const notice = (moderation) => message("moderation", { isNotice: true, timestamp: 2000, text: "Deleted", moderation });
function history(messages) {
  const map = new Map(messages.map((item) => [item.id, item]));
  const threads = new ChatThreadStore();
  messages.forEach((item) => threads.add(item));
  return { map, threads };
}

test("a same-frame deletion removes the queued parent and its text from all reply previews", () => {
  const parent = message("parent");
  const child = message("child", { login: "bob", text: "My reply", reply: { messageId: "parent", login: "alice", displayName: "Alice",
    userId: "1", body: "Private text" } });
  const h = history([parent, child]);
  const result = applyChatModeration(notice({ messageId: "parent" }), h.map, [parent, child], h.threads);
  assert.deepEqual(result.pending.map((item) => item.id), ["child"]);
  assert.equal(h.map.has("parent"), false);
  assert.equal(h.map.get("child").reply.body, undefined);
  assert.equal(h.threads.isDeleted("parent"), true);
  assert.equal(JSON.stringify(h.threads.getThread("child")).includes("Private text"), false);
  assert.equal(h.threads.getThread("child").entries.find((entry) => entry.id === "parent").text, null);
});

test("timeouts remove only that user's older messages and scrub unknown parent tags", () => {
  const old = message("old");
  const later = message("later", { timestamp: 3000 });
  const other = message("other", { login: "bob", userId: "2", text: "Other viewer",
    reply: { messageId: "not-retained", login: "alice", displayName: "Alice", userId: "1", body: "Hidden old parent" } });
  const h = history([old, later, other]);
  const result = applyChatModeration(notice({ userId: "1" }), h.map, [old, later, other], h.threads);
  assert.deepEqual(result.pending.map((item) => item.id), ["later", "other"]);
  assert.equal(h.map.has("old"), false);
  assert.equal(h.map.has("later"), true);
  assert.equal(other.reply.body, undefined);
  assert.equal(h.threads.isDeleted("not-retained"), true);
});

test("a full clear removes older messages and notices while keeping later arrivals", () => {
  const old = message("old");
  const oldNotice = message("old-notice", { isNotice: true });
  const later = message("later", { timestamp: 3000 });
  const h = history([old, oldNotice, later]);
  const result = applyChatModeration(notice({ clearAll: true }), h.map, [old, oldNotice, later], h.threads);
  assert.deepEqual([...h.map.keys()], ["later"]);
  assert.deepEqual(result.pending.map((item) => item.id), ["later"]);
  assert.equal(h.threads.get("old"), null);
});

test("exact message deletion cannot accidentally remove all messages by its author", () => {
  const first = message("first");
  const second = message("second");
  const h = history([first, second]);
  const result = applyChatModeration(notice({ messageId: "first", login: "alice" }), h.map, [first, second], h.threads);
  assert.deepEqual(result.pending.map((item) => item.id), ["second"]);
  assert.equal(h.threads.get("second").text, "Private text");
});

test("a timeout scrubs earlier thread parents after their live rows have been trimmed", () => {
  const cached = message("cached");
  const child = message("child", { login: "bob", userId: "2", text: "Reply",
    reply: { messageId: "cached", login: "alice", displayName: "Alice", userId: "1", body: "Private text" } });
  const h = history([cached, child]);
  h.map.delete("cached");
  applyChatModeration(notice({ login: "alice" }), h.map, [], h.threads);
  assert.equal(h.threads.get("cached"), null);
  assert.equal(child.reply.body, undefined);
  assert.equal(JSON.stringify(h.threads.getThread("child")).includes("Private text"), false);
});

test("a selected reply that aged out still cancels when its author is timed out", () => {
  const h = history([]);
  const selected = message("aged-out");
  const result = applyChatModeration(notice({ userId: "1" }), h.map, [], h.threads, selected);
  assert.equal(result.deletedIds.has("aged-out"), true);
  assert.equal(h.threads.isDeleted("aged-out"), true);
});

test("moderation waits for its synchronized video position before changing thread history", () => {
  const h = history([message("parent")]);
  const sync = new ChatSynchronizer();
  sync.configure(true, 0);
  sync.setVideoActive(true);
  sync.enqueue(notice({ messageId: "parent" }), 3000);
  sync.update({ currentTime: 0, bufferedEnd: 1, advancing: true, playingDate: 1500 }, 3000);
  for (const released of sync.drain(3000)) applyChatModeration(released, h.map, [], h.threads);
  assert.equal(h.threads.get("parent").text, "Private text");
  sync.update({ currentTime: 1, bufferedEnd: 2, advancing: true, playingDate: 2500 }, 4000);
  for (const released of sync.drain(4000)) applyChatModeration(released, h.map, [], h.threads);
  assert.equal(h.threads.get("parent"), null);
});

test("dimmed deletion keeps rich message content and marks every queued and visible copy", () => {
  const parent = message("parent", { text: "Kappa [GIF]", badges: ["subscriber/12"], emoteTag: "25:0-4",
    gifTag: "6-10|gifid|https://media4.giphy.com/media/gifid/giphy.gif", noticeText: "Alice subscribed!",
    noticeType: "resub", isAction: true, isGigantifiedEmote: true });
  const child = message("child", { login: "bob", userId: "2", text: "My reply", reply: {
    messageId: "parent", login: "alice", displayName: "Alice", userId: "1", body: "Kappa [GIF]" } });
  const queuedCopy = { ...parent, badges: [...parent.badges] };
  const h = history([parent, child]);
  const result = applyChatModeration(notice({ messageId: "parent" }), h.map, [queuedCopy, child], h.threads, parent, true);
  assert.deepEqual(result.pending.map(({ id }) => id), ["parent", "child"]);
  for (const retained of [parent, queuedCopy, h.map.get("parent"), h.threads.get("parent")]) {
    assert.equal(retained.isDeleted, true);
    assert.equal(retained.deletedAt, 2000);
    assert.equal(retained.text, "Kappa [GIF]");
    assert.deepEqual(retained.badges, ["subscriber/12"]);
    assert.equal(retained.emoteTag, parent.emoteTag);
    assert.equal(retained.gifTag, parent.gifTag);
    assert.equal(retained.noticeText, "Alice subscribed!");
    assert.equal(retained.noticeType, "resub");
    assert.equal(retained.isAction, true);
    assert.equal(retained.isGigantifiedEmote, true);
  }
  assert.equal(h.map.get("child").reply.body, undefined);
  assert.equal(h.threads.getThread("child").entries[0].message.text, "Kappa [GIF]");
  assert.equal(h.threads.getThread("child").entries[0].isDeleted, true);
  assert.equal(result.deletedIds.has("parent"), true);
});

test("dimmed moderation retains same-frame messages that have not entered thread history", () => {
  const old = message("pending-old");
  const later = message("pending-later", { timestamp: 3000 });
  const h = history([]);
  const result = applyChatModeration(notice({ userId: "1" }), h.map, [old, later], h.threads, null, true);
  assert.deepEqual(result.pending.map(({ id }) => id), ["pending-old", "pending-later"]);
  assert.equal(old.isDeleted, true);
  assert.equal(later.isDeleted, undefined);
  assert.equal(h.threads.get("pending-old").isDeleted, true);
  assert.equal(h.threads.get("pending-old").text, "Private text");
});

test("dimmed timeouts keep older user messages but scrub unknown parent previews", () => {
  const old = message("old");
  const later = message("later", { timestamp: 3000 });
  const other = message("other", { login: "bob", userId: "2", text: "Other viewer", reply: {
    messageId: "not-retained", login: "alice", displayName: "Alice", userId: "1", body: "Hidden old parent" } });
  const h = history([old, later, other]);
  applyChatModeration(notice({ userId: "1" }), h.map, [], h.threads, null, true);
  assert.equal(h.map.get("old").isDeleted, true);
  assert.equal(h.map.get("later").isDeleted, undefined);
  assert.equal(h.map.get("other").isDeleted, undefined);
  assert.equal(other.reply.body, undefined);
  assert.equal(h.threads.isDeleted("not-retained"), true);
  assert.equal(h.threads.get("not-retained"), null);
  assert.equal(JSON.stringify(h.threads.getThread("other")).includes("Hidden old parent"), false);
});

test("dimmed full clears retain earlier bodies while removing stale notices and preserving later arrivals", () => {
  const old = message("old");
  const oldNotice = message("old-notice", { isNotice: true });
  const later = message("later", { timestamp: 3000 });
  const h = history([old, oldNotice, later]);
  const result = applyChatModeration(notice({ clearAll: true }), h.map, [old, oldNotice, later], h.threads, null, true);
  assert.deepEqual([...h.map.keys()], ["old", "later"]);
  assert.deepEqual(result.pending.map(({ id }) => id), ["old", "later"]);
  assert.equal(h.threads.get("old").isDeleted, true);
  assert.equal(later.isDeleted, undefined);
});

test("dimmed moderation still waits for its synchronized video position", () => {
  const h = history([message("parent")]);
  const sync = new ChatSynchronizer();
  sync.configure(true, 0);
  sync.setVideoActive(true);
  sync.enqueue(notice({ messageId: "parent" }), 3000);
  sync.update({ currentTime: 0, bufferedEnd: 1, advancing: true, playingDate: 1500 }, 3000);
  for (const released of sync.drain(3000)) applyChatModeration(released, h.map, [], h.threads, null, true);
  assert.equal(h.threads.get("parent").isDeleted, undefined);
  sync.update({ currentTime: 1, bufferedEnd: 2, advancing: true, playingDate: 2500 }, 4000);
  for (const released of sync.drain(4000)) applyChatModeration(released, h.map, [], h.threads, null, true);
  assert.equal(h.threads.get("parent").isDeleted, true);
  assert.equal(h.threads.get("parent").text, "Private text");
});
