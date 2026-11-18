import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { fetchChatAssetJson, retainSuccess } from "../src/chat-assets.ts";

const url = "https://example.com/chat-assets";
const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
let timers;
let cleared;
let nextTimer;

beforeEach(() => {
  timers = new Map();
  cleared = [];
  nextTimer = 0;
  globalThis.setTimeout = (callback, delay) => {
    const id = ++nextTimer;
    timers.set(id, { callback, delay });
    return id;
  };
  globalThis.clearTimeout = (id) => {
    cleared.push(id);
    timers.delete(id);
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
});

function assertTimerCleared() {
  assert.deepEqual(cleared, [1]);
  assert.equal(timers.size, 0);
}

function expireDeadline(delay) {
  assert.equal(timers.size, 1);
  const [{ callback, delay: actualDelay }] = timers.values();
  assert.equal(actualDelay, delay);
  callback();
}

test("chat asset requests return parsed JSON and clear the default ten-second deadline", async () => {
  const json = { emotes: ["Ready"] };
  let signal;
  globalThis.fetch = async (requestedUrl, options) => {
    assert.equal(requestedUrl, url);
    signal = options.signal;
    assert.ok(signal instanceof AbortSignal);
    assert.equal(signal.aborted, false);
    assert.equal([...timers.values()][0].delay, 10_000);
    return { ok: true, status: 201, json: async () => json };
  };
  assert.deepEqual(await fetchChatAssetJson(url), { status: 201, json });
  assert.equal(signal.aborted, false);
  assertTimerCleared();
});

test("a missing chat asset returns a 404 snapshot without reading a body", async () => {
  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    json: () => { throw new Error("404 body must not be parsed"); },
  });
  assert.deepEqual(await fetchChatAssetJson(url), { status: 404, json: null });
  assertTimerCleared();
});

for (const status of [403, 503]) {
  test(`HTTP ${status} chat asset failures return null without reading a body`, async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status,
      json: () => { throw new Error("error body must not be parsed"); },
    });
    assert.equal(await fetchChatAssetJson(url), null);
    assertTimerCleared();
  });
}

test("network failures return null and clear the deadline", async () => {
  globalThis.fetch = async () => { throw new Error("offline"); };
  assert.equal(await fetchChatAssetJson(url), null);
  assertTimerCleared();
});

test("invalid JSON returns null and clears the deadline", async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => { throw new SyntaxError("invalid JSON"); },
  });
  assert.equal(await fetchChatAssetJson(url), null);
  assertTimerCleared();
});

test("a stalled connection settles and aborts at the deadline even when fetch ignores abort", async () => {
  let signal;
  globalThis.fetch = (_url, options) => {
    signal = options.signal;
    return new Promise(() => {});
  };
  const result = fetchChatAssetJson(url, { deadlineMs: 25 });
  assert.equal(signal.aborted, false);
  expireDeadline(25);
  assert.equal(await result, null);
  assert.equal(signal.aborted, true);
  assertTimerCleared();
});

test("a stalled JSON body shares the deadline and settles even when parsing ignores abort", async () => {
  let signal;
  let bodyStarted = false;
  globalThis.fetch = async (_url, options) => {
    signal = options.signal;
    return {
      ok: true,
      status: 200,
      json: () => {
        bodyStarted = true;
        return new Promise(() => {});
      },
    };
  };
  const result = fetchChatAssetJson(url, { deadlineMs: 40 });
  await Promise.resolve();
  assert.equal(bodyStarted, true);
  assert.equal(signal.aborted, false);
  expireDeadline(40);
  assert.equal(await result, null);
  assert.equal(signal.aborted, true);
  assertTimerCleared();
});

test("a request body is sent as a JSON POST under a caller-chosen deadline", async () => {
  let request;
  globalThis.fetch = async (requestedUrl, options) => {
    request = { url: requestedUrl, ...options };
    assert.equal([...timers.values()][0].delay, 30_000);
    return { ok: true, status: 200, json: async () => ({ data: { ok: true } }) };
  };
  const body = { operationName: "Example", variables: { id: "42" } };
  assert.deepEqual(await fetchChatAssetJson(url, { body, deadlineMs: 30_000 }), {
    status: 200, json: { data: { ok: true } },
  });
  assert.equal(request.url, url);
  assert.equal(request.method, "POST");
  assert.equal(request.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(request.body), body);
  assertTimerCleared();
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("retained loads share one in-flight request and keep a success", async () => {
  const pending = deferred();
  let calls = 0;
  const retained = retainSuccess(() => { calls++; return pending.promise; });
  const first = retained.get();
  const second = retained.get();
  pending.resolve("ready");
  assert.deepEqual([await first, await second], ["ready", "ready"]);
  assert.equal(await retained.get(), "ready");
  assert.equal(calls, 1);
});

test("retained loads forget failures and rejections so the next caller retries", async () => {
  const results = [null, new Error("offline"), "recovered"];
  let calls = 0;
  const retained = retainSuccess(async () => {
    const result = results[calls++];
    if (result instanceof Error) throw result;
    return result;
  });
  assert.equal(await retained.get(), null);
  assert.equal(await retained.get(), null);
  assert.equal(await retained.get(), "recovered");
  assert.equal(await retained.get(), "recovered");
  assert.equal(calls, 3);
});

test("reloading replaces a retained success only when the new load succeeds", async () => {
  const results = ["first", null, "second"];
  let calls = 0;
  const retained = retainSuccess(async () => results[calls++]);
  assert.equal(await retained.get(), "first");
  assert.equal(await retained.reload(), null);
  assert.equal(await retained.get(), "first");
  assert.equal(await retained.reload(), "second");
  assert.equal(await retained.get(), "second");
  assert.equal(calls, 3);
});
