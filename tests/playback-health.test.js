import assert from "node:assert/strict";
import { test } from "node:test";
import { PlaybackHealth } from "../src/playback-health.ts";

const snapshot = (currentTime, overrides = {}) => ({
  currentTime, paused: false, ended: false, seeking: false, ...overrides,
});
const quiet = { stalled: false, healthy: false };

function fixture(currentTime = 0, thresholds) {
  const health = new PlaybackHealth(thresholds);
  health.reset(0, currentTime);
  return health;
}

test("a silent startup with no bytes eventually stalls without browser media events", () => {
  const health = fixture();
  assert.deepEqual(health.sample(snapshot(0), 24_999), quiet);
  assert.deepEqual(health.sample(snapshot(0), 25_000), { stalled: true, healthy: false });
});

test("a frozen live media clock stalls regardless of a ready player or playing event", () => {
  const health = fixture();
  assert.deepEqual(health.sample(snapshot(1), 1_000), quiet);
  // These browser properties/events are intentionally not inputs to the monitor.
  const frozen = snapshot(1, { readyState: 4, event: "playing" });
  assert.deepEqual(health.sample(frozen, 12_999), quiet);
  assert.deepEqual(health.sample(frozen, 13_000), { stalled: true, healthy: false });
});

test("short buffering recovers without a restart and clears the old stall deadline", () => {
  const health = fixture();
  health.sample(snapshot(1), 1_000);
  assert.deepEqual(health.sample(snapshot(1), 10_000), quiet);
  assert.deepEqual(health.sample(snapshot(1.1), 11_000), quiet);
  assert.deepEqual(health.sample(snapshot(1.1), 22_999), quiet);
  assert.equal(health.sample(snapshot(1.1), 23_000).stalled, true);
});

test("an intentional long pause is ignored and resuming receives a fresh grace period", () => {
  const health = fixture();
  health.sample(snapshot(1), 1_000);
  assert.deepEqual(health.sample(snapshot(1, { paused: true }), 60_000), quiet);
  assert.deepEqual(health.sample(snapshot(1, { paused: true }), 600_000), quiet);
  assert.deepEqual(health.sample(snapshot(1), 601_000), quiet);
  assert.deepEqual(health.sample(snapshot(1), 612_999), quiet);
  assert.equal(health.sample(snapshot(1), 613_000).stalled, true);
});

test("pausing before startup retains the longer startup grace after resume", () => {
  const health = fixture();
  health.sample(snapshot(0, { paused: true }), 90_000);
  assert.deepEqual(health.sample(snapshot(0), 91_000), quiet);
  assert.deepEqual(health.sample(snapshot(0), 115_999), quiet);
  assert.equal(health.sample(snapshot(0), 116_000).stalled, true);
});

test("seeking suspends detection and does not count a forward seek as healthy progress", () => {
  const health = fixture();
  health.sample(snapshot(1), 1_000);
  assert.deepEqual(health.sample(snapshot(100, { seeking: true }), 20_000), quiet);
  assert.deepEqual(health.sample(snapshot(200, { seeking: true }), 120_000), quiet);
  assert.deepEqual(health.sample(snapshot(200), 121_000), quiet);
  assert.deepEqual(health.sample(snapshot(200), 132_999), quiet);
  assert.equal(health.sample(snapshot(200), 133_000).stalled, true);
});

test("a backward seek or discontinuity resets its baseline and health window", () => {
  const health = fixture(100);
  for (let seconds = 1; seconds <= 10; seconds++) health.sample(snapshot(100 + seconds), seconds * 1_000);
  assert.deepEqual(health.sample(snapshot(10), 11_000), quiet);
  assert.deepEqual(health.sample(snapshot(10), 22_999), quiet);
  assert.equal(health.sample(snapshot(10), 23_000).stalled, true);
});

test("a permanently stuck seek recovers after the startup grace", () => {
  const health = fixture();
  health.sample(snapshot(1), 1_000);
  assert.deepEqual(health.sample(snapshot(100, { seeking: true }), 2_000), quiet);
  assert.deepEqual(health.sample(snapshot(100, { seeking: true }), 26_999), quiet);
  assert.deepEqual(health.sample(snapshot(100, { seeking: true }), 27_000), {
    stalled: true, healthy: false,
  });
});

test("media progress during seeking avoids a false stall without declaring health", () => {
  const health = fixture();
  for (let seconds = 1; seconds <= 60; seconds++) {
    assert.deepEqual(health.sample(snapshot(seconds, { seeking: true }), seconds * 1_000), quiet);
  }
  assert.deepEqual(health.sample(snapshot(60, { seeking: true }), 84_999), quiet);
  assert.equal(health.sample(snapshot(60, { seeking: true }), 85_000).stalled, true);
});

test("an intentional pause suppresses recovery even during a stuck seek", () => {
  const health = fixture();
  health.sample(snapshot(100, { seeking: true }), 1_000);
  assert.deepEqual(health.sample(snapshot(100, { paused: true, seeking: true }), 600_000), quiet);
  assert.deepEqual(health.sample(snapshot(100, { paused: true, seeking: true }), 900_000), quiet);
  assert.deepEqual(health.sample(snapshot(100, { seeking: true }), 901_000), quiet);
  assert.equal(health.sample(snapshot(100, { seeking: true }), 926_000).stalled, true);
});

test("clean live EOF is stalled even when the browser also reports paused", () => {
  for (const paused of [false, true]) {
    const health = fixture();
    assert.deepEqual(health.sample(snapshot(0, { ended: true, paused }), 1_000), {
      stalled: true, healthy: false,
    });
  }
});

test("sustained actual media advancement establishes health after fifteen seconds", () => {
  const health = fixture();
  for (let seconds = 1; seconds <= 15; seconds++) {
    assert.deepEqual(health.sample(snapshot(seconds), seconds * 1_000), quiet);
  }
  assert.deepEqual(health.sample(snapshot(16), 16_000), { stalled: false, healthy: true });
  assert.deepEqual(health.sample(snapshot(17), 17_000), { stalled: false, healthy: true });
});

test("one large forward jump does not establish health, even after fifteen seconds", () => {
  const health = fixture();
  assert.deepEqual(health.sample(snapshot(100), 16_000), quiet);
  assert.deepEqual(health.sample(snapshot(100), 27_999), quiet);
  assert.deepEqual(health.sample(snapshot(100), 28_000), { stalled: true, healthy: false });
});

test("intermittent brief progress cannot repeatedly clear a retry budget", () => {
  const health = fixture();
  for (let seconds = 1; seconds <= 60; seconds++) {
    const time = Math.floor(seconds / 4);
    assert.deepEqual(health.sample(snapshot(time), seconds * 1_000), quiet);
  }
});

test("tiny recurring timeline nudges do not qualify as healthy playback", () => {
  const health = fixture();
  for (let seconds = 1; seconds <= 60; seconds++) {
    assert.deepEqual(health.sample(snapshot(seconds * 0.02), seconds * 1_000), quiet);
  }
});

test("a buffering gap resets sustained health rather than combining brief runs", () => {
  const health = fixture();
  for (let seconds = 1; seconds <= 10; seconds++) health.sample(snapshot(seconds), seconds * 1_000);
  assert.deepEqual(health.sample(snapshot(10), 13_000), quiet);
  for (let seconds = 14; seconds <= 28; seconds++) {
    assert.deepEqual(health.sample(snapshot(seconds - 3), seconds * 1_000), quiet);
  }
  assert.deepEqual(health.sample(snapshot(26), 29_000), { stalled: false, healthy: true });
});

test("resetting for a new player forgets previous health and grants startup time", () => {
  const health = fixture();
  for (let seconds = 1; seconds <= 16; seconds++) health.sample(snapshot(seconds), seconds * 1_000);
  health.reset(17_000, 0);
  assert.deepEqual(health.sample(snapshot(0), 41_999), quiet);
  assert.deepEqual(health.sample(snapshot(0), 42_000), { stalled: true, healthy: false });
  assert.deepEqual(health.sample(snapshot(1), 43_000), quiet);
});

test("a post-ad reset on previously playing media gives the normal stall grace", () => {
  const health = fixture();
  health.sample(snapshot(1), 1_000);
  health.reset(120_000, 1, true);
  assert.deepEqual(health.sample(snapshot(1), 131_999), quiet);
  assert.deepEqual(health.sample(snapshot(1), 132_000), { stalled: true, healthy: false });
  assert.deepEqual(health.sample(snapshot(2), 133_000), quiet);
});

test("a post-preroll reset without any prior playback keeps the startup grace", () => {
  const health = fixture();
  health.reset(120_000, 0, false);
  assert.deepEqual(health.sample(snapshot(0), 144_999), quiet);
  assert.deepEqual(health.sample(snapshot(0), 145_000), { stalled: true, healthy: false });
  assert.deepEqual(health.sample(snapshot(1), 146_000), quiet);
});

test("sub-epsilon jitter does not hide a frozen stream", () => {
  const health = fixture(10);
  health.sample(snapshot(11), 1_000);
  for (let seconds = 2; seconds <= 12; seconds++) {
    assert.deepEqual(health.sample(snapshot(11 + (seconds % 2) * 0.005), seconds * 1_000), quiet);
  }
  assert.equal(health.sample(snapshot(11.005), 13_000).stalled, true);
});

test("invalid media times cannot count as progress or prevent a stall", () => {
  const health = fixture();
  assert.deepEqual(health.sample(snapshot(NaN), 24_999), quiet);
  assert.deepEqual(health.sample(snapshot(Infinity), 25_000), { stalled: true, healthy: false });
});

test("thresholds can be shortened for deterministic integration fixtures", () => {
  const health = fixture(0, { startupMs: 50, stallMs: 30, stableMs: 20 });
  assert.deepEqual(health.sample(snapshot(0), 49), quiet);
  assert.equal(health.sample(snapshot(0), 50).stalled, true);
  assert.deepEqual(health.sample(snapshot(1), 51), quiet);
  assert.deepEqual(health.sample(snapshot(2), 71), { stalled: false, healthy: true });
  assert.equal(health.sample(snapshot(2), 101).stalled, true);
});
