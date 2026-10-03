import assert from "node:assert/strict";
import { test } from "node:test";
import { LivePlayback } from "../src/live-playback.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const starts = [];
  const attachments = [];
  const errors = [];
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
    async attach(info, request) { attachments.push({ info, request }); },
    loading() {},
    destroy() { destroyed++; },
    async stop() { stopped++; },
    error(channel, error) { errors.push({ channel, error }); },
    settled() { settled++; },
  });
  return { playback, starts, attachments, errors, counts: () => ({ settled, destroyed, stopped }) };
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
  assert.deepEqual(f.counts(), { settled: 1, destroyed: 0, stopped: 0 });
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
  assert.deepEqual(f.counts(), { settled: 2, destroyed: 1, stopped: 1 });
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
