import assert from "node:assert/strict";
import { test } from "node:test";
import { SevenTvEvents } from "../src/seventv-events.ts";

class Clock {
  now = 0;
  sequence = 0;
  timers = new Map();

  setTimeout = (callback, delay) => {
    const id = ++this.sequence;
    this.timers.set(id, { callback, at: this.now + delay });
    return id;
  };

  clearTimeout = (id) => this.timers.delete(id);

  advance(milliseconds) {
    const end = this.now + milliseconds;
    for (;;) {
      const next = [...this.timers].filter(([, timer]) => timer.at <= end)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!next) break;
      const [id, timer] = next;
      this.timers.delete(id);
      this.now = timer.at;
      timer.callback();
    }
    this.now = end;
  }

  get nextDelay() {
    return Math.min(...[...this.timers.values()].map((timer) => timer.at - this.now));
  }
}

class Socket {
  readyState = 0;
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  sent = [];
  closed = 0;
  failSend = false;

  open() {
    this.readyState = 1;
    this.onopen?.({});
  }

  message(frame) {
    this.onmessage?.({ data: typeof frame === "string" ? frame : JSON.stringify(frame) });
  }

  hello(interval = 25_000) {
    this.open();
    this.message({ op: 1, d: { heartbeat_interval: interval, subscription_limit: 100 } });
  }

  send(message) {
    if (this.failSend) throw new Error("Socket closed while sending");
    this.sent.push(JSON.parse(message));
  }

  close() {
    this.readyState = 3;
    this.closed += 1;
  }

  serverClose(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const initial = { setIds: ["global", "channel"], userId: "user" };
const subscription = (type, id, op = 35) => ({ op, d: { type, condition: { object_id: id } } });
const dispatch = (type, id, changes = {}) => ({ op: 0, d: { type, body: { id, ...changes } } });
const ack = (type, id) => ({ op: 5, d: { command: "SUBSCRIBE", data: subscription(type, id).d } });

function fixture(overrides = {}) {
  const clock = new Clock();
  const sockets = [];
  const logs = [];
  let invalidations = 0;
  const client = new SevenTvEvents(() => { invalidations += 1; }, {
    createSocket: (url) => {
      assert.equal(url, "wss://events.7tv.io/v3");
      const socket = new Socket();
      sockets.push(socket);
      return socket;
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    random: () => 0,
    log: (message) => logs.push(message),
    ...overrides,
  });
  return { client, clock, sockets, logs, get invalidations() { return invalidations; } };
}

test("7TV watches global/current sets and the 7TV user once, after HELLO", () => {
  const f = fixture();
  f.client.watch({ setIds: ["global", "channel", "global", " ", " channel "], userId: " user " });
  assert.equal(f.sockets.length, 1);
  const socket = f.sockets[0];
  socket.open();
  assert.deepEqual(socket.sent, []);
  socket.hello();
  assert.deepEqual(socket.sent, [
    subscription("emote_set.update", "global"), subscription("emote_set.delete", "global"),
    subscription("emote_set.update", "channel"), subscription("emote_set.delete", "channel"),
    subscription("user.update", "user"),
  ]);
  assert.equal(f.invalidations, 1);
  f.client.watch(initial);
  f.client.watch({ setIds: ["channel", "global"], userId: "user" });
  socket.message({ op: 1, d: { heartbeat_interval: 25_000 } });
  assert.equal(socket.sent.length, 5);
  assert.equal(f.invalidations, 1);
  assert.equal(f.sockets.length, 1);
});

test("active set/user changes unsubscribe stale sources without duplicating global subscriptions", () => {
  const f = fixture();
  f.client.watch(initial);
  const socket = f.sockets[0];
  socket.hello();
  f.client.watch({ setIds: ["global", "replacement"], userId: "new-user" });
  assert.deepEqual(socket.sent.slice(5), [
    subscription("emote_set.update", "channel", 36), subscription("emote_set.delete", "channel", 36),
    subscription("user.update", "user", 36),
    subscription("emote_set.update", "replacement"), subscription("emote_set.delete", "replacement"),
    subscription("user.update", "new-user"),
  ]);
  socket.message(dispatch("emote_set.update", "channel"));
  socket.message(dispatch("user.update", "user"));
  socket.message(ack("emote_set.update", "channel"));
  assert.equal(f.invalidations, 1);
  socket.message(dispatch("emote_set.update", "replacement", { pushed: [{ key: "emotes" }] }));
  socket.message(dispatch("emote_set.delete", "global"));
  socket.message(dispatch("user.update", "new-user", { updated: [{ key: "connections" }] }));
  assert.equal(f.invalidations, 4);
});

test("watch changes before HELLO subscribe only the latest catalog", () => {
  const f = fixture();
  f.client.watch(initial);
  f.client.watch({ setIds: ["latest"], userId: null });
  f.sockets[0].hello();
  assert.deepEqual(f.sockets[0].sent, [subscription("emote_set.update", "latest"), subscription("emote_set.delete", "latest")]);
});

test("relevant subscribe acknowledgements resnapshot after delivery becomes active", () => {
  const f = fixture();
  f.client.watch(initial);
  const socket = f.sockets[0];
  socket.hello();
  socket.message(ack("emote_set.update", "global"));
  socket.message(ack("user.update", "user"));
  socket.message({ op: 5, d: { command: "UNSUBSCRIBE", data: subscription("user.update", "user").d } });
  socket.message(ack("emote_set.update", "unwatched"));
  assert.equal(f.invalidations, 3);
  f.client.watch(initial);
  assert.equal(socket.sent.length, 5);
});

test("malformed and unrelated events cannot invalidate the catalog", () => {
  const f = fixture();
  f.client.watch(initial);
  const socket = f.sockets[0];
  socket.message(dispatch("emote_set.update", "global"));
  socket.hello();
  for (const frame of ["not JSON", "null", "[]", {}, { op: "0", d: {} },
    { op: 0, d: { type: "emote_set.update", body: { id: 12 } } },
    { op: 0, d: { type: "emote_set.update", body: [] } },
    dispatch("emote_set.update", "elsewhere"), dispatch("cosmetic.create", "user"),
    { op: 5, d: { command: "SUBSCRIBE", data: {} } }, { op: 2, d: { count: "wrong" } },
    { op: 7, d: { code: "4007" } }]) socket.message(frame);
  socket.onmessage({ data: new ArrayBuffer(0) });
  assert.equal(f.invalidations, 1);
  assert.equal(socket.closed, 0);
});

test("dropped connections retry and resnapshot with the latest subscriptions", () => {
  const f = fixture();
  f.client.watch(initial);
  const old = f.sockets[0];
  old.hello();
  const staleMessage = old.onmessage;
  const staleClose = old.onclose;
  old.serverClose();
  assert.equal(f.clock.nextDelay, 1_000);
  f.client.watch({ setIds: ["new"], userId: null });
  f.clock.advance(1_000);
  const fresh = f.sockets[1];
  fresh.hello();
  assert.deepEqual(fresh.sent, [subscription("emote_set.update", "new"), subscription("emote_set.delete", "new")]);
  staleMessage({ data: JSON.stringify(dispatch("emote_set.update", "new")) });
  staleClose({ code: 4007 });
  assert.equal(f.invalidations, 2);
  assert.equal(fresh.closed, 0);
});

test("three missed heartbeats reconnect, while valid heartbeat refreshes the deadline", () => {
  const f = fixture();
  f.client.watch(initial);
  const socket = f.sockets[0];
  socket.hello(1_000);
  f.clock.advance(2_999);
  socket.message({ op: 2, d: { count: 1 } });
  f.clock.advance(2_999);
  assert.equal(socket.closed, 0);
  f.clock.advance(1);
  assert.equal(socket.closed, 1);
  f.clock.advance(1_000);
  assert.equal(f.sockets.length, 2);
});

test("connections stuck before HELLO time out, and invalid HELLO does not disable the watchdog", () => {
  const f = fixture();
  f.client.watch(initial);
  f.sockets[0].open();
  f.sockets[0].message({ op: 1, d: { heartbeat_interval: 0 } });
  f.clock.advance(15_000);
  assert.equal(f.sockets[0].closed, 1);
  f.clock.advance(1_000);
  assert.equal(f.sockets.length, 2);
  f.clock.advance(15_000);
  assert.equal(f.sockets[1].closed, 1);
  assert.equal(f.clock.nextDelay, 2_000);
});

test("rapid reconnect loops back off to a bounded maximum until a valid heartbeat", () => {
  const f = fixture();
  f.client.watch(initial);
  for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
    const socket = f.sockets.at(-1);
    socket.hello();
    socket.serverClose();
    assert.equal(f.clock.nextDelay, delay);
    f.clock.advance(delay);
  }
  const healthy = f.sockets.at(-1);
  healthy.hello();
  healthy.message({ op: 2, d: { count: 0 } });
  healthy.serverClose();
  assert.equal(f.clock.nextDelay, 1_000);
});

test("RECONNECT waits for END_OF_STREAM and honors maintenance's five minute minimum", () => {
  const f = fixture({ random: () => 0.5 });
  f.client.watch(initial);
  const socket = f.sockets[0];
  socket.hello();
  socket.message({ op: 4, d: { reason: "Restarting" } });
  assert.equal(socket.closed, 0);
  socket.message({ op: 7, d: { code: 4007, message: "Maintenance Mode" } });
  assert.equal(socket.closed, 1);
  assert.equal(f.clock.nextDelay, 330_000);
  f.clock.advance(329_999);
  assert.equal(f.sockets.length, 1);
  f.clock.advance(1);
  assert.equal(f.sockets.length, 2);
});

test("a reconnect request without a subsequent close still reconnects after its watchdog", () => {
  const f = fixture();
  f.client.watch(initial);
  const socket = f.sockets[0];
  socket.hello();
  socket.message({ op: 4, d: {} });
  f.clock.advance(4_000);
  socket.message({ op: 2, d: { count: 1 } });
  f.clock.advance(1_000);
  assert.equal(socket.closed, 1);
  f.clock.advance(1_000);
  assert.equal(f.sockets.length, 2);
});

test("protocol, privilege, and rate-limit rejections do not create reconnect storms", () => {
  for (const code of [1008, 4001, 4002, 4003, 4004, 4005, 4009, 4010, 4011]) {
    const f = fixture();
    f.client.watch(initial);
    f.sockets[0].hello();
    f.sockets[0].message({ op: 7, d: { code } });
    f.client.watch({ setIds: ["new-catalog"], userId: null });
    f.clock.advance(600_000);
    assert.equal(f.sockets.length, 1, `code ${code}`);
    assert.equal(f.clock.timers.size, 0);
    assert.ok(f.logs.some((log) => log.includes("stopped after rejection")));
    f.client.disconnect();
    f.client.watch(initial);
    assert.equal(f.sockets.length, 2);
  }
});

test("ERROR logs its message and waits for the authoritative close reason", () => {
  const f = fixture();
  f.client.watch(initial);
  const socket = f.sockets[0];
  socket.hello();
  socket.message({ op: 6, d: { message: "Subscription failed", fields: {} } });
  assert.equal(socket.closed, 0);
  assert.ok(f.logs[0].includes("Subscription failed"));
  socket.message({ op: 7, d: { code: 4000 } });
  assert.equal(f.clock.nextDelay, 1_000);
  f.clock.advance(1_000);
  f.sockets[1].hello();
  f.sockets[1].message({ op: 6, d: { message: "Invalid subscription" } });
  f.sockets[1].serverClose(1006);
  assert.equal(f.clock.timers.size, 0);
  assert.equal(f.sockets.length, 2);
});

test("disconnect and dispose cancel retries and ignore already queued old handlers/timers", () => {
  const f = fixture();
  f.client.watch(initial);
  const socket = f.sockets[0];
  socket.hello();
  const message = socket.onmessage;
  const close = socket.onclose;
  socket.serverClose();
  const retry = [...f.clock.timers.values()][0].callback;
  f.client.disconnect();
  retry();
  message({ data: JSON.stringify(dispatch("emote_set.update", "global")) });
  close({ code: 1006 });
  f.clock.advance(600_000);
  assert.equal(f.sockets.length, 1);
  assert.equal(f.invalidations, 1);
  f.client.watch(initial);
  assert.equal(f.sockets.length, 2);
  f.client.dispose();
  f.client.watch(initial);
  f.clock.advance(600_000);
  assert.equal(f.sockets.length, 2);
  assert.equal(f.clock.timers.size, 0);
});

test("removing all watches ends a connecting socket without a retry", () => {
  const f = fixture();
  f.client.watch(initial);
  const oldHello = f.sockets[0].onmessage;
  f.client.watch({ setIds: [], userId: null });
  oldHello({ data: JSON.stringify({ op: 1, d: { heartbeat_interval: 25_000 } }) });
  f.clock.advance(600_000);
  assert.equal(f.sockets[0].closed, 1);
  assert.equal(f.invalidations, 0);
  assert.equal(f.clock.timers.size, 0);
});

test("socket construction and send failures recover with backoff", () => {
  const clock = new Clock();
  const socket = new Socket();
  let calls = 0;
  const client = new SevenTvEvents(() => {}, {
    createSocket: () => {
      calls += 1;
      if (calls === 1) throw new Error("Unavailable");
      return socket;
    },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, random: () => 0, log: () => {},
  });
  client.watch(initial);
  assert.equal(clock.nextDelay, 1_000);
  clock.advance(1_000);
  socket.failSend = true;
  socket.hello();
  assert.equal(socket.closed, 1);
  assert.equal(clock.nextDelay, 2_000);
  client.dispose();
});
