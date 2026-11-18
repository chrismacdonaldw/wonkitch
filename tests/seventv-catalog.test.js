import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { EmoteCatalog } from "../src/emotes.ts";
import {
  GAMBA_ITEM, HMM_ITEM, requestKey, SEVENTV_GLOBAL, SEVENTV_GQL, SEVENTV_NO_ACCOUNT, sevenTvChannel,
  sevenTvChannelData, sevenTvGlobalData, sevenTvItem as emote, sevenTvSet as set,
} from "./seventv-fixtures.js";

const globalKey = SEVENTV_GLOBAL;
const channelKey = sevenTvChannel("42");
const providers = { ffz: true, bttv: true, sevenTv: true };
const originalFetch = globalThis.fetch;
let responses;
let requests;

function connection(entries, setId = "room-set", userId = "seventv-user") {
  return sevenTvChannelData(set(setId, entries), userId);
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
    [globalKey, response(sevenTvGlobalData(set("global-set", [emote("GlobalOld"), emote("Shared", "global-shared")])))],
    [channelKey, response(connection([emote("RoomOld", "old", { zeroWidth: true }), emote("Shared", "channel-shared")]))],
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
  globalThis.fetch = async (url, init) => {
    const key = requestKey(url, init);
    requests.push(key);
    assert.ok(responses.has(key), `Unexpected request: ${key}`);
    const result = responses.get(key);
    return typeof result === "function" ? result() : result;
  };
});

afterEach(() => { globalThis.fetch = originalFetch; });

async function catalogFixture() {
  const catalog = new EmoteCatalog();
  await catalog.load("42", providers);
  // Restore the baseline global set even if an earlier test refreshed the shared cache.
  await catalog.refresh("7TV");
  requests.length = 0;
  return catalog;
}

test("7TV metadata uses the nested user ID and returns an independent subscription snapshot", async () => {
  const catalog = await catalogFixture();
  assert.deepEqual(catalog.sevenTvSubscription, {
    setIds: ["global-set", "room-set"], userId: "seventv-user",
  });
  assert.equal(catalog.loadIncomplete, false);
  catalog.sevenTvSubscription.setIds.push("mutated");
  assert.deepEqual(catalog.sevenTvSubscription.setIds, ["global-set", "room-set"]);
  assert.equal(catalog.find("Shared").url, "https://cdn.example/channel-shared/1x.webp");
  assert.equal(catalog.find("RoomOld").zeroWidth, true);
  assert.equal(catalog.find("RoomOld").previewUrl, "https://cdn.example/old/4x.webp");
  assert.equal(catalog.find("Original_RoomOld"), undefined);
});

test("7TV refresh adds, removes, renames aliases and follows an active set change", async () => {
  const catalog = await catalogFixture();
  responses.set(channelKey, response(connection([
    emote("NewAlias", "old", { zeroWidth: true }), emote("FreshEmote", "fresh"),
  ], "replacement-set")));
  assert.equal(await catalog.refresh("7TV"), "complete");
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
  responses.set(globalKey, response(sevenTvGlobalData(set("new-global", [emote("GlobalNew")]))));
  assert.equal(await catalog.refresh("7TV"), "complete");
  assert.deepEqual(requests.sort(), [globalKey, channelKey].sort());
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
  responses.set(globalKey, response(null, 503));
  responses.set(channelKey, () => { throw new Error("temporarily offline"); });
  assert.equal(await catalog.refresh("7TV"), "failed");
  assert.equal(catalog.loadIncomplete, true);
  assert.deepEqual(catalog.list("7TV"), before);
  assert.deepEqual(catalog.sevenTvSubscription, metadata);
});

test("a failed global request does not block a valid channel update", async () => {
  const catalog = await catalogFixture();
  responses.set(globalKey, response(null, 502));
  responses.set(channelKey, response(connection([emote("NewChannel")])));
  assert.equal(await catalog.refresh("7TV"), "partial");
  assert.equal(catalog.loadIncomplete, true);
  assert.equal(catalog.find("GlobalOld").provider, "7TV");
  assert.equal(catalog.find("RoomOld"), undefined);
  assert.equal(catalog.find("NewChannel").provider, "7TV");
  responses.set(globalKey, response(sevenTvGlobalData(set("global-set", [emote("RecoveredGlobal")]))));
  assert.equal(await catalog.refresh("7TV"), "complete");
  assert.equal(catalog.loadIncomplete, false);
  assert.equal(catalog.find("RecoveredGlobal").provider, "7TV");
});

test("a failed channel request preserves its set when globals successfully update", async () => {
  const catalog = await catalogFixture();
  responses.set(globalKey, response(sevenTvGlobalData(set("global-set", [emote("NewGlobal")]))));
  responses.set(channelKey, response(null, 502));
  assert.equal(await catalog.refresh("7TV"), "partial");
  assert.equal(catalog.loadIncomplete, true);
  assert.equal(catalog.find("RoomOld").provider, "7TV");
  assert.equal(catalog.find("NewGlobal").provider, "7TV");
  assert.equal(catalog.sevenTvSubscription.userId, "seventv-user");
});

test("a missing channel user removes its 7TV emotes while retaining global emotes", async () => {
  const catalog = await catalogFixture();
  responses.set(channelKey, response(SEVENTV_NO_ACCOUNT));
  assert.equal(await catalog.refresh("7TV"), "complete");
  assert.equal(catalog.find("RoomOld"), undefined);
  assert.equal(catalog.find("GlobalOld").provider, "7TV");
  assert.deepEqual(catalog.sevenTvSubscription, { setIds: ["global-set"], userId: null });
  assert.equal(catalog.find("Shared").provider, "BTTV");
});

test("a channel without a 7TV account can acquire a set on a later refresh", async () => {
  responses.set(channelKey, response(SEVENTV_NO_ACCOUNT));
  const catalog = await catalogFixture();
  assert.equal(catalog.sevenTvSubscription.userId, null);
  responses.set(channelKey, response(connection([emote("FirstEmote")])));
  assert.equal(await catalog.refresh("7TV"), "complete");
  assert.equal(catalog.find("FirstEmote").provider, "7TV");
  assert.equal(catalog.sevenTvSubscription.userId, "seventv-user");
});

test("a user with no active set remains subscribable to later set changes", async () => {
  const catalog = await catalogFixture();
  responses.set(channelKey, response(sevenTvChannelData(null)));
  assert.equal(await catalog.refresh("7TV"), "complete");
  assert.deepEqual(catalog.sevenTvSubscription, { setIds: ["global-set"], userId: "seventv-user" });
  assert.equal(catalog.find("RoomOld"), undefined);
});

test("an older refresh cannot overwrite the catalog after switching channels", async () => {
  const catalog = await catalogFixture();
  const pending = deferred();
  responses.set(channelKey, () => pending.promise);
  const refresh = catalog.refresh("7TV");
  responses.set(sevenTvChannel("43"), response(connection([emote("OtherRoom")], "other-set", "other-user")));
  await catalog.load("43", { ffz: false, bttv: false, sevenTv: true });
  pending.resolve(response(connection([emote("StaleRoom")])));
  assert.equal(await refresh, "failed");
  assert.equal(catalog.find("StaleRoom"), undefined);
  assert.equal(catalog.find("OtherRoom").provider, "7TV");
  assert.equal(catalog.sevenTvSubscription.userId, "other-user");
});

test("clearing or disabling 7TV invalidates an in-flight refresh", async () => {
  for (const action of ["clear", "disable"]) {
    const catalog = await catalogFixture();
    const pending = deferred();
    responses.set(channelKey, () => pending.promise);
    const refresh = catalog.refresh("7TV");
    if (action === "clear") catalog.clear();
    else await catalog.load("42", { ...providers, sevenTv: false });
    pending.resolve(response(connection([emote("StaleRoom")])));
    assert.equal(await refresh, "failed", action);
    assert.equal(catalog.find("StaleRoom"), undefined, action);
    assert.equal(catalog.sevenTvSubscription, null, action);
    assert.equal(catalog.loadIncomplete, false, action);
    const count = requests.length;
    assert.equal(await catalog.refresh("7TV"), "failed", action);
    assert.equal(requests.length, count, action);
    responses.set(channelKey, response(connection([emote("RoomOld", "old", { zeroWidth: true }), emote("Shared", "channel-shared")])));
  }
});

test("the newest overlapping refresh wins even when an older request resolves last", async () => {
  const catalog = await catalogFixture();
  const pending = deferred();
  responses.set(channelKey, () => pending.promise);
  const oldRefresh = catalog.refresh("7TV");
  responses.set(channelKey, response(connection([emote("Newest")])));
  assert.equal(await catalog.refresh("7TV"), "complete");
  pending.resolve(response(connection([emote("Outdated")])));
  assert.equal(await oldRefresh, "failed");
  assert.equal(catalog.find("Newest").provider, "7TV");
  assert.equal(catalog.find("Outdated"), undefined);
});

test("malformed successful responses do not erase a known emote set", async () => {
  const catalog = await catalogFixture();
  const before = catalog.list("7TV");
  responses.set(globalKey, response(sevenTvGlobalData({ id: "broken", emotes: { items: null } })));
  responses.set(channelKey, response(sevenTvChannelData({ id: "broken" })));
  assert.equal(await catalog.refresh("7TV"), "failed");
  assert.deepEqual(catalog.list("7TV"), before);
  assert.deepEqual(catalog.sevenTvSubscription.setIds, ["global-set", "room-set"]);
  responses.set(channelKey, response({ message: "unexpected response" }));
  assert.equal(await catalog.refresh("7TV"), "failed");
  assert.deepEqual(catalog.list("7TV"), before);
});

test("7TV sets are requested as JSON POSTs to the V4 GraphQL endpoint", async () => {
  const catalog = await catalogFixture();
  const sent = [];
  const fetchFake = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url, ...init });
    return fetchFake(url, init);
  };
  assert.equal(await catalog.refresh("7TV"), "complete");
  assert.equal(sent.length, 2);
  for (const request of sent) {
    assert.equal(request.url, SEVENTV_GQL);
    assert.equal(request.method, "POST");
    assert.equal(request.headers["Content-Type"], "application/json");
  }
});

test("each scale renders animated WebP over static and other formats, with a 1x URL and 4x preview", async () => {
  const catalog = await catalogFixture();
  responses.set(channelKey, response(connection([GAMBA_ITEM, HMM_ITEM])));
  assert.equal(await catalog.refresh("7TV"), "complete");
  const gamba = catalog.find("GAMBA");
  assert.equal(gamba.url, "https://cdn.7tv.app/emote/01G3WEGZN0000ET2J0MQP5YJ0G/1x.webp",
    "animated WebP beats its static variant and a GIF with more frames");
  assert.equal(gamba.previewUrl, "https://cdn.7tv.app/emote/01G3WEGZN0000ET2J0MQP5YJ0G/4x.webp");
  const hmm = catalog.find("Hmm");
  assert.equal(hmm.url, "https://cdn.7tv.app/emote/01F6MA6Y100002B6P5MWZ5D916/1x.webp", "WebP beats AVIF and PNG");
  assert.equal(hmm.previewUrl, "https://cdn.7tv.app/emote/01F6MA6Y100002B6P5MWZ5D916/4x.webp");
});

test("missing scales fall back to the nearest available image and imageless emotes are skipped", async () => {
  const catalog = await catalogFixture();
  responses.set(channelKey, response(connection([
    emote("NoSmall", "no-small", { scales: [2, 3] }),
    emote("OnlySmall", "only-small", { scales: [1] }),
    emote("NoImages", "no-images", { scales: [] }),
  ])));
  assert.equal(await catalog.refresh("7TV"), "complete");
  assert.equal(catalog.find("NoSmall").url, "https://cdn.example/no-small/2x.webp");
  assert.equal(catalog.find("NoSmall").previewUrl, "https://cdn.example/no-small/3x.webp");
  assert.equal(catalog.find("OnlySmall").previewUrl, "https://cdn.example/only-small/1x.webp");
  assert.equal(catalog.find("NoImages"), undefined);
});

test("a set's alias names the emote instead of the emote's own name", async () => {
  const catalog = await catalogFixture();
  responses.set(channelKey, response(connection([emote("ChannelAlias", "aliased", { name: "EmoteName" })])));
  assert.equal(await catalog.refresh("7TV"), "complete");
  assert.equal(catalog.find("ChannelAlias").url, "https://cdn.example/aliased/1x.webp");
  assert.equal(catalog.find("EmoteName"), undefined);
});

test("GraphQL errors keep the last good 7TV sets", async () => {
  const catalog = await catalogFixture();
  const before = catalog.list("7TV");
  responses.set(globalKey, response({ errors: [{ message: "internal" }], data: null }));
  responses.set(channelKey, response({ errors: [{ message: "partial" }], ...connection([emote("PartialData")]) }));
  assert.equal(await catalog.refresh("7TV"), "failed");
  assert.deepEqual(catalog.list("7TV"), before);
  assert.deepEqual(catalog.sevenTvSubscription.setIds, ["global-set", "room-set"]);
  assert.equal(catalog.loadIncomplete, true);
});

test("a set reporting more than one page warns once and keeps the emotes it returned", async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    const catalog = await catalogFixture();
    responses.set(channelKey, response(sevenTvChannelData(set("paged-set", [emote("FirstPage")], 2))));
    assert.equal(await catalog.refresh("7TV"), "complete");
    assert.equal(await catalog.refresh("7TV"), "complete");
    assert.equal(catalog.find("FirstPage").provider, "7TV");
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = originalWarn;
  }
});
