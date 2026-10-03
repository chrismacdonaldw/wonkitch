import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatSynchronizer, playbackBufferEnd } from "../src/chat-sync.ts";

const start = 1_780_000_000_000;
const message = (id, seconds) => ({ id, timestamp: start + seconds * 1000 });
const snapshot = (currentTime, overrides = {}) => ({
  currentTime, bufferedEnd: currentTime + 4, playingDate: null, advancing: true, ...overrides,
});
const ids = (messages) => messages.map(({ id }) => id);

function fixture(maximum) {
  const sync = new ChatSynchronizer(maximum);
  sync.setVideoActive(true);
  return sync;
}

test("chat waits for the HLS frame's server timestamp, including notices and alerts", () => {
  const sync = fixture();
  const displayed = [];
  const alerted = [];
  sync.enqueue({ ...message("highlight", 8), highlighted: true }, start + 10_000);
  sync.enqueue({ ...message("subscription", 9), isNotice: true }, start + 10_000);
  const deliver = (now) => {
    for (const msg of sync.drain(now)) {
      displayed.push(msg.id);
      if (msg.highlighted) alerted.push(msg.id);
    }
  };
  sync.update(snapshot(100, { playingDate: start + 7_000 }), start + 10_000);
  deliver(start + 10_000);
  assert.deepEqual(displayed, []);
  assert.deepEqual(alerted, []);
  assert.deepEqual(sync.status(start + 10_000), { mode: "synced", delay: 3 });
  sync.update(snapshot(101, { playingDate: start + 8_000 }), start + 11_000);
  deliver(start + 11_000);
  assert.deepEqual(displayed, ["highlight"]);
  assert.deepEqual(alerted, ["highlight"]);
  sync.update(snapshot(102, { playingDate: start + 9_000 }), start + 12_000);
  deliver(start + 12_000);
  assert.deepEqual(displayed, ["highlight", "subscription"]);
});

test("startup holds messages until video starts and has a usable clock", () => {
  const sync = fixture();
  sync.enqueue(message("first", 0), start);
  sync.update(snapshot(0, { advancing: false }), start);
  assert.deepEqual(sync.drain(start + 30_000), []);
  assert.equal(sync.status(start).mode, "waiting");
  sync.update(snapshot(0, { bufferedEnd: null }), start + 30_000);
  assert.deepEqual(sync.drain(start + 30_000), []);
  sync.update(snapshot(4), start + 30_000);
  assert.deepEqual(ids(sync.drain(start + 30_000)), ["first"]);
});

test("a temporarily missing HLS timestamp retains its media-time mapping", () => {
  const sync = fixture();
  sync.update(snapshot(100, { playingDate: start }), start + 10_000);
  sync.enqueue(message("reaction", 1), start + 10_000);
  sync.update(snapshot(100.5), start + 20_000);
  assert.deepEqual(sync.drain(start + 20_000), []);
  sync.update(snapshot(101), start + 20_500);
  assert.deepEqual(ids(sync.drain(start + 20_500)), ["reaction"]);
});

test("MPEG-TS estimates delay from the buffer, then follows media time rather than wall-clock ticks", () => {
  const sync = fixture();
  sync.enqueue(message("reaction", 1), start + 1_000);
  sync.update(snapshot(20), start);
  assert.deepEqual(sync.status(start), { mode: "estimated", delay: 4 });
  sync.update(snapshot(20, { bufferedEnd: 35 }), start + 10_000);
  assert.deepEqual(sync.drain(start + 10_000), []);
  assert.equal(sync.status(start + 10_000).delay, 14);
  sync.update(snapshot(25, { bufferedEnd: 35 }), start + 11_000);
  assert.deepEqual(ids(sync.drain(start + 11_000)), ["reaction"]);
});

test("pauses, buffering, and seeking hold chat even with an earlier manual adjustment", () => {
  const sync = fixture();
  sync.configure(true, -10);
  sync.update(snapshot(10, { playingDate: start }), start);
  sync.enqueue(message("future", 1), start + 1_000);
  sync.update(snapshot(10, { advancing: false, playingDate: start + 50_000 }), start + 50_000);
  assert.deepEqual(sync.drain(start + 50_000), []);
  assert.equal(sync.status(start + 50_000).mode, "paused");
  sync.update(snapshot(11, { playingDate: start + 1_000 }), start + 51_000);
  assert.deepEqual(ids(sync.drain(start + 51_000)), ["future"]);
});

test("manual adjustment retimes pending chat; positive is later and negative is earlier", () => {
  const sync = fixture();
  sync.update(snapshot(10, { playingDate: start + 5_000 }), start + 10_000);
  sync.enqueue(message("later", 5), start + 10_000);
  sync.configure(true, 2);
  assert.deepEqual(sync.drain(start + 10_000), []);
  assert.equal(sync.status(start + 10_000).delay, 7);
  sync.configure(true, -1);
  assert.deepEqual(ids(sync.drain(start + 10_000)), ["later"]);
  assert.equal(sync.status(start + 10_000).delay, 4);
});

test("automatic sync follows separate one-second and twelve-second streams with a shared adjustment", () => {
  const moon = fixture();
  const jerma = fixture();
  moon.update(snapshot(20, { bufferedEnd: 21 }), start);
  jerma.update(snapshot(20, { bufferedEnd: 21, playingDate: start - 12_000 }), start);
  assert.equal(moon.status(start).delay, 1);
  assert.equal(jerma.status(start).delay, 12);
  for (const sync of [moon, jerma]) {
    sync.configure(true, 2);
    sync.enqueue(message("reaction", 0), start);
  }
  assert.equal(moon.status(start).delay, 3);
  assert.equal(jerma.status(start).delay, 14);
  moon.update(snapshot(23, { bufferedEnd: 24 }), start + 3_000);
  jerma.update(snapshot(23, { playingDate: start - 9_000 }), start + 3_000);
  assert.deepEqual(ids(moon.drain(start + 3_000)), ["reaction"]);
  assert.deepEqual(jerma.drain(start + 3_000), []);
  jerma.update(snapshot(34, { playingDate: start + 2_000 }), start + 14_000);
  assert.deepEqual(ids(jerma.drain(start + 14_000)), ["reaction"]);
});

test("HLS without timestamps uses twelve-second playlist delay even with only one second downloaded", () => {
  const sync = fixture();
  sync.update(snapshot(20, { bufferedEnd: 21, liveLatency: 12 }), start);
  sync.enqueue(message("reaction", 0), start);
  assert.deepEqual(sync.status(start), { mode: "estimated", delay: 12 });
  sync.update(snapshot(21, { bufferedEnd: 22, liveLatency: 12 }), start + 1_000);
  assert.deepEqual(sync.drain(start + 1_000), []);
  sync.update(snapshot(32, { bufferedEnd: 33, liveLatency: 12 }), start + 12_000);
  assert.deepEqual(ids(sync.drain(start + 12_000)), ["reaction"]);
});

test("late HLS latency upgrades a buffer estimate, while timestamp mappings keep priority", () => {
  const sync = fixture();
  sync.update(snapshot(20, { bufferedEnd: 21, liveLatency: 0 }), start);
  assert.equal(sync.status(start).delay, 1);
  sync.update(snapshot(21, { bufferedEnd: 22, liveLatency: 12 }), start + 1_000);
  assert.equal(sync.status(start + 1_000).delay, 12);
  sync.update(snapshot(22, { liveLatency: 4, playingDate: start - 12_000 }), start + 2_000);
  assert.equal(sync.status(start + 2_000).delay, 14);
  sync.update(snapshot(23, { liveLatency: 4 }), start + 3_000);
  assert.equal(sync.status(start + 3_000).delay, 14);
  sync.update(snapshot(23, { liveLatency: 4 }), start + 20_000);
  assert.equal(sync.status(start + 20_000).delay, 31);
});

test("resuming and latency chasing release eligible messages in arrival order", () => {
  const sync = fixture();
  sync.update(snapshot(10, { playingDate: start }), start);
  for (let i = 1; i <= 5; i++) sync.enqueue(message(String(i), i), start + i * 1000);
  sync.update(snapshot(10, { advancing: false }), start + 10_000);
  assert.deepEqual(sync.drain(start + 10_000), []);
  sync.update(snapshot(15, { playingDate: start + 5_000 }), start + 11_000);
  assert.deepEqual(ids(sync.drain(start + 11_000, 3)), ["1", "2", "3"]);
  assert.deepEqual(ids(sync.drain(start + 11_000, 3)), ["4", "5"]);
});

test("quality and transport changes keep pending chat but reset the playback clock", () => {
  const sync = fixture();
  sync.update(snapshot(10, { playingDate: start }), start);
  sync.enqueue(message("pending", 1), start + 1_000);
  sync.resetPlayback();
  assert.equal(sync.pendingCount, 1);
  assert.equal(sync.status(start + 30_000).mode, "waiting");
  assert.deepEqual(sync.drain(start + 30_000), []);
  sync.update(snapshot(0, { playingDate: start + 1_000 }), start + 30_000);
  assert.deepEqual(ids(sync.drain(start + 30_000)), ["pending"]);
});

test("channel and VOD switches discard messages; the next channel gets a new buffer anchor", () => {
  const sync = fixture();
  sync.update(snapshot(100), start);
  sync.enqueue(message("old-channel", 1), start + 1_000);
  sync.reset();
  sync.setVideoActive(true);
  sync.update(snapshot(0, { bufferedEnd: 2 }), start + 20_000);
  assert.equal(sync.pendingCount, 0);
  assert.equal(sync.status(start + 20_000).delay, 2);
  assert.deepEqual(sync.drain(start + 20_000), []);
});

test("sync opt-out and offline video keep chat usable and flush held messages in bounded batches", () => {
  for (const optOut of [true, false]) {
    const sync = fixture();
    sync.enqueue(message("one", 1), start + 1_000);
    sync.enqueue(message("two", 2), start + 2_000);
    if (optOut) sync.configure(false, 120);
    else sync.setVideoActive(false);
    assert.deepEqual(ids(sync.drain(start + 10_000, 1)), ["one"]);
    assert.deepEqual(ids(sync.drain(start + 10_000, 1)), ["two"]);
    assert.equal(sync.status(start + 10_000).mode, optOut ? "off" : "live");
  }
});

test("a long pause bounds pending memory without showing future messages", () => {
  const sync = fixture(3);
  for (let i = 0; i < 2_000; i++) sync.enqueue(message(String(i), i), start + i * 1000);
  assert.equal(sync.pendingCount, 3);
  assert.deepEqual(sync.drain(start + 2_000_000), []);
  sync.configure(false, 0);
  assert.deepEqual(ids(sync.drain(start + 2_000_000)), ["1997", "1998", "1999"]);
  assert.equal(sync.pendingCount, 0);
});

test("invalid timestamps and adjustments cannot poison the queue", () => {
  const sync = fixture();
  for (const [index, timestamp] of [NaN, Infinity, -1, start + 999_000].entries()) {
    sync.enqueue({ id: String(index), timestamp }, start + 5_000);
  }
  sync.configure(true, NaN);
  sync.update(snapshot(10, { playingDate: start + 4_000 }), start + 10_000);
  assert.deepEqual(sync.drain(start + 10_000), []);
  sync.update(snapshot(11, { playingDate: start + 5_000 }), start + 11_000);
  assert.deepEqual(ids(sync.drain(start + 11_000)), ["0", "1", "2", "3"]);
});

test("playback buffer selection ignores disjoint future ranges and handles gaps", () => {
  const ranges = { length: 2, start: (i) => [10, 25][i], end: (i) => [20, 30][i] };
  assert.equal(playbackBufferEnd(ranges, 15), 20);
  assert.equal(playbackBufferEnd(ranges, 22), null);
  assert.equal(playbackBufferEnd(ranges, 26), 30);
  assert.equal(playbackBufferEnd(ranges, 9.98), 20);
  assert.equal(playbackBufferEnd({ length: 0 }, 0), null);
});
