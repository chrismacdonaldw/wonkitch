import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { SevenTvLiveUpdates } from "../src/seventv-live.ts";

const cleanup = [];
afterEach(() => { while (cleanup.length) cleanup.pop()(); });
function fixture() {
  let now = 0;
  let id = 0;
  const timers = new Map();
  let invalidate;
  const watched = [];
  let disconnected = 0;
  let updated = 0;
  let fetches = 0;
  let refresh = async () => true;
  const catalog = {
    sevenTvSubscription: { setIds: ["global", "channel"], userId: "user" },
    sevenTvRefreshIncomplete: false,
    emotes: [{ name: "OldEmote", provider: "7TV" }],
    list() { return this.emotes; },
    async refreshSevenTv() { fetches++; return refresh(); },
  };
  const live = new SevenTvLiveUpdates(catalog, () => { updated++; }, {
    createEvents: (callback) => {
      invalidate = callback;
      return { watch: (subscription) => watched.push(structuredClone(subscription)),
        disconnect: () => { disconnected++; }, dispose() {} };
    },
    now: () => now,
    setTimeout: (callback, delay) => { timers.set(++id, { callback, at: now + delay }); return id; },
    clearTimeout: (timer) => timers.delete(timer),
  });
  const tick = async (delta) => {
    now += delta;
    for (const [timer, value] of [...timers]) {
      if (value.at > now) continue;
      timers.delete(timer);
      value.callback();
    }
    for (let n = 0; n < 8; n++) await Promise.resolve();
  };
  cleanup.push(() => live.dispose());
  return { live, catalog, watched, timers, tick, invalidate: () => invalidate(),
    fetches: () => fetches, updated: () => updated, disconnected: () => disconnected,
    refresh: (callback) => { refresh = callback; } };
}

test("bursts of live changes refresh once and update UI only when the emote snapshot changed", async () => {
  const f = fixture();
  f.live.start();
  f.refresh(async () => { f.catalog.emotes = [{ name: "NewEmote", provider: "7TV" }]; return true; });
  f.invalidate(); f.invalidate(); f.invalidate();
  await f.tick(249);
  assert.equal(f.fetches(), 0);
  await f.tick(1);
  assert.equal(f.fetches(), 1);
  assert.equal(f.updated(), 1);
  f.invalidate();
  await f.tick(250);
  assert.equal(f.fetches(), 2);
  assert.equal(f.updated(), 1, "a reconnect acknowledgement must not repaint unchanged chat");
});

test("changes arriving during a REST request cause one follow-up without overlapping refreshes", async () => {
  const f = fixture();
  f.live.start();
  let resolve;
  f.refresh(() => new Promise((done) => { resolve = done; }));
  f.invalidate();
  await f.tick(250);
  f.invalidate(); f.invalidate();
  await f.tick(1000);
  assert.equal(f.fetches(), 1);
  resolve(true);
  await f.tick(0);
  f.refresh(async () => true);
  await f.tick(250);
  assert.equal(f.fetches(), 2);
});

test("active set changes update subscriptions without clearing other state", async () => {
  const f = fixture();
  f.live.start();
  f.refresh(async () => {
    f.catalog.sevenTvSubscription = { setIds: ["global", "new-set"], userId: "user" };
    return true;
  });
  f.invalidate();
  await f.tick(250);
  assert.deepEqual(f.watched.at(-1).setIds, ["global", "new-set"]);
  assert.equal(f.updated(), 0);
});

test("disconnect or channel changes suppress old pending callbacks and timers", async () => {
  const f = fixture();
  f.live.start();
  let resolve;
  f.refresh(() => new Promise((done) => { resolve = done; }));
  f.invalidate(); await f.tick(250);
  f.live.stop();
  f.catalog.emotes = [{ name: "OldSocketEmote", provider: "7TV" }];
  resolve(true); await f.tick(0);
  assert.equal(f.updated(), 0);
  assert.equal(f.timers.size, 0);
  f.invalidate(); await f.tick(1_000_000);
  assert.equal(f.fetches(), 1);
});

test("a new channel can refresh while an old channel request finishes without unblocking the wrong generation", async () => {
  const f = fixture();
  f.live.start();
  const resolves = [];
  f.refresh(() => new Promise((done) => resolves.push(done)));
  f.invalidate(); await f.tick(250);
  f.live.stop(); f.live.start();
  f.invalidate(); await f.tick(250);
  assert.equal(f.fetches(), 2);
  resolves[0](true); await f.tick(0);
  f.invalidate(); await f.tick(1000);
  assert.equal(f.fetches(), 2, "the new channel's request remains in flight");
  resolves[1](true); await f.tick(0);
  f.refresh(async () => true);
  await f.tick(250);
  assert.equal(f.fetches(), 3);
});

test("periodic reconciliation discovers changes missed by the event server", async () => {
  const f = fixture();
  f.live.start();
  await f.tick(300_000);
  await f.tick(250);
  assert.equal(f.fetches(), 1);
});

test("transient failures keep emotes and retry with backoff, but a fresh event expedites the retry", async () => {
  const f = fixture();
  f.live.start();
  f.refresh(async () => false);
  f.invalidate(); await f.tick(250);
  assert.equal(f.updated(), 0);
  await f.tick(29_999);
  assert.equal(f.fetches(), 1);
  f.refresh(async () => { throw new Error("offline"); });
  await f.tick(1);
  assert.equal(f.fetches(), 2);
  f.refresh(async () => true);
  f.invalidate(); await f.tick(250);
  assert.equal(f.fetches(), 3);
});

test("a partial successful snapshot updates emotes while retrying the failed scope promptly", async () => {
  const f = fixture();
  f.live.start();
  f.refresh(async () => {
    f.catalog.emotes = [{ name: "NewGlobal", provider: "7TV" }];
    f.catalog.sevenTvRefreshIncomplete = true;
    return true;
  });
  f.invalidate(); await f.tick(250);
  assert.equal(f.updated(), 1);
  assert.equal(f.fetches(), 1);
  f.refresh(async () => { f.catalog.sevenTvRefreshIncomplete = false; return true; });
  await f.tick(29_999);
  assert.equal(f.fetches(), 1);
  await f.tick(1);
  assert.equal(f.fetches(), 2);
  assert.equal(f.updated(), 1, "retrying metadata must not repaint an unchanged emote list");
});

test("disabled or disposed providers cannot start a feed or leave background polling behind", async () => {
  const f = fixture();
  f.catalog.sevenTvSubscription = null;
  f.live.start();
  assert.equal(f.watched.length, 0);
  assert.equal(f.timers.size, 0);
  f.catalog.sevenTvSubscription = { setIds: ["global"], userId: null };
  f.live.start(); f.live.dispose(); f.live.start();
  f.invalidate(); await f.tick(1_000_000);
  assert.equal(f.fetches(), 0);
  assert.equal(f.timers.size, 0);
});

test("syncing an unrelated provider retry preserves an in-flight 7TV update", async () => {
  const f = fixture();
  f.live.start();
  const disconnects = f.disconnected();
  let resolve;
  f.refresh(() => new Promise((done) => { resolve = done; }));
  f.invalidate();
  await f.tick(250);
  assert.equal(f.fetches(), 1);
  const pollTimers = [...f.timers];

  // The room asset retry has completed for FFZ; the 7TV snapshot is unchanged.
  f.live.syncCatalog();
  assert.equal(f.disconnected(), disconnects);
  assert.deepEqual([...f.timers], pollTimers);
  assert.equal(f.updated(), 0);

  f.catalog.emotes = [{ name: "LiveEmoteAfterRetry", provider: "7TV" }];
  f.catalog.sevenTvSubscription = { setIds: ["global", "new-live-set"], userId: "user" };
  resolve(true);
  await f.tick(0);
  assert.equal(f.updated(), 1, "the pending live request still publishes its new snapshot");
  assert.deepEqual(f.watched.at(-1).setIds, ["global", "new-live-set"]);
  assert.equal(f.disconnected(), disconnects);
});

test("syncCatalog follows restored metadata without disconnecting or restarting the poll clock", async () => {
  const f = fixture();
  f.catalog.sevenTvSubscription = { setIds: [], userId: null };
  f.catalog.emotes = [];
  f.live.start();
  const disconnects = f.disconnected();
  await f.tick(12_000);
  const pollTimers = [...f.timers];
  f.catalog.sevenTvSubscription = { setIds: ["restored-global", "restored-channel"], userId: "restored-user" };
  f.catalog.emotes = [{ name: "RestoredEmote", provider: "7TV" }];
  f.live.syncCatalog();
  assert.deepEqual(f.watched.at(-1), f.catalog.sevenTvSubscription);
  assert.equal(f.disconnected(), disconnects);
  assert.deepEqual([...f.timers], pollTimers);
  assert.equal(f.updated(), 0, "the external catalog owner already painted its change");

  await f.tick(288_000);
  await f.tick(250);
  assert.equal(f.fetches(), 1, "the existing five-minute poll deadline remains in force");
  assert.equal(f.updated(), 0, "an identical fetched snapshot does not repaint restored emotes");
});

test("repeated catalog synchronization does not repaint an unchanged 7TV snapshot", async () => {
  const f = fixture();
  f.live.start();
  const disconnects = f.disconnected();
  f.live.syncCatalog();
  f.live.syncCatalog();
  f.live.syncCatalog();
  assert.equal(f.updated(), 0);
  assert.equal(f.disconnected(), disconnects);
  f.invalidate();
  await f.tick(250);
  assert.equal(f.fetches(), 1);
  assert.equal(f.updated(), 0);
});

test("syncCatalog cannot restart an inactive or disposed live feed", async () => {
  const f = fixture();
  f.live.syncCatalog();
  assert.equal(f.watched.length, 0);
  assert.equal(f.timers.size, 0);
  f.live.start();
  f.live.stop();
  const stoppedWatchCount = f.watched.length;
  f.live.syncCatalog();
  assert.equal(f.watched.length, stoppedWatchCount);
  assert.equal(f.timers.size, 0);
  f.live.start();
  f.live.dispose();
  const disposedWatchCount = f.watched.length;
  f.catalog.sevenTvSubscription = { setIds: ["should-not-subscribe"], userId: "user" };
  f.live.syncCatalog();
  assert.equal(f.watched.length, disposedWatchCount);
  assert.equal(f.timers.size, 0);
  f.invalidate();
  await f.tick(1_000_000);
  assert.equal(f.fetches(), 0);
  assert.equal(f.updated(), 0);
});
