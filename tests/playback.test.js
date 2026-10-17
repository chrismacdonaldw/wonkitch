import assert from "node:assert/strict";
import { test } from "node:test";
import { LivePlayback } from "../src/live-playback.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(options = {}) {
  const starts = [];
  const attachments = [];
  const errors = [];
  const recoveries = [];
  const adChanges = [];
  const timers = new Map();
  let timerId = 0;
  let now = 0;
  let resumed = 0;
  let settled = 0;
  let destroyed = 0;
  let stopped = 0;
  const playback = new LivePlayback({
    start(channel, quality, transport) {
      const pending = deferred();
      const info = { channel, quality, transport, url: "http://127.0.0.1/stream", qualities: ["best", "720p60"], title: "Live", category: "Games" };
      starts.push({ ...pending, info });
      return pending.promise;
    },
    async attach(info, request) { attachments.push({ info, request }); await options.attach?.(info, request); },
    loading() {},
    recovering(channel, reason, attempt, delayMs) { recoveries.push({ channel, reason, attempt, delayMs }); },
    resumed() { resumed++; },
    adBreak(channel, active) { adChanges.push({ channel, active }); },
    destroy() { destroyed++; },
    async stop() { stopped++; await options.stop?.(); },
    error(channel, error) { errors.push({ channel, error }); },
    settled() { settled++; },
  }, {
    now: () => now,
    setTimeout(callback, delay) { timers.set(++timerId, { callback, at: now + delay }); return timerId; },
    clearTimeout(timer) { timers.delete(timer); },
  });
  const advance = async (milliseconds) => {
    const target = now + milliseconds;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].callback();
      await new Promise((resolve) => setImmediate(resolve));
    }
    now = target;
    await new Promise((resolve) => setImmediate(resolve));
  };
  const observe = (currentTime, extra = {}) => playback.observe({ currentTime, paused: false, ended: false, seeking: false, ...extra });
  return { playback, starts, attachments, errors, recoveries, adChanges, timers, advance, observe,
    counts: () => ({ settled, destroyed, stopped, resumed }) };
}

async function complete(start) {
  start.resolve(start.info);
  await new Promise((resolve) => setImmediate(resolve));
}

test("fragmented MP4 format failure retries the same channel and quality through HLS once", async () => {
  const f = fixture();
  const initial = f.playback.tune("jerma985", "720p60", true);
  assert.equal(f.starts[0].info.transport, "mpegts");
  await complete(f.starts[0]);
  await initial;
  const request = f.attachments[0].request;
  assert.equal(request.recoverFormat("FormatUnsupported"), true);
  assert.deepEqual(f.starts.map(({ info }) => [info.channel, info.quality, info.transport]), [
    ["jerma985", "720p60", "mpegts"],
    ["jerma985", "720p60", "hls"],
  ]);
  assert.equal(request.isCurrent(), false);
  assert.equal(request.recoverFormat("FormatUnsupported"), false);
  await complete(f.starts[1]);
  assert.equal(f.attachments[1].request.recoverFormat("FormatUnsupported"), false);
  assert.equal(f.starts.length, 2);
  assert.deepEqual(f.errors, []);
});

test("HLS persists across quality changes, while a new channel gets the MPEG-TS player", async () => {
  const f = fixture();
  void f.playback.tune("jerma985", "best", true);
  await complete(f.starts[0]);
  f.attachments[0].request.recoverFormat("FormatUnsupported");
  await complete(f.starts[1]);
  void f.playback.tune("jerma985", "720p60", false);
  assert.equal(f.starts[2].info.transport, "hls");
  await complete(f.starts[2]);
  f.playback.reset();
  void f.playback.tune("moonmoon", "720p60", true);
  assert.equal(f.starts[3].info.transport, "mpegts");
  await complete(f.starts[3]);
});

test("old player failures and delayed requests cannot reopen a channel after a switch", async () => {
  const f = fixture();
  void f.playback.tune("jerma985", "best", true);
  await complete(f.starts[0]);
  const old = f.attachments[0].request;
  old.recoverFormat("FormatUnsupported");
  f.playback.reset();
  void f.playback.tune("moonmoon", "best", true);
  await complete(f.starts[2]);
  await complete(f.starts[1]);
  assert.equal(old.recoverFormat("FormatUnsupported"), false);
  assert.deepEqual(f.attachments.map(({ info }) => info.channel), ["jerma985", "moonmoon"]);
  assert.equal(f.counts().settled, 2);
});

test("switching to a VOD invalidates the live fallback, including its pending failure", async () => {
  const f = fixture();
  void f.playback.tune("jerma985", "best", true);
  await complete(f.starts[0]);
  f.attachments[0].request.recoverFormat("FormatUnsupported");
  f.playback.reset();
  f.starts[1].reject(new Error("offline"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.counts(), { settled: 1, destroyed: 0, stopped: 0, resumed: 0 });
});

test("an HLS startup failure clears playback and reports the error without a retry loop", async () => {
  const f = fixture();
  void f.playback.tune("jerma985", "best", true);
  await complete(f.starts[0]);
  assert.equal(f.attachments[0].request.recoverFormat("NetworkError"), false);
  f.attachments[0].request.recoverFormat("FormatUnsupported");
  const error = new Error("HLS playlist unavailable");
  f.starts[1].reject(error);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.errors, [{ channel: "jerma985", error }]);
  assert.deepEqual(f.counts(), { settled: 2, destroyed: 1, stopped: 1, resumed: 0 });
  assert.equal(f.starts.length, 2);
});

test("a superseded quality request cannot replace the newer player", async () => {
  const f = fixture();
  void f.playback.tune("jerma985", "best", true);
  void f.playback.tune("jerma985", "720p60", false);
  await complete(f.starts[1]);
  await complete(f.starts[0]);
  assert.deepEqual(f.attachments.map(({ info }) => info.quality), ["720p60"]);
  assert.equal(f.counts().settled, 1);
});

test("clean live completion reopens the same channel, selected quality, and transport", async () => {
  const f = fixture();
  void f.playback.tune("moonmoon", "720p60", true);
  await complete(f.starts[0]);
  const old = f.attachments[0].request;
  assert.equal(old.recover("ended"), true);
  old.recover("ended");
  old.recover("error");
  assert.equal(f.timers.size, 1, "one recovery despite repeated transport/native events");
  assert.equal(f.recoveries[0].delayMs, 1000);
  await f.advance(999);
  assert.equal(f.starts.length, 1);
  await f.advance(1);
  assert.equal(old.isCurrent(), false);
  assert.equal(old.recover("ended"), false);
  assert.deepEqual(f.starts.map(({ info }) => [info.channel, info.quality, info.transport]), [
    ["moonmoon", "720p60", "mpegts"], ["moonmoon", "720p60", "mpegts"],
  ]);
  await complete(f.starts[1]);
  assert.deepEqual(f.errors, []);
  assert.equal(f.timers.size, 0);
});

test("silent frozen media time recovers even without a waiting or error event", async () => {
  const f = fixture();
  void f.playback.tune("moonmoon", "best", true);
  await complete(f.starts[0]);
  f.observe(0);
  await f.advance(1000);
  f.observe(1);
  await f.advance(11_999);
  f.observe(1);
  assert.equal(f.recoveries.length, 0);
  await f.advance(1);
  f.observe(1);
  assert.equal(f.recoveries[0].reason, "stalled");
  await f.advance(1000);
  assert.equal(f.starts.length, 2);
  await complete(f.starts[1]);
});

test("a player that never starts is recovered even while its initial media remains paused", async () => {
  const f = fixture();
  void f.playback.tune("moonmoon", "best", true);
  await complete(f.starts[0]);
  f.observe(100, { paused: true });
  await f.advance(24_999);
  f.observe(100, { paused: true });
  assert.equal(f.recoveries.length, 0, "initial timeline offset is not measured playback progress");
  await f.advance(1);
  f.observe(100, { paused: true });
  assert.equal(f.recoveries.at(-1).reason, "stalled");
  f.playback.reset();
});

for (const reason of ["error", "ended"]) {
  test(`terminal ${reason} upgrades a queued stall retry before buffered frames advance`, async () => {
    const f = fixture();
    void f.playback.tune("moonmoon", "best", true);
    await complete(f.starts[0]);
    f.observe(0);
    await f.advance(1000);
    f.observe(1);
    await f.advance(12_000);
    f.observe(1);
    f.attachments[0].request.recover(reason);
    await f.advance(500);
    f.observe(1.5);
    await f.advance(500);
    assert.equal(f.starts.length, 2);
    assert.equal(f.counts().resumed, 0);
    await complete(f.starts[1]);
  });
}

test("brief buffering and a stall that resumes during backoff do not replace the player", async () => {
  const f = fixture();
  void f.playback.tune("moonmoon", "best", true);
  await complete(f.starts[0]);
  f.observe(1);
  await f.advance(7000);
  f.observe(1);
  assert.equal(f.recoveries.length, 0);
  f.observe(2);
  await f.advance(12_000);
  f.observe(2);
  assert.equal(f.recoveries.length, 1);
  await f.advance(500);
  f.observe(2.5);
  assert.equal(f.counts().resumed, 1);
  await f.advance(5000);
  assert.equal(f.starts.length, 1);
  f.playback.reset();
});

test("a finished live response is still replaced while its final buffered seconds advance", async () => {
  const f = fixture();
  void f.playback.tune("moonmoon", "best", true);
  await complete(f.starts[0]);
  f.observe(10);
  f.attachments[0].request.recover("ended");
  await f.advance(500);
  f.observe(10.5);
  await f.advance(500);
  assert.equal(f.starts.length, 2, "remaining buffer must not conceal a dead live response");
  await complete(f.starts[1]);
});

test("intentional pause defers pending recovery until the viewer resumes", async () => {
  const f = fixture();
  void f.playback.tune("moonmoon", "best", true);
  await complete(f.starts[0]);
  f.attachments[0].request.recover("ended");
  f.playback.setPaused(true);
  await f.advance(60_000);
  f.observe(0, { paused: true, ended: true });
  assert.equal(f.starts.length, 1);
  assert.equal(f.timers.size, 0);
  f.playback.setPaused(false);
  await f.advance(1000);
  assert.equal(f.starts.length, 2);
  await complete(f.starts[1]);
});

test("pausing during an in-flight recovery prevents its replacement from autoplaying", async () => {
  const f = fixture();
  void f.playback.tune("moonmoon", "best", true);
  await complete(f.starts[0]);
  f.attachments[0].request.recover("error");
  await f.advance(1000);
  f.playback.setPaused(true);
  await complete(f.starts[1]);
  assert.equal(f.attachments[1].request.shouldPlay(), false);
  f.playback.setPaused(false);
  assert.equal(f.attachments[1].request.shouldPlay(), true);
});

test("automatic recovery retains HLS after format fallback", async () => {
  const f = fixture();
  void f.playback.tune("jerma985", "best", true);
  await complete(f.starts[0]);
  f.attachments[0].request.recoverFormat("FormatUnsupported");
  await complete(f.starts[1]);
  f.attachments[1].request.recover("error");
  await f.advance(1000);
  assert.equal(f.starts[2].info.transport, "hls");
  await complete(f.starts[2]);
});

for (const change of ["quality", "channel", "vod"]) {
  test(`${change} changes invalidate pending automatic recovery`, async () => {
    const f = fixture();
    void f.playback.tune("moonmoon", "best", true);
    await complete(f.starts[0]);
    const old = f.attachments[0].request;
    old.recover("ended");
    if (change !== "quality") f.playback.reset();
    if (change !== "vod") {
      void f.playback.tune(change === "channel" ? "jerma985" : "moonmoon", "720p60", true);
      await complete(f.starts[1]);
    }
    await f.advance(60_000);
    assert.equal(f.starts.length, change === "vod" ? 1 : 2);
    assert.equal(old.recover("error"), false);
    assert.deepEqual(f.errors, []);
  });
}

test("recovery failures back off and stop after five attempts without a retry loop", async () => {
  const f = fixture();
  void f.playback.tune("moonmoon", "best", true);
  await complete(f.starts[0]);
  f.attachments[0].request.recover("error");
  for (const [index, delay] of [1000, 2000, 4000, 8000, 15000].entries()) {
    assert.equal(f.recoveries[index].delayMs, delay);
    await f.advance(delay);
    f.starts[index + 1].reject(new Error("upstream unavailable"));
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(f.starts.length, 6);
  assert.equal(f.errors.length, 1);
  assert.match(String(f.errors[0].error), /stopped repeatedly/);
  assert.equal(f.timers.size, 0);
  await f.advance(3_600_000);
  assert.equal(f.starts.length, 6);
  void f.playback.tune("moonmoon", "720p60", true);
  await complete(f.starts[6]);
  f.attachments.at(-1).request.recover("ended");
  assert.equal(f.recoveries.at(-1).delayMs, 1000, "explicit retry starts a new budget");
  f.playback.reset();
});

test("brief replacement playback does not reset backoff, but sustained media progress does", async () => {
  const f = fixture();
  void f.playback.tune("moonmoon", "best", true);
  await complete(f.starts[0]);
  f.attachments[0].request.recover("error");
  await f.advance(1000);
  await complete(f.starts[1]);
  f.observe(1);
  f.attachments[1].request.recover("ended");
  assert.equal(f.recoveries.at(-1).delayMs, 2000);
  await f.advance(2000);
  await complete(f.starts[2]);
  for (let second = 1; second <= 17; second++) {
    await f.advance(1000);
    f.observe(second);
  }
  f.attachments[2].request.recover("error");
  assert.equal(f.recoveries.at(-1).delayMs, 1000);
  f.playback.reset();
});

test("a stalled stream startup times out and late completion cannot attach afterward", async () => {
  const f = fixture();
  const initial = f.playback.tune("moonmoon", "best", true);
  await f.advance(40_000);
  await initial;
  assert.equal(f.errors.length, 1);
  assert.match(String(f.errors[0].error), /connection took too long/);
  assert.equal(f.counts().stopped, 1);
  await complete(f.starts[0]);
  assert.equal(f.attachments.length, 0);
  assert.equal(f.timers.size, 0);
});

test("a superseded recovery cannot stop a newer stream when its start rejects late", async () => {
  const f = fixture();
  void f.playback.tune("moonmoon", "best", true);
  await complete(f.starts[0]);
  f.attachments[0].request.recover("error");
  await f.advance(1000);
  void f.playback.tune("moonmoon", "720p60", false);
  await complete(f.starts[2]);
  f.starts[1].reject(new Error("old failure"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.counts().stopped, 0);
  assert.equal(f.attachments.at(-1).info.quality, "720p60");
  assert.deepEqual(f.errors, []);
});

test("a new quality or VOD waits for pending failed-session cleanup before starting", async () => {
  const cleanup = deferred();
  const f = fixture({ stop: () => cleanup.promise });
  void f.playback.tune("moonmoon", "best", true);
  await complete(f.starts[0]);
  f.attachments[0].request.recover("error");
  await f.advance(1000);
  f.starts[1].reject(new Error("failed recovery"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.counts().stopped, 1);
  const newer = f.playback.tune("moonmoon", "720p60", false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.starts.length, 2, "new stream cannot be killed by the old stop request");
  let resetComplete = false;
  const reset = f.playback.reset().then(() => { resetComplete = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resetComplete, false, "VOD transition receives the same cleanup barrier");
  cleanup.resolve();
  await reset;
  await newer;
  assert.equal(f.starts.length, 2, "VOD reset superseded the waiting quality request");
  assert.deepEqual(f.errors, []);
});

test("native events queued from old media cannot restart a newer pending tune", async () => {
  const f = fixture();
  void f.playback.tune("moonmoon", "best", true);
  await complete(f.starts[0]);
  void f.playback.tune("moonmoon", "720p60", false);
  assert.equal(f.playback.recover("error"), false);
  assert.equal(f.playback.recover("ended"), false);
  await f.advance(1000);
  assert.equal(f.starts.length, 2);
  await complete(f.starts[1]);
  assert.equal(f.recoveries.length, 0);
});

test("generation-bound engine failures can recover while attachment is still in progress", async () => {
  const f = fixture({ attach(_info, request) { request.recover("ended"); } });
  void f.playback.tune("moonmoon", "best", true);
  await complete(f.starts[0]);
  assert.equal(f.recoveries.length, 1);
  await f.advance(1000);
  assert.equal(f.starts.length, 2);
  f.playback.reset();
});

async function playing(f) {
  void f.playback.tune("moonmoon", "best", true);
  await complete(f.starts[0]);
  f.observe(0);
  await f.advance(1000);
  f.observe(1);
}

test("a known long ad holds recovery and restores playback without replacing healthy media", async () => {
  const f = fixture();
  await playing(f);
  f.playback.setAdBreak(true, 1);
  for (let second = 0; second < 120; second++) {
    await f.advance(1000);
    f.playback.setAdBreak(true, 1);
    f.observe(1);
  }
  assert.equal(f.recoveries.length, 0);
  assert.equal(f.starts.length, 1);
  assert.equal(f.timers.size, 0);
  f.playback.setAdBreak(false, 2);
  f.observe(1);
  assert.equal(f.counts().resumed, 0, "ad ending alone does not prove the decoder is running");
  await f.advance(1000);
  f.observe(2);
  assert.equal(f.counts().resumed, 1);
  assert.deepEqual(f.adChanges.map(({ active }) => active), [true, false]);
  assert.equal(f.starts.length, 1);
});

test("newly identified ad silence cancels a pending stall retry", async () => {
  const f = fixture();
  await playing(f);
  await f.advance(12_000);
  f.observe(1);
  assert.equal(f.recoveries.length, 1);
  f.playback.setAdBreak(true, 1);
  await f.advance(120_000);
  f.observe(1);
  f.playback.setAdBreak(false, 2);
  f.observe(1);
  await f.advance(1000);
  f.observe(2);
  assert.equal(f.starts.length, 1, "a stall explained by an ad is no longer a transport failure");
  assert.equal(f.timers.size, 0);
});

test("a terminal failure during ads waits for their end before reopening the dead session", async () => {
  const f = fixture();
  await playing(f);
  f.playback.setAdBreak(true, 1);
  f.attachments[0].request.recover("ended");
  await f.advance(120_000);
  f.observe(1);
  assert.equal(f.starts.length, 1);
  f.playback.setAdBreak(false, 2);
  await f.advance(1000);
  assert.equal(f.starts.length, 2);
  await complete(f.starts[1]);
});

test("a decoder that stays frozen after an ad receives twelve seconds to resume", async () => {
  const f = fixture();
  await playing(f);
  f.playback.setAdBreak(true, 1);
  await f.advance(120_000);
  f.observe(1);
  f.playback.setAdBreak(false, 2);
  f.observe(1);
  await f.advance(11_999);
  f.observe(1);
  assert.equal(f.recoveries.length, 0);
  await f.advance(1);
  f.observe(1);
  assert.equal(f.recoveries.at(-1).reason, "stalled");
  await f.advance(1000);
  await complete(f.starts[1]);
});

test("a preroll that never had media retains the full startup grace afterward", async () => {
  const f = fixture();
  void f.playback.tune("moonmoon", "best", true);
  await complete(f.starts[0]);
  f.playback.setAdBreak(true, 1);
  await f.advance(120_000);
  f.observe(0, { paused: true });
  f.playback.setAdBreak(false, 2);
  f.observe(0, { paused: true });
  await f.advance(24_999);
  f.observe(0, { paused: true });
  assert.equal(f.recoveries.length, 0);
  await f.advance(1);
  f.observe(0, { paused: true });
  assert.equal(f.recoveries.length, 1);
  f.playback.reset();
});

test("stale repeated ad status cannot suppress recovery indefinitely", async () => {
  const f = fixture();
  await playing(f);
  f.playback.setAdBreak(true, 10);
  await f.advance(615_000);
  f.observe(1);
  for (let second = 0; second < 12; second++) {
    f.playback.setAdBreak(true, 10);
    f.playback.setAdBreak(true, 9);
    await f.advance(1000);
    f.observe(1);
  }
  assert.equal(f.recoveries.length, 1);
  assert.equal(f.adChanges.filter(({ active }) => active).length, 1);
  f.playback.reset();
});

test("pausing through the end of an ad keeps terminal recovery deferred", async () => {
  const f = fixture();
  await playing(f);
  f.playback.setAdBreak(true, 1);
  f.playback.setPaused(true);
  f.attachments[0].request.recover("error");
  f.playback.setAdBreak(false, 2);
  await f.advance(60_000);
  f.observe(1, { paused: true });
  assert.equal(f.starts.length, 1);
  f.playback.setPaused(false);
  await f.advance(1000);
  await complete(f.starts[1]);
});

test("measured progress after preroll counts before another ad starts", async () => {
  const f = fixture();
  void f.playback.tune("moonmoon", "best", true);
  await complete(f.starts[0]);
  f.playback.setAdBreak(true, 1);
  f.observe(0);
  f.playback.setAdBreak(false, 2);
  f.observe(1);
  assert.equal(f.counts().resumed, 1);
  f.playback.setAdBreak(true, 3);
  await f.advance(60_000);
  f.observe(1);
  f.playback.setAdBreak(false, 4);
  f.observe(1);
  await f.advance(12_000);
  f.observe(1);
  assert.equal(f.recoveries.length, 1, "the established media clock gets normal post-ad grace");
  f.playback.reset();
});
