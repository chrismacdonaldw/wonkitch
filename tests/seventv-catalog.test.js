import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { EmoteCatalog } from "../src/emotes.ts";

const globalUrl = "https://7tv.io/v3/emote-sets/global";
const channelUrl = "https://7tv.io/v3/users/twitch/42";
const providers = { ffz: true, bttv: true, sevenTv: true };
const originalFetch = globalThis.fetch;
let responses;
let requests;

function emote(name, id = name, flags = 0) {
  return {
    id,
    name,
    flags,
    data: {
      name: `Original_${name}`,
      host: {
        url: `//cdn.example/${id}`,
        files: [{ name: "1x.webp", format: "WEBP" }, { name: "4x.webp", format: "WEBP" }],
      },
    },
  };
}

function set(id, entries) {
  return { id, emotes: entries };
}

function connection(entries, setId = "room-set", userId = "seventv-user") {
  return {
    id: "42",
    emote_set_id: setId,
    emote_set: set(setId, entries),
    user: { id: userId },
  };
}

function response(json, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => json };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  requests = [];
  responses = new Map([
    [globalUrl, response(set("global-set", [emote("GlobalOld"), emote("Shared", "global-shared")]))],
    [channelUrl, response(connection([emote("RoomOld", "old", 1), emote("Shared", "channel-shared")]))],
    ["https://api.frankerfacez.com/v1/set/global", response({
      default_sets: [1],
      sets: { 1: { emoticons: [{ name: "FfzGlobal", urls: { 1: "//cdn.example/ffz-global" } }] } },
    })],
    ["https://api.frankerfacez.com/v1/room/id/42", response({
      room: { set: 2 },
      sets: { 2: { emoticons: [
        { name: "FfzRoom", urls: { 1: "//cdn.example/ffz-room" } },
        { name: "Shared", urls: { 1: "//cdn.example/ffz-shared" } },
      ] } },
    })],
    ["https://api.betterttv.net/3/cached/emotes/global", response([{ code: "BttvGlobal", id: "bttv-global" }])],
    ["https://api.betterttv.net/3/cached/users/twitch/42", response({
      channelEmotes: [{ code: "BttvRoom", id: "bttv-room" }, { code: "Shared", id: "bttv-shared" }],
    })],
  ]);
  globalThis.fetch = async (url) => {
    requests.push(url);
    assert.ok(responses.has(url), `Unexpected request: ${url}`);
    const result = responses.get(url);
    return typeof result === "function" ? result() : result;
  };
});

afterEach(() => { globalThis.fetch = originalFetch; });

async function catalogFixture() {
  const catalog = new EmoteCatalog();
  await catalog.load("42", providers);
  // Restore the baseline global set even if an earlier test refreshed the shared cache.
  await catalog.refreshSevenTv();
  requests.length = 0;
  return catalog;
}

test("7TV metadata uses the nested user ID and returns an independent subscription snapshot", async () => {
  const catalog = await catalogFixture();
  assert.deepEqual(catalog.sevenTvSubscription, {
    setIds: ["global-set", "room-set"], userId: "seventv-user",
  });
  assert.equal(catalog.sevenTvRefreshIncomplete, false);
  catalog.sevenTvSubscription.setIds.push("mutated");
  assert.deepEqual(catalog.sevenTvSubscription.setIds, ["global-set", "room-set"]);
  assert.equal(catalog.find("Shared").url, "https://cdn.example/channel-shared/1x.webp");
  assert.equal(catalog.find("RoomOld").zeroWidth, true);
  assert.equal(catalog.find("RoomOld").previewUrl, "https://cdn.example/old/4x.webp");
  assert.equal(catalog.find("Original_RoomOld"), undefined);
});

test("7TV refresh adds, removes, renames aliases and follows an active set change", async () => {
  const catalog = await catalogFixture();
  responses.set(channelUrl, response(connection([
    emote("NewAlias", "old", 1), emote("FreshEmote", "fresh"),
  ], "replacement-set")));
  assert.equal(await catalog.refreshSevenTv(), true);
  assert.equal(catalog.find("RoomOld"), undefined);
  assert.equal(catalog.find("NewAlias").url, "https://cdn.example/old/1x.webp");
  assert.equal(catalog.find("NewAlias").zeroWidth, true);
  assert.equal(catalog.find("FreshEmote").provider, "7TV");
  assert.equal(catalog.find("Shared").provider, "BTTV");
  assert.deepEqual(catalog.sevenTvSubscription.setIds, ["global-set", "replacement-set"]);
  assert.equal(catalog.search("fresh")[0].name, "FreshEmote");
  assert.equal(catalog.list("7TV").some((entry) => entry.name === "RoomOld"), false);
});

test("refresh bypasses cached 7TV globals while preserving all other providers and Twitch emotes", async () => {
  const catalog = await catalogFixture();
  const native = { name: "Kappa", url: "https://cdn.example/native", provider: "TWITCH", zeroWidth: false, overlayX: 0, overlayY: 0 };
  catalog.setTwitchEmotes([native]);
  const ffz = catalog.list("FFZ");
  const bttv = catalog.list("BTTV");
  responses.set(globalUrl, response(set("new-global", [emote("GlobalNew")])));
  assert.equal(await catalog.refreshSevenTv(), true);
  assert.deepEqual(requests.sort(), [globalUrl, channelUrl].sort());
  assert.equal(catalog.find("GlobalOld"), undefined);
  assert.equal(catalog.find("GlobalNew").provider, "7TV");
  assert.deepEqual(catalog.list("FFZ"), ffz);
  assert.deepEqual(catalog.list("BTTV"), bttv);
  assert.equal(catalog.findAvailable("Kappa"), native);
  assert.deepEqual(catalog.sevenTvSubscription.setIds, ["new-global", "room-set"]);
});

test("temporary HTTP and network errors retain the last good 7TV sets and metadata", async () => {
  const catalog = await catalogFixture();
  const before = catalog.list("7TV");
  const metadata = catalog.sevenTvSubscription;
  responses.set(globalUrl, response(null, 503));
  responses.set(channelUrl, () => { throw new Error("temporarily offline"); });
  assert.equal(await catalog.refreshSevenTv(), false);
  assert.equal(catalog.sevenTvRefreshIncomplete, false);
  assert.deepEqual(catalog.list("7TV"), before);
  assert.deepEqual(catalog.sevenTvSubscription, metadata);
});

test("a failed global request does not block a valid channel update", async () => {
  const catalog = await catalogFixture();
  responses.set(globalUrl, response(null, 502));
  responses.set(channelUrl, response(connection([emote("NewChannel")])));
  assert.equal(await catalog.refreshSevenTv(), true);
  assert.equal(catalog.sevenTvRefreshIncomplete, true);
  assert.equal(catalog.find("GlobalOld").provider, "7TV");
  assert.equal(catalog.find("RoomOld"), undefined);
  assert.equal(catalog.find("NewChannel").provider, "7TV");
  responses.set(globalUrl, response(set("global-set", [emote("RecoveredGlobal")])));
  assert.equal(await catalog.refreshSevenTv(), true);
  assert.equal(catalog.sevenTvRefreshIncomplete, false);
  assert.equal(catalog.find("RecoveredGlobal").provider, "7TV");
});

test("a failed channel request preserves its set when globals successfully update", async () => {
  const catalog = await catalogFixture();
  responses.set(globalUrl, response(set("global-set", [emote("NewGlobal")])));
  responses.set(channelUrl, response(null, 502));
  assert.equal(await catalog.refreshSevenTv(), true);
  assert.equal(catalog.sevenTvRefreshIncomplete, true);
  assert.equal(catalog.find("RoomOld").provider, "7TV");
  assert.equal(catalog.find("NewGlobal").provider, "7TV");
  assert.equal(catalog.sevenTvSubscription.userId, "seventv-user");
});

test("a missing channel user removes its 7TV emotes while retaining global emotes", async () => {
  const catalog = await catalogFixture();
  responses.set(channelUrl, response(null, 404));
  assert.equal(await catalog.refreshSevenTv(), true);
  assert.equal(catalog.find("RoomOld"), undefined);
  assert.equal(catalog.find("GlobalOld").provider, "7TV");
  assert.deepEqual(catalog.sevenTvSubscription, { setIds: ["global-set"], userId: null });
  assert.equal(catalog.find("Shared").provider, "BTTV");
});

test("a channel without a 7TV account can acquire a set on a later refresh", async () => {
  responses.set(channelUrl, response(null, 404));
  const catalog = await catalogFixture();
  assert.equal(catalog.sevenTvSubscription.userId, null);
  responses.set(channelUrl, response(connection([emote("FirstEmote")])));
  assert.equal(await catalog.refreshSevenTv(), true);
  assert.equal(catalog.find("FirstEmote").provider, "7TV");
  assert.equal(catalog.sevenTvSubscription.userId, "seventv-user");
});

test("a user with no active set remains subscribable to later set changes", async () => {
  const catalog = await catalogFixture();
  responses.set(channelUrl, response({ id: "42", emote_set_id: null, emote_set: null, user: { id: "seventv-user" } }));
  assert.equal(await catalog.refreshSevenTv(), true);
  assert.deepEqual(catalog.sevenTvSubscription, { setIds: ["global-set"], userId: "seventv-user" });
  assert.equal(catalog.find("RoomOld"), undefined);
});

test("an older refresh cannot overwrite the catalog after switching channels", async () => {
  const catalog = await catalogFixture();
  const pending = deferred();
  responses.set(channelUrl, () => pending.promise);
  const refresh = catalog.refreshSevenTv();
  responses.set("https://7tv.io/v3/users/twitch/43", response(connection([emote("OtherRoom")], "other-set", "other-user")));
  await catalog.load("43", { ffz: false, bttv: false, sevenTv: true });
  pending.resolve(response(connection([emote("StaleRoom")])));
  assert.equal(await refresh, false);
  assert.equal(catalog.find("StaleRoom"), undefined);
  assert.equal(catalog.find("OtherRoom").provider, "7TV");
  assert.equal(catalog.sevenTvSubscription.userId, "other-user");
});

test("clearing or disabling 7TV invalidates an in-flight refresh", async () => {
  for (const action of ["clear", "disable"]) {
    const catalog = await catalogFixture();
    const pending = deferred();
    responses.set(channelUrl, () => pending.promise);
    const refresh = catalog.refreshSevenTv();
    if (action === "clear") catalog.clear();
    else await catalog.load("42", { ...providers, sevenTv: false });
    pending.resolve(response(connection([emote("StaleRoom")])));
    assert.equal(await refresh, false, action);
    assert.equal(catalog.find("StaleRoom"), undefined, action);
    assert.equal(catalog.sevenTvSubscription, null, action);
    assert.equal(catalog.sevenTvRefreshIncomplete, false, action);
    const count = requests.length;
    assert.equal(await catalog.refreshSevenTv(), false, action);
    assert.equal(requests.length, count, action);
    responses.set(channelUrl, response(connection([emote("RoomOld", "old", 1), emote("Shared", "channel-shared")])));
  }
});

test("the newest overlapping refresh wins even when an older request resolves last", async () => {
  const catalog = await catalogFixture();
  const pending = deferred();
  responses.set(channelUrl, () => pending.promise);
  const oldRefresh = catalog.refreshSevenTv();
  responses.set(channelUrl, response(connection([emote("Newest")])));
  assert.equal(await catalog.refreshSevenTv(), true);
  pending.resolve(response(connection([emote("Outdated")])));
  assert.equal(await oldRefresh, false);
  assert.equal(catalog.find("Newest").provider, "7TV");
  assert.equal(catalog.find("Outdated"), undefined);
});

test("malformed successful responses do not erase a known emote set", async () => {
  const catalog = await catalogFixture();
  const before = catalog.list("7TV");
  responses.set(globalUrl, response({ id: "broken", emotes: null }));
  responses.set(channelUrl, response({ user: { id: "seventv-user" }, emote_set: { id: "broken" } }));
  assert.equal(await catalog.refreshSevenTv(), false);
  assert.deepEqual(catalog.list("7TV"), before);
  assert.deepEqual(catalog.sevenTvSubscription.setIds, ["global-set", "room-set"]);
  responses.set(channelUrl, response({ message: "unexpected response" }));
  assert.equal(await catalog.refreshSevenTv(), false);
  assert.deepEqual(catalog.list("7TV"), before);
});
