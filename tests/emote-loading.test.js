import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

const providers = { ffz: true, bttv: true, sevenTv: true };
const urls = {
  ffzGlobal: "https://api.frankerfacez.com/v1/set/global",
  bttvGlobal: "https://api.betterttv.net/3/cached/emotes/global",
  sevenGlobal: "https://7tv.io/v3/emote-sets/global",
  ffzRoom: "https://api.frankerfacez.com/v1/room/id/42",
  bttvRoom: "https://api.betterttv.net/3/cached/users/twitch/42",
  sevenRoom: "https://7tv.io/v3/users/twitch/42",
};
const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
let sequence = 0;
let EmoteCatalog;
let responses;
let requests;
let timers;
let signals;

function response(json, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => json };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function sevenEmote(name, id = name) {
  return { name, data: { host: {
    url: `//cdn.example/${id}`,
    files: [{ name: "1x.webp", format: "WEBP" }],
  } } };
}

function sevenSet(name, id = "room-set") {
  return { id, emotes: [sevenEmote(name), sevenEmote("Shared", `${id}-shared`)] };
}

function sevenRoom(name, id = "room-set") {
  return { emote_set: sevenSet(name, id), user: { id: "seven-user" } };
}

function ffzGlobal(name = "FfzGlobal") {
  return { default_sets: [1], sets: { 1: { emoticons: [
    { name, urls: { 1: `//cdn.example/${name}` } },
    { name: "Shared", urls: { 1: "//cdn.example/ffz-global-shared" } },
  ] } } };
}

function ffzRoom(name = "FfzRoom") {
  return { room: { set: 2 }, sets: { 2: { emoticons: [
    { name, urls: { 1: `//cdn.example/${name}` } },
    { name: "Shared", urls: { 1: "//cdn.example/ffz-room-shared" } },
  ] } } };
}

beforeEach(async () => {
  // Each catalog module owns its own global caches, as a fresh app session would.
  ({ EmoteCatalog } = await import(`../src/emotes.ts?loading-test=${++sequence}`));
  requests = [];
  signals = new Map();
  timers = new Map();
  let timerSequence = 0;
  globalThis.setTimeout = (callback, delay) => {
    const id = ++timerSequence;
    timers.set(id, { callback, delay });
    return id;
  };
  globalThis.clearTimeout = (id) => timers.delete(id);
  responses = new Map([
    [urls.ffzGlobal, response(ffzGlobal())],
    [urls.bttvGlobal, response([{ code: "BttvGlobal", id: "bttv-global" }])],
    [urls.sevenGlobal, response(sevenSet("SevenGlobal", "global-set"))],
    [urls.ffzRoom, response(ffzRoom())],
    [urls.bttvRoom, response({ channelEmotes: [
      { code: "BttvRoom", id: "bttv-room" }, { code: "Shared", id: "bttv-room-shared" },
    ] })],
    [urls.sevenRoom, response(sevenRoom("SevenRoom"))],
  ]);
  globalThis.fetch = async (url, options) => {
    requests.push(url);
    signals.set(url, options.signal);
    assert.ok(responses.has(url), `Unexpected request: ${url}`);
    const value = responses.get(url);
    return typeof value === "function" ? value() : value;
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
  assert.equal(timers.size, 0, "every asset deadline must be cleared");
});

async function flush() {
  for (let n = 0; n < 30; n++) await Promise.resolve();
}

function expirePending() {
  for (const { callback, delay } of [...timers.values()]) {
    assert.equal(delay, 10_000);
    callback();
  }
}

test("a stalled FFZ request cannot hide ready BTTV and 7TV emotes", async () => {
  responses.set(urls.ffzGlobal, () => new Promise(() => {}));
  const catalog = new EmoteCatalog();
  let completed = false;
  const updates = [];
  const loading = catalog.load("42", providers, () => updates.push(catalog.size))
    .then(() => { completed = true; });
  await flush();
  assert.equal(completed, false);
  assert.equal(catalog.find("SevenRoom").provider, "7TV");
  assert.equal(catalog.find("BttvRoom").provider, "BTTV");
  assert.equal(catalog.find("FfzRoom").provider, "FFZ");
  assert.ok(updates.some((count) => count > 0), "ready emotes notify the UI before the stalled request ends");
  assert.equal(timers.size, 1);
  expirePending();
  await loading;
  assert.equal(signals.get(urls.ffzGlobal).aborted, true);
  assert.equal(catalog.loadIncomplete, true);
  assert.equal(catalog.find("SevenRoom").provider, "7TV");
});

test("a stalled 7TV JSON body times out without blocking other providers", async () => {
  responses.set(urls.sevenRoom, {
    ok: true, status: 200, json: () => new Promise(() => {}),
  });
  const catalog = new EmoteCatalog();
  const loading = catalog.load("42", providers);
  await flush();
  assert.equal(catalog.find("SevenGlobal").provider, "7TV");
  assert.equal(catalog.find("BttvRoom").provider, "BTTV");
  assert.equal(timers.size, 1);
  expirePending();
  await loading;
  assert.equal(signals.get(urls.sevenRoom).aborted, true);
  assert.equal(catalog.loadIncomplete, true);
  assert.equal(catalog.sevenTvRefreshIncomplete, true);
  assert.deepEqual(catalog.sevenTvSubscription, { setIds: ["global-set"], userId: null });
});

test("failed FFZ and BTTV globals are retried without refetching successful scopes", async () => {
  responses.set(urls.ffzGlobal, response(null, 503));
  responses.set(urls.bttvGlobal, response(null, 503));
  const catalog = new EmoteCatalog();
  await catalog.load("42", providers);
  assert.equal(catalog.loadIncomplete, true);
  const seven = catalog.list("7TV");
  requests.length = 0;
  responses.set(urls.ffzGlobal, response(ffzGlobal("RecoveredFfz")));
  responses.set(urls.bttvGlobal, response([{ code: "RecoveredBttv", id: "recovered-bttv" }]));
  let updates = 0;
  await catalog.retryFailed(() => updates++);
  assert.deepEqual(requests.sort(), [urls.ffzGlobal, urls.bttvGlobal].sort());
  assert.equal(catalog.find("RecoveredFfz").provider, "FFZ");
  assert.equal(catalog.find("RecoveredBttv").provider, "BTTV");
  assert.deepEqual(catalog.list("7TV"), seven);
  assert.equal(updates, 2);
  assert.equal(catalog.loadIncomplete, false);
  await catalog.retryFailed();
  assert.equal(requests.length, 2, "a completed load does not keep retrying");
});

test("a new catalog can recover a previously failed shared global cache", async () => {
  responses.set(urls.ffzGlobal, response(null, 503));
  const first = new EmoteCatalog();
  await first.load("42", { ffz: true, bttv: false, sevenTv: false });
  assert.equal(first.loadIncomplete, true);
  responses.set(urls.ffzGlobal, response(ffzGlobal("RecoveredGlobal")));
  requests.length = 0;
  const second = new EmoteCatalog();
  await second.load("42", { ffz: true, bttv: false, sevenTv: false });
  assert.ok(requests.includes(urls.ffzGlobal));
  assert.equal(second.find("RecoveredGlobal").provider, "FFZ");
  assert.equal(second.loadIncomplete, false);
});

test("successful global caches are shared without repeated network requests", async () => {
  await new EmoteCatalog().load("42", providers);
  requests.length = 0;
  const catalog = new EmoteCatalog();
  await catalog.load("42", providers);
  assert.deepEqual(requests.sort(), [urls.ffzRoom, urls.bttvRoom, urls.sevenRoom].sort());
  assert.equal(catalog.find("FfzGlobal").provider, "FFZ");
  assert.equal(catalog.find("BttvGlobal").provider, "BTTV");
  assert.equal(catalog.find("SevenGlobal").provider, "7TV");
});

test("missing provider channel accounts are authoritative empty sets without retrying", async () => {
  for (const url of [urls.ffzRoom, urls.bttvRoom, urls.sevenRoom]) {
    responses.set(url, response(null, 404));
  }
  const catalog = new EmoteCatalog();
  await catalog.load("42", providers);
  assert.equal(catalog.loadIncomplete, false);
  assert.equal(catalog.sevenTvRefreshIncomplete, false);
  assert.equal(catalog.find("SevenRoom"), undefined);
  assert.equal(catalog.find("SevenGlobal").provider, "7TV");
  requests.length = 0;
  await catalog.retryFailed();
  assert.deepEqual(requests, []);
});

test("out-of-order provider completion preserves channel precedence", async () => {
  const slowGlobal = deferred();
  const slowFfzRoom = deferred();
  responses.set(urls.ffzGlobal, () => slowGlobal.promise);
  responses.set(urls.ffzRoom, () => slowFfzRoom.promise);
  const catalog = new EmoteCatalog();
  const loading = catalog.load("42", providers);
  await flush();
  assert.equal(catalog.find("Shared").provider, "7TV");
  assert.equal(catalog.find("Shared").url, "https://cdn.example/room-set-shared/1x.webp");
  slowFfzRoom.resolve(response(ffzRoom()));
  await flush();
  assert.equal(catalog.find("Shared").provider, "7TV");
  slowGlobal.resolve(response(ffzGlobal()));
  await loading;
  assert.equal(catalog.find("Shared").url, "https://cdn.example/room-set-shared/1x.webp");
  assert.equal(catalog.list("FFZ").find((emote) => emote.name === "Shared").url,
    "https://cdn.example/ffz-room-shared");
});

test("switching channels rejects old pending emotes and callbacks", async () => {
  const oldRoom = deferred();
  responses.set(urls.sevenRoom, () => oldRoom.promise);
  const catalog = new EmoteCatalog();
  let oldUpdates = 0;
  const first = catalog.load("42", providers, () => oldUpdates++);
  await flush();
  responses.set("https://7tv.io/v3/users/twitch/43", response(sevenRoom("NewRoom", "new-room-set")));
  await catalog.load("43", { ffz: false, bttv: false, sevenTv: true });
  const before = oldUpdates;
  oldRoom.resolve(response(sevenRoom("OldRoom")));
  await first;
  assert.equal(oldUpdates, before);
  assert.equal(catalog.find("OldRoom"), undefined);
  assert.equal(catalog.find("NewRoom").provider, "7TV");
  assert.equal(catalog.find("BttvRoom"), undefined);
  assert.equal(catalog.loadIncomplete, false);
});

test("clearing a pending catalog suppresses late callbacks and retries", async () => {
  const oldRoom = deferred();
  responses.set(urls.sevenRoom, () => oldRoom.promise);
  const catalog = new EmoteCatalog();
  let updates = 0;
  const loading = catalog.load("42", providers, () => updates++);
  await flush();
  catalog.clear();
  const before = updates;
  oldRoom.resolve(response(sevenRoom("LateRoom")));
  await loading;
  assert.equal(updates, before);
  assert.equal(catalog.size, 0);
  assert.equal(catalog.sevenTvSubscription, null);
  assert.equal(catalog.loadIncomplete, false);
  requests.length = 0;
  await catalog.retryFailed();
  assert.deepEqual(requests, []);
});

test("a same-room transient failure keeps the last successful channel emotes", async () => {
  const catalog = new EmoteCatalog();
  await catalog.load("42", providers);
  responses.set(urls.bttvRoom, response(null, 503));
  responses.set(urls.sevenRoom, response(null, 503));
  await catalog.load("42", providers);
  assert.equal(catalog.find("BttvRoom").provider, "BTTV");
  assert.equal(catalog.find("SevenRoom").provider, "7TV");
  assert.equal(catalog.loadIncomplete, true);
  responses.set(urls.bttvRoom, response({ channelEmotes: [{ code: "NewBttv", id: "new" }] }));
  responses.set(urls.sevenRoom, response(sevenRoom("NewSeven")));
  requests.length = 0;
  await catalog.retryFailed();
  assert.deepEqual(requests.sort(), [urls.bttvRoom, urls.sevenRoom].sort());
  assert.equal(catalog.find("NewBttv").provider, "BTTV");
  assert.equal(catalog.find("NewSeven").provider, "7TV");
  assert.equal(catalog.find("BttvRoom"), undefined);
  assert.equal(catalog.find("SevenRoom"), undefined);
  assert.equal(catalog.loadIncomplete, false);
});

test("disabling providers removes their emotes and suppresses old in-flight results", async () => {
  const pending = deferred();
  responses.set(urls.sevenRoom, () => pending.promise);
  const catalog = new EmoteCatalog();
  const loading = catalog.load("42", providers);
  await flush();
  requests.length = 0;
  await catalog.load("42", { ffz: false, bttv: false, sevenTv: false });
  assert.equal(catalog.size, 0);
  assert.equal(catalog.sevenTvSubscription, null);
  assert.deepEqual(requests, []);
  pending.resolve(response(sevenRoom("DisabledEmote")));
  await loading;
  assert.equal(catalog.find("DisabledEmote"), undefined);
  assert.equal(catalog.loadIncomplete, false);
});

test("7TV live refresh can clear an initial failed scope without erasing other providers", async () => {
  responses.set(urls.sevenRoom, response(null, 503));
  const catalog = new EmoteCatalog();
  await catalog.load("42", providers);
  assert.equal(catalog.loadIncomplete, true);
  responses.set(urls.sevenRoom, response(sevenRoom("RecoveredSeven")));
  assert.equal(await catalog.refreshSevenTv(), true);
  assert.equal(catalog.loadIncomplete, false);
  assert.equal(catalog.sevenTvRefreshIncomplete, false);
  assert.equal(catalog.find("RecoveredSeven").provider, "7TV");
  assert.equal(catalog.find("BttvRoom").provider, "BTTV");
});

test("a retry from a previous channel cannot repaint the newly loaded channel", async () => {
  responses.set(urls.bttvRoom, response(null, 503));
  const catalog = new EmoteCatalog();
  await catalog.load("42", providers);
  const oldRetry = deferred();
  responses.set(urls.bttvRoom, () => oldRetry.promise);
  let oldUpdates = 0;
  const retrying = catalog.retryFailed(() => oldUpdates++);
  await flush();
  responses.set("https://api.betterttv.net/3/cached/users/twitch/43", response({
    channelEmotes: [{ code: "CurrentChannel", id: "current" }],
  }));
  await catalog.load("43", { ffz: false, bttv: true, sevenTv: false });
  oldRetry.resolve(response({ channelEmotes: [{ code: "StaleRetry", id: "stale" }] }));
  await retrying;
  assert.equal(oldUpdates, 0);
  assert.equal(catalog.find("StaleRetry"), undefined);
  assert.equal(catalog.find("CurrentChannel").provider, "BTTV");
  assert.equal(catalog.loadIncomplete, false);
});

test("a newer live snapshot takes precedence over a pending initial-failure retry", async () => {
  responses.set(urls.sevenRoom, response(null, 503));
  const catalog = new EmoteCatalog();
  await catalog.load("42", providers);
  const oldRetry = deferred();
  responses.set(urls.sevenRoom, () => oldRetry.promise);
  let oldUpdates = 0;
  const retrying = catalog.retryFailed(() => oldUpdates++);
  await flush();
  responses.set(urls.sevenRoom, response(sevenRoom("NewLiveSnapshot", "new-live-set")));
  assert.equal(await catalog.refreshSevenTv(), true);
  oldRetry.resolve(response(sevenRoom("StaleRetry", "stale-set")));
  await retrying;
  assert.equal(oldUpdates, 0);
  assert.equal(catalog.find("StaleRetry"), undefined);
  assert.equal(catalog.find("NewLiveSnapshot").provider, "7TV");
  assert.deepEqual(catalog.sevenTvSubscription.setIds, ["global-set", "new-live-set"]);
  assert.equal(catalog.loadIncomplete, false);
  assert.equal(catalog.sevenTvRefreshIncomplete, false);
});
