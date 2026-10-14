import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatThreadStore } from "../src/chat-thread.ts";

function message(id, overrides = {}) {
  return {
    id,
    login: id,
    displayName: id.toUpperCase(),
    color: "",
    text: `Text from ${id}`,
    badges: [],
    emoteTag: "",
    isGigantifiedEmote: false,
    reply: null,
    timestamp: 1000,
    isAction: false,
    isNotice: false,
    isFirstMessage: false,
    ...overrides,
  };
}

function reply(parentId, overrides = {}) {
  return { messageId: parentId, userId: "", login: parentId, displayName: parentId.toUpperCase(), ...overrides };
}

test("threads retain a full root, nested direct parents, and sibling replies", () => {
  const store = new ChatThreadStore();
  store.add(message("root"));
  store.add(message("first", { reply: reply("root"), timestamp: 2000 }));
  store.add(message("nested", { reply: reply("first", { threadRootMessageId: "root" }), timestamp: 3000 }));
  store.add(message("sibling", { reply: reply("root"), timestamp: 2500 }));
  store.add(message("unrelated"));
  const snapshot = store.getThread("nested");
  assert.equal(snapshot.rootId, "root");
  assert.deepEqual(snapshot.entries.map(({ id, parentId }) => [id, parentId]), [
    ["root", null], ["first", "root"], ["sibling", "root"], ["nested", "first"],
  ]);
  assert.ok(snapshot.entries.every((entry) => entry.message && !entry.isMissing && !entry.isDeleted));
  assert.deepEqual(store.getThread("root"), snapshot);
});

test("replies predating local history supply direct-parent body and oldest-author fallback", () => {
  const store = new ChatThreadStore();
  store.add(message("nested", { reply: reply("parent", {
    body: "Earlier text <script> stays literal",
    threadRootMessageId: "root",
    threadRootLogin: "alice",
    threadRootDisplayName: "Alice",
  }), timestamp: 3000 }));
  const snapshot = store.getThread("nested");
  assert.equal(snapshot.rootId, "root");
  assert.deepEqual(snapshot.entries.map(({ id, parentId }) => [id, parentId]), [["root", null], ["parent", "root"], ["nested", "parent"]]);
  assert.equal(snapshot.entries[0].displayName, "Alice");
  assert.equal(snapshot.entries[0].text, null);
  assert.equal(snapshot.entries[0].isMissing, true);
  assert.equal(snapshot.entries[1].text, "Earlier text <script> stays literal");
  assert.deepEqual(store.getThread("parent"), snapshot);
  assert.deepEqual(store.getThread("root"), snapshot);
});

test("out-of-order parents rebuild placeholder ancestry and merge formerly separate threads", () => {
  const store = new ChatThreadStore();
  store.add(message("child", { reply: reply("parent", { body: "Parent from tags" }), timestamp: 3000 }));
  assert.equal(store.getThread("child").rootId, "parent");
  assert.equal(store.getThread("child").entries[0].text, "Parent from tags");
  store.add(message("parent", { reply: reply("root"), timestamp: 2000 }));
  store.add(message("root", { timestamp: 1000 }));
  const snapshot = store.getThread("child");
  assert.equal(snapshot.rootId, "root");
  assert.deepEqual(snapshot.entries.map(({ id }) => id), ["root", "parent", "child"]);
  assert.equal(snapshot.entries[1].message.text, "Text from parent");
  assert.equal(snapshot.entries[1].isMissing, false);
});

test("configured history bounds retained content while old roots remain readable placeholders", () => {
  const store = new ChatThreadStore(2);
  store.add(message("root"));
  store.add(message("first", { reply: reply("root", { body: "Original root" }), timestamp: 2000 }));
  store.add(message("second", { reply: reply("root", { body: "Original root" }), timestamp: 3000 }));
  assert.equal(store.size, 2);
  assert.equal(store.get("root"), null);
  const snapshot = store.getThread("root");
  assert.equal(snapshot.entries[0].isMissing, true);
  assert.equal(snapshot.entries[0].text, "Original root");
  assert.deepEqual(snapshot.entries.map(({ id }) => id), ["root", "first", "second"]);
  store.limit(1);
  assert.equal(store.size, 1);
  assert.deepEqual(store.getThread("root").entries.map(({ id }) => id), ["root", "second"]);
});

test("deletion scrubs cached parent content and prevents tag bodies or delayed re-additions restoring it", () => {
  const store = new ChatThreadStore();
  store.add(message("root", { text: "Deleted secret" }));
  store.add(message("child", { reply: reply("root", { body: "Deleted secret" }) }));
  store.remove("root");
  store.add(message("root", { text: "Deleted secret" }));
  assert.equal(store.get("root"), null);
  const root = store.getThread("child").entries[0];
  assert.equal(root.message, null);
  assert.equal(root.text, null);
  assert.equal(root.isDeleted, true);
  assert.equal(root.isMissing, false);
  assert.equal(root.displayName, "ROOT");
  assert.equal(JSON.stringify(store.getThread("root")).includes("Deleted secret"), false);
  assert.equal(store.isDeleted("root"), true);
});

test("a deleted unseen direct parent is identified without exposing its tag preview", () => {
  const store = new ChatThreadStore();
  store.remove("parent");
  store.add(message("child", { reply: reply("parent", { body: "Hidden secret", threadRootMessageId: "root" }) }));
  const parent = store.getThread("parent").entries.find(({ id }) => id === "parent");
  assert.equal(parent.isDeleted, true);
  assert.equal(parent.text, null);
  assert.equal(parent.displayName, "PARENT");
});

test("evicting a deletion tombstone cannot restore body text retained in a child's reply tags", () => {
  const store = new ChatThreadStore(2);
  store.add(message("root", { text: "Deleted secret" }));
  store.add(message("child", { reply: reply("root", { body: "Deleted secret" }) }));
  store.remove("root");
  store.add(message("unrelated"));
  assert.equal(store.isDeleted("root"), false);
  const root = store.getThread("child").entries[0];
  assert.equal(root.isMissing, true);
  assert.equal(root.text, null);
  assert.equal(JSON.stringify(store.getThread("child")).includes("Deleted secret"), false);
});

test("deleted intermediates retain relationships between the root and surviving replies", () => {
  const store = new ChatThreadStore();
  store.add(message("root"));
  store.add(message("parent", { reply: reply("root"), timestamp: 2000 }));
  store.add(message("child", { reply: reply("parent"), timestamp: 3000 }));
  store.remove("parent");
  const snapshot = store.getThread("child");
  assert.equal(snapshot.rootId, "root");
  assert.equal(snapshot.entries.find(({ id }) => id === "parent").parentId, "root");
  assert.equal(snapshot.entries.find(({ id }) => id === "child").parentId, "parent");
});

test("clearing between channels removes all known messages and reconstructed placeholders", () => {
  const store = new ChatThreadStore();
  store.add(message("child", { reply: reply("root", { body: "Old channel" }) }));
  store.clear();
  store.add(message("new-channel"));
  assert.equal(store.get("child"), null);
  assert.equal(store.getThread("root"), null);
  assert.equal(store.getThread("child"), null);
  assert.equal(store.size, 1);
});

test("duplicate rows never grow history and getters isolate mutable caller data", () => {
  const store = new ChatThreadStore(2);
  const child = message("child", { badges: ["subscriber/1"], reply: reply("parent", { body: "Original" }) });
  store.add(child);
  store.add(child);
  child.badges.push("moderator/1");
  child.reply.body = "Changed";
  assert.equal(store.size, 1);
  assert.deepEqual(store.get("child").badges, ["subscriber/1"]);
  const snapshot = store.getThread("child");
  snapshot.entries[0].text = "Changed snapshot";
  snapshot.entries[1].message.badges.push("vip/1");
  store.get("child").reply.body = "Changed getter";
  assert.equal(store.getThread("child").entries[0].text, "Original");
  assert.deepEqual(store.get("child").badges, ["subscriber/1"]);
});

test("values exposes all retained normal messages as isolated copies without deleted entries", () => {
  const store = new ChatThreadStore();
  store.add(message("root"));
  store.add(message("child", { badges: ["subscriber/1"], reply: reply("root", { body: "Root text" }) }));
  store.add(message("deleted"));
  store.remove("deleted");
  const values = store.values();
  assert.deepEqual(values.map(({ id }) => id), ["root", "child"]);
  values[0].text = "Changed text";
  values[1].badges.push("moderator/1");
  values[1].reply.body = "Changed reply";
  values.pop();
  assert.equal(store.get("root").text, "Text from root");
  assert.deepEqual(store.get("child").badges, ["subscriber/1"]);
  assert.equal(store.get("child").reply.body, "Root text");
  assert.equal(store.values().length, 2);
});

test("malformed cyclic reply metadata cannot loop and unrelated chats stay separate", () => {
  const store = new ChatThreadStore();
  store.add(message("a", { reply: reply("b") }));
  store.add(message("b", { reply: reply("a") }));
  store.add(message("unrelated"));
  assert.equal(store.getThread("a").rootId, "a");
  assert.deepEqual(store.getThread("b").entries.map(({ id }) => id), ["a", "b"]);
  assert.equal(store.getThread("unknown"), null);
  assert.equal(store.getThread("") , null);
});

test("notices and empty message IDs do not crowd out conversation history", () => {
  const store = new ChatThreadStore(1);
  store.add(message("root"));
  store.add(message("notice", { isNotice: true }));
  store.add(message(""));
  assert.equal(store.size, 1);
  assert.equal(store.getThread("root").entries[0].message.id, "root");
});

test("tombstones obey the same bound and invalid capacity values remain finite", () => {
  const store = new ChatThreadStore(2);
  store.remove("first");
  store.remove("second");
  store.remove("third");
  assert.equal(store.size, 2);
  store.limit(0);
  assert.equal(store.size, 1);
  store.limit(Infinity);
  for (let index = 0; index < 1200; index++) store.add(message(`row-${index}`));
  assert.equal(store.size, 1000);
});
