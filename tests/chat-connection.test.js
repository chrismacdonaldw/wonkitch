import assert from "node:assert/strict";
import { test } from "node:test";
import { TwitchChat } from "../src/chat.ts";

class Clock {
  now = 0;
  sequence = 0;
  timers = new Map();

  setTimeout = (callback, delay) => {
    assert.ok(Number.isFinite(delay) && delay >= 0, "timer delay is finite and nonnegative");
    const id = ++this.sequence;
    this.timers.set(id, { callback, at: this.now + delay });
    return id;
  };

  clearTimeout = (id) => this.timers.delete(id);

  advance(milliseconds) {
    const end = this.now + milliseconds;
    let count = 0;
    for (;;) {
      const next = [...this.timers].filter(([, timer]) => timer.at <= end)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!next) break;
      assert.ok(++count < 1_000, "timers cannot form an immediate retry loop");
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
  failClose = false;

  open() {
    this.readyState = 1;
    this.onopen?.({});
  }

  message(line) {
    this.onmessage?.({ data: `${line}\r\n` });
  }

  joined(channel = "example") {
    this.open();
    this.message(`@room-id=42 :tmi.twitch.tv ROOMSTATE #${channel}`);
  }

  send(message) {
    if (this.failSend) throw new Error("Network vanished during send");
    this.sent.push(message);
  }

  close() {
    this.closed += 1;
    this.readyState = 3;
    if (this.failClose) throw new Error("Socket close failed");
    // A blackholed socket may never deliver its close event.
  }

  serverClose() {
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }

  probeToken() {
    const ping = this.sent.findLast((line) => line.startsWith("PING "));
    assert.ok(ping, "the client sends its own liveness probe");
    return ping.trim().replace(/^PING\s+:?/, "");
  }

  pong(token = this.probeToken()) {
    this.message(`:tmi.twitch.tv PONG tmi.twitch.tv :${token}`);
  }
}

class Network extends EventTarget {
  online = true;
  listeners = new Map();

  addEventListener(type, listener, options) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
    super.addEventListener(type, listener, options);
  }

  removeEventListener(type, listener, options) {
    this.listeners.get(type)?.delete(listener);
    super.removeEventListener(type, listener, options);
  }

  change(online) {
    this.online = online;
    this.dispatchEvent(new Event(online ? "online" : "offline"));
  }
}

function fixture(t, overrides = {}, callbacks = {}) {
  const clock = new Clock();
  const sockets = [];
  const states = [];
  const rooms = [];
  const messages = [];
  const network = new Network();
  const client = new TwitchChat({
    onState: (state) => states.push(state),
    onRoom: (room) => rooms.push(room),
    onMessage: (message) => messages.push(message),
    ...callbacks,
  }, {
    createSocket: (url) => {
      assert.equal(url, "wss://irc-ws.chat.twitch.tv:443");
      const socket = new Socket();
      sockets.push(socket);
      return socket;
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: () => clock.now,
    random: () => 0,
    networkTarget: network,
    isOnline: () => network.online,
    ...overrides,
  });
  t.after(() => client.dispose());
  return { client, clock, sockets, states, rooms, messages, network };
}

function receiveMessage(socket, channel = "example", text = "hello") {
  socket.message(`@id=message;display-name=Viewer :viewer!viewer@viewer.tmi.twitch.tv PRIVMSG #${channel} :${text}`);
}

test("chat establishes the IRC session and reports connected only after joining", (t) => {
  const f = fixture(t);
  f.client.connect("example");
  assert.equal(f.states.at(-1), "connecting");
  assert.equal(f.sockets.length, 1);
  const socket = f.sockets[0];
  socket.open();
  assert.ok(socket.sent.includes("CAP REQ :twitch.tv/tags twitch.tv/commands\r\n"));
  assert.ok(socket.sent.includes("PASS SCHMOOPIIE\r\n"));
  assert.ok(socket.sent.some((line) => /^NICK justinfan\d+\r\n$/.test(line)));
  assert.ok(socket.sent.includes("JOIN #example\r\n"));
  assert.equal(f.states.at(-1), "connecting");
  socket.message("@room-id=42 :tmi.twitch.tv ROOMSTATE #example");
  assert.equal(f.states.at(-1), "connected");
  assert.deepEqual(f.rooms, ["42"]);
  receiveMessage(socket);
  assert.equal(f.messages[0].text, "hello");
});

test("quiet healthy chat answers client probes without reconnecting", (t) => {
  const f = fixture(t);
  f.client.connect("example");
  const socket = f.sockets[0];
  socket.joined();
  for (let cycle = 0; cycle < 8; cycle += 1) {
    f.clock.advance(5_000);
    socket.pong();
    assert.equal(socket.closed, 0);
    assert.equal(f.states.at(-1), "connected");
  }
  assert.equal(f.sockets.length, 1);
  assert.equal(socket.sent.filter((line) => line.startsWith("PING ")).length, 8);
});

test("a silently blackholed chat reconnects after a missed probe without waiting for close", (t) => {
  const f = fixture(t);
  f.client.connect("example");
  const socket = f.sockets[0];
  socket.joined();
  f.clock.advance(4_999);
  assert.equal(socket.sent.filter((line) => line.startsWith("PING ")).length, 0);
  f.clock.advance(1);
  socket.probeToken();
  f.clock.advance(4_999);
  assert.equal(socket.closed, 0);
  f.clock.advance(1);
  assert.equal(socket.closed, 1);
  assert.equal(f.states.at(-1), "reconnecting");
  assert.ok(f.clock.nextDelay >= 100 && f.clock.nextDelay <= 500);
  f.clock.advance(500);
  assert.equal(f.sockets.length, 2);
  f.sockets[1].joined();
  assert.equal(f.states.at(-1), "connected");
});

test("an unrelated PONG cannot acknowledge an outstanding client probe", (t) => {
  const f = fixture(t);
  f.client.connect("example");
  const socket = f.sockets[0];
  socket.joined();
  f.clock.advance(5_000);
  const token = socket.probeToken();
  f.clock.advance(4_999);
  socket.pong(`${token}-wrong`);
  f.clock.advance(1);
  assert.equal(socket.closed, 1);
  assert.equal(f.states.at(-1), "reconnecting");
});

test("Twitch server PING is answered with the original payload", (t) => {
  const f = fixture(t);
  f.client.connect("example");
  const socket = f.sockets[0];
  socket.joined();
  socket.message("PING :tmi.twitch.tv");
  assert.equal(socket.sent.at(-1), "PONG :tmi.twitch.tv\r\n");
  assert.equal(socket.closed, 0);
});

test("a socket stuck opening has an eight second connection deadline", (t) => {
  const f = fixture(t);
  f.client.connect("example");
  const socket = f.sockets[0];
  f.clock.advance(7_999);
  assert.equal(socket.closed, 0);
  f.clock.advance(1);
  assert.equal(socket.closed, 1);
  assert.equal(f.states.at(-1), "reconnecting");
  f.clock.advance(500);
  assert.equal(f.sockets.length, 2);
});

test("opening the transport does not extend the eight second room join deadline", (t) => {
  const f = fixture(t);
  f.client.connect("example");
  const socket = f.sockets[0];
  f.clock.advance(7_000);
  socket.open();
  f.clock.advance(999);
  assert.equal(socket.closed, 0);
  f.clock.advance(1);
  assert.equal(socket.closed, 1);
  assert.equal(f.states.at(-1), "reconnecting");
});

test("socket errors retire immediately and stale error/close callbacks cannot duplicate retries", (t) => {
  const f = fixture(t);
  f.client.connect("example");
  const socket = f.sockets[0];
  socket.joined();
  const staleError = socket.onerror;
  const staleClose = socket.onclose;
  f.clock.advance(1_000);
  staleError({});
  assert.equal(socket.closed, 1);
  assert.equal(f.states.at(-1), "reconnecting");
  staleError({});
  staleClose({ code: 1006 });
  assert.equal(f.clock.timers.size, 1);
  f.clock.advance(500);
  assert.equal(f.sockets.length, 2);
  assert.equal(f.sockets[1].closed, 0);
});

test("synchronous transport construction errors still schedule a bounded retry", (t) => {
  let attempts = 0;
  const f = fixture(t, {
    createSocket: () => {
      attempts += 1;
      throw new Error("Network is unavailable");
    },
  });
  assert.doesNotThrow(() => f.client.connect("example"));
  assert.equal(f.states.at(-1), "reconnecting");
  assert.equal(attempts, 1);
  assert.ok(f.clock.nextDelay >= 1_000 && f.clock.nextDelay <= 1_500);
  f.clock.advance(1_000);
  assert.equal(attempts, 2);
  assert.equal(f.clock.timers.size, 1);
});

test("a handshake send failure starts recovery even when close never arrives", (t) => {
  const f = fixture(t);
  f.client.connect("example");
  const socket = f.sockets[0];
  socket.failSend = true;
  f.clock.advance(1_000);
  assert.doesNotThrow(() => socket.open());
  assert.equal(socket.closed, 1);
  assert.equal(f.states.at(-1), "reconnecting");
  f.clock.advance(500);
  assert.equal(f.sockets.length, 2);
});

test("a heartbeat send failure starts recovery without an uncaught timer error", (t) => {
  const f = fixture(t);
  f.client.connect("example");
  const socket = f.sockets[0];
  socket.joined();
  socket.failSend = true;
  assert.doesNotThrow(() => f.clock.advance(5_000));
  assert.equal(socket.closed, 1);
  assert.equal(f.states.at(-1), "reconnecting");
});

test("Twitch RECONNECT retires the old socket and promptly rejoins", (t) => {
  const f = fixture(t);
  f.client.connect("example");
  const socket = f.sockets[0];
  socket.joined();
  f.clock.advance(1_000);
  socket.message(":tmi.twitch.tv RECONNECT");
  assert.equal(socket.closed, 1);
  assert.equal(f.states.at(-1), "reconnecting");
  assert.ok(f.clock.nextDelay >= 0 && f.clock.nextDelay <= 500);
  f.clock.advance(500);
  assert.equal(f.sockets.length, 2);
  f.sockets[1].joined();
  assert.equal(f.states.at(-1), "connected");
});

test("offline pauses all attempts and online immediately opens a fresh chat socket", (t) => {
  const f = fixture(t);
  f.client.connect("example");
  const socket = f.sockets[0];
  socket.joined();
  f.network.change(false);
  assert.equal(f.states.at(-1), "waiting");
  assert.equal(socket.closed, 1);
  assert.equal(f.clock.timers.size, 0);
  f.clock.advance(60_000);
  assert.equal(f.sockets.length, 1);
  f.network.change(true);
  assert.equal(f.sockets.length, 2);
  assert.ok(["connecting", "reconnecting"].includes(f.states.at(-1)));
  f.sockets[1].joined();
  assert.equal(f.states.at(-1), "connected");
});

test("joining while offline waits without constructing a socket", (t) => {
  const f = fixture(t);
  f.network.change(false);
  f.client.connect("example");
  assert.equal(f.states.at(-1), "waiting");
  assert.equal(f.sockets.length, 0);
  assert.equal(f.clock.timers.size, 0);
  f.network.change(true);
  assert.equal(f.sockets.length, 1);
});

test("manual retry makes one attempt despite a stale offline hint then waits if it fails", (t) => {
  const f = fixture(t);
  f.network.change(false);
  f.client.connect("example");
  assert.equal(f.states.at(-1), "waiting");
  f.client.reconnect();
  assert.equal(f.sockets.length, 1);
  assert.ok(["connecting", "reconnecting"].includes(f.states.at(-1)));
  f.sockets[0].serverClose();
  assert.equal(f.states.at(-1), "waiting");
  assert.equal(f.clock.timers.size, 0);
  f.clock.advance(60_000);
  assert.equal(f.sockets.length, 1);
});

test("manual retries while offline remain limited to one socket attempt per second", (t) => {
  const f = fixture(t);
  f.network.change(false);
  f.client.connect("example");
  f.client.reconnect();
  f.sockets[0].serverClose();
  for (let click = 0; click < 100; click += 1) f.client.reconnect();
  assert.equal(f.sockets.length, 1);
  assert.equal(f.clock.timers.size, 1);
  f.clock.advance(999);
  assert.equal(f.sockets.length, 1);
  f.clock.advance(1);
  assert.equal(f.sockets.length, 2);
  f.sockets[1].serverClose();
  assert.equal(f.states.at(-1), "waiting");
  assert.equal(f.clock.timers.size, 0);
});

test("a new offline event cancels a queued manual attempt", (t) => {
  const f = fixture(t);
  f.network.change(false);
  f.client.connect("example");
  f.client.reconnect();
  f.sockets[0].serverClose();
  f.client.reconnect();
  assert.equal(f.clock.timers.size, 1);
  f.network.change(false);
  assert.equal(f.states.at(-1), "waiting");
  assert.equal(f.clock.timers.size, 0);
  f.clock.advance(60_000);
  assert.equal(f.sockets.length, 1);
});

test("an online wakeup tries once when the offline hint has not caught up", (t) => {
  const f = fixture(t);
  f.network.change(false);
  f.client.connect("example");
  f.network.dispatchEvent(new Event("online"));
  assert.equal(f.network.online, false);
  assert.equal(f.sockets.length, 1);
  f.sockets[0].serverClose();
  assert.equal(f.states.at(-1), "waiting");
  assert.equal(f.clock.timers.size, 0);
  f.clock.advance(60_000);
  assert.equal(f.sockets.length, 1);
});

test("network restoration skips a long retry backoff while respecting the open rate limit", (t) => {
  const f = fixture(t);
  f.client.connect("example");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    f.sockets.at(-1).serverClose();
    f.clock.advance(f.clock.nextDelay);
  }
  f.sockets.at(-1).serverClose();
  assert.ok(f.clock.nextDelay >= 8_000);
  const before = f.sockets.length;
  f.clock.advance(1_000);
  f.network.change(true);
  assert.equal(f.sockets.length, before + 1);
  f.sockets.at(-1).joined();
  assert.equal(f.states.at(-1), "connected");
});

test("manual retry replaces a stalled socket and repeated clicks cannot create a socket storm", (t) => {
  const f = fixture(t);
  f.client.connect("example");
  f.sockets[0].joined();
  f.clock.advance(1_000);
  f.client.reconnect();
  assert.equal(f.sockets[0].closed, 1);
  assert.equal(f.sockets.length, 2);
  for (let click = 0; click < 100; click += 1) f.client.reconnect();
  assert.equal(f.sockets.length, 2);
  assert.equal(f.clock.timers.size, 1);
  f.clock.advance(999);
  assert.equal(f.sockets.length, 2);
  f.clock.advance(1);
  assert.equal(f.sockets.length, 3);
  f.sockets.at(-1).joined();
  assert.equal(f.states.at(-1), "connected");
});

test("online events probe a healthy socket instead of interrupting it", (t) => {
  const f = fixture(t);
  f.client.connect("example");
  const socket = f.sockets[0];
  socket.joined();
  f.clock.advance(1_000);
  f.network.change(true);
  socket.pong();
  assert.equal(socket.closed, 0);
  assert.equal(f.sockets.length, 1);
  assert.equal(f.states.at(-1), "connected");
  f.clock.advance(5_000);
  socket.pong();
  assert.equal(socket.closed, 0);
});

test("late handlers from an old channel cannot send, deliver messages, or close its replacement", (t) => {
  const f = fixture(t);
  f.client.connect("first");
  const old = f.sockets[0];
  old.joined("first");
  const stale = { open: old.onopen, message: old.onmessage, close: old.onclose, error: old.onerror };
  f.client.connect("second");
  const fresh = f.sockets[1];
  fresh.joined("second");
  const sentCount = old.sent.length;
  const stateCount = f.states.length;
  stale.open({});
  stale.message({ data: "PING :old\r\n@room-id=old :tmi.twitch.tv ROOMSTATE #first\r\n:viewer!v@v PRIVMSG #first :stale\r\n:tmi.twitch.tv RECONNECT\r\n" });
  stale.close({ code: 1006 });
  stale.error({});
  assert.equal(old.sent.length, sentCount);
  assert.equal(f.states.length, stateCount);
  assert.equal(f.messages.length, 0);
  assert.deepEqual(f.rooms, ["42", "42"]);
  assert.equal(fresh.closed, 0);
  assert.equal(f.sockets.length, 2);
  assert.equal(f.clock.timers.size, 1);
});

test("late handlers from a replaced socket in the same channel cannot affect recovery", (t) => {
  const f = fixture(t);
  f.client.connect("example");
  const old = f.sockets[0];
  old.joined();
  const stale = { open: old.onopen, message: old.onmessage, close: old.onclose, error: old.onerror };
  old.serverClose();
  f.clock.advance(f.clock.nextDelay);
  const fresh = f.sockets[1];
  fresh.joined();
  const sentCount = old.sent.length;
  const stateCount = f.states.length;
  stale.open({});
  stale.message({ data: "PING :old\r\n@room-id=old :tmi.twitch.tv ROOMSTATE #example\r\n:viewer!v@v PRIVMSG #example :stale\r\n:tmi.twitch.tv RECONNECT\r\n" });
  stale.close({ code: 1006 });
  stale.error({});
  assert.equal(old.sent.length, sentCount);
  assert.equal(f.states.length, stateCount);
  assert.equal(f.messages.length, 0);
  assert.deepEqual(f.rooms, ["42", "42"]);
  assert.equal(fresh.closed, 0);
  assert.equal(f.clock.timers.size, 1);
});

test("disconnecting from a room callback cannot publish connected or process the old batch", (t) => {
  const f = fixture(t, {}, { onRoom: () => f.client.disconnect() });
  f.client.connect("example");
  const socket = f.sockets[0];
  socket.open();
  socket.message("@room-id=42 :tmi.twitch.tv ROOMSTATE #example\r\n:viewer!v@v PRIVMSG #example :stale");
  assert.equal(f.states.at(-1), "offline");
  assert.equal(f.states.includes("connected"), false);
  assert.equal(f.messages.length, 0);
  assert.equal(f.clock.timers.size, 0);
});

test("changing channel from a message callback stops the old incoming batch", (t) => {
  const seen = [];
  const f = fixture(t, {}, {
    onMessage: (message) => {
      seen.push(message.text);
      f.client.connect("next");
    },
  });
  f.client.connect("example");
  const socket = f.sockets[0];
  socket.joined();
  socket.message(":viewer!v@v PRIVMSG #example :first\r\n:viewer!v@v PRIVMSG #example :stale");
  assert.deepEqual(seen, ["first"]);
  assert.equal(f.sockets.length, 2);
  f.sockets[1].open();
  assert.ok(f.sockets[1].sent.includes("JOIN #next\r\n"));
});

test("repeated failures back off with one pending retry and a bounded maximum", (t) => {
  const f = fixture(t);
  f.client.connect("example");
  let previous = 0;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const socket = f.sockets.at(-1);
    socket.serverClose();
    const delay = f.clock.nextDelay;
    assert.ok(delay >= previous, "retries do not get faster during a persistent outage");
    assert.ok(delay >= 100 && delay <= 15_500, "retry delay remains bounded");
    assert.equal(f.clock.timers.size, 1);
    previous = delay;
    const count = f.sockets.length;
    f.clock.advance(delay - 1);
    assert.equal(f.sockets.length, count);
    f.clock.advance(1);
    assert.equal(f.sockets.length, count + 1);
  }
});

test("disconnect cancels pending retries and network events cannot reopen chat", (t) => {
  const f = fixture(t);
  f.client.connect("example");
  f.sockets[0].serverClose();
  f.client.disconnect();
  assert.equal(f.states.at(-1), "offline");
  assert.equal(f.clock.timers.size, 0);
  f.network.change(false);
  f.network.change(true);
  f.client.reconnect();
  f.clock.advance(60_000);
  assert.equal(f.sockets.length, 1);
  assert.equal(f.states.at(-1), "offline");
});

test("a throwing close operation cannot strand recovery or disconnect", (t) => {
  const f = fixture(t);
  f.client.connect("example");
  const old = f.sockets[0];
  old.joined();
  old.failClose = true;
  assert.doesNotThrow(() => old.onerror({}));
  assert.equal(f.states.at(-1), "reconnecting");
  f.clock.advance(f.clock.nextDelay);
  assert.equal(f.sockets.length, 2);
  f.sockets[1].failClose = true;
  assert.doesNotThrow(() => f.client.disconnect());
  assert.equal(f.states.at(-1), "offline");
  assert.equal(f.clock.timers.size, 0);
});

test("dispose removes network listeners and permanently prevents new connections", (t) => {
  const f = fixture(t);
  f.client.connect("example");
  f.sockets[0].joined();
  assert.ok(f.network.listeners.get("online")?.size);
  assert.ok(f.network.listeners.get("offline")?.size);
  f.client.dispose();
  assert.equal(f.network.listeners.get("online").size, 0);
  assert.equal(f.network.listeners.get("offline").size, 0);
  assert.equal(f.clock.timers.size, 0);
  f.network.change(false);
  f.network.change(true);
  f.client.connect("second");
  f.client.reconnect();
  f.clock.advance(60_000);
  assert.equal(f.sockets.length, 1);
  assert.equal(f.states.at(-1), "offline");
});
