export interface SevenTvSubscription {
  setIds: string[];
  userId: string | null;
}

export type SevenTvSocket = Pick<WebSocket,
  "readyState" | "onopen" | "onmessage" | "onclose" | "onerror" | "send" | "close">;

export interface SevenTvEventDependencies {
  createSocket(url: string): SevenTvSocket;
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(timer: number): void;
  random(): number;
  log(message: string): void;
}

interface Subscription {
  type: "emote_set.update" | "emote_set.delete" | "user.update";
  condition: { object_id: string };
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function subscriptionKey(type: string, id: string): string {
  return `${type}:${id}`;
}

function subscriptions(watch: SevenTvSubscription): Map<string, Subscription> {
  const result = new Map<string, Subscription>();
  for (const rawId of watch.setIds) {
    const id = rawId.trim();
    if (!id) continue;
    for (const type of ["emote_set.update", "emote_set.delete"] as const) {
      result.set(subscriptionKey(type, id), { type, condition: { object_id: id } });
    }
  }
  const userId = watch.userId?.trim();
  if (userId) result.set(subscriptionKey("user.update", userId), {
    type: "user.update", condition: { object_id: userId },
  });
  return result;
}

const permanentCloseCodes = new Set([1002, 1007, 1008, 1009, 1010,
  4001, 4002, 4003, 4004, 4005, 4009, 4010, 4011]);
const explicitRetryCodes = new Set([4000, 4006, 4008, 4012, 4013]);

// Notifications invalidate the REST snapshot instead of trusting event deltas:
// reconnects may miss changes, and aliases/active sets must remain authoritative.
export class SevenTvEvents {
  private readonly dependencies: SevenTvEventDependencies;
  private desired = new Map<string, Subscription>();
  private sent = new Map<string, Subscription>();
  private socket: SevenTvSocket | null = null;
  private deadlineTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private heartbeatInterval = 25_000;
  private hello = false;
  private protocolError = false;
  private reconnectRequested = false;
  private attempts = 0;
  private epoch = 0;
  private blocked = false;
  private disposed = false;

  constructor(
    private readonly onInvalidate: () => void,
    dependencies: Partial<SevenTvEventDependencies> = {},
  ) {
    this.dependencies = {
      createSocket: (url) => new WebSocket(url),
      setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
      clearTimeout: (timer) => globalThis.clearTimeout(timer),
      random: Math.random,
      log: (message) => console.warn(message),
      ...dependencies,
    };
  }

  watch(watch: SevenTvSubscription): void {
    if (this.disposed) return;
    this.desired = subscriptions(watch);
    if (!this.desired.size) {
      this.disconnect();
      return;
    }
    // Catalog refreshes must not undo a protocol/rate-limit rejection. An
    // explicit disconnect (channel change or disabling emotes) starts afresh.
    if (this.blocked) return;
    if (!this.socket && this.reconnectTimer === null) this.connect();
    else if (this.socket && this.hello) this.syncSubscriptions(this.socket);
  }

  disconnect(): void {
    this.epoch += 1;
    this.desired.clear();
    this.blocked = false;
    this.attempts = 0;
    this.cancelReconnect();
    this.retireSocket();
  }

  dispose(): void {
    this.disconnect();
    this.disposed = true;
  }

  private connect(): void {
    if (!this.active()) return;
    this.epoch += 1;
    let socket: SevenTvSocket;
    try {
      socket = this.dependencies.createSocket("wss://events.7tv.io/v3");
    } catch {
      this.dependencies.log("7TV live updates could not connect; retrying.");
      this.scheduleReconnect(1006, false);
      return;
    }
    this.socket = socket;
    this.hello = false;
    this.protocolError = false;
    this.reconnectRequested = false;
    this.sent.clear();
    socket.onopen = () => {
      if (this.current(socket)) this.armDeadline(socket, 15_000);
    };
    socket.onmessage = (event) => {
      if (this.current(socket)) this.receive(socket, event.data);
    };
    socket.onclose = (event) => {
      if (this.current(socket)) this.fail(event.code);
    };
    // Browsers generally follow error with close. Keep its close reason, and
    // use the deadline if a platform fails to deliver the close event.
    socket.onerror = () => {};
    this.armDeadline(socket, 15_000);
  }

  private receive(socket: SevenTvSocket, raw: unknown): void {
    if (typeof raw !== "string") return;
    let frame: Record<string, unknown> | null;
    try { frame = object(JSON.parse(raw)); } catch { return; }
    const data = object(frame?.d);
    if (!frame || !data) return;
    switch (frame.op) {
      case 1: {
        const interval = data.heartbeat_interval;
        if (this.hello || typeof interval !== "number" || !Number.isFinite(interval) || interval <= 0) return;
        this.hello = true;
        this.heartbeatInterval = Math.max(1_000, Math.min(120_000, interval));
        this.armDeadline(socket, this.heartbeatInterval * 3);
        this.syncSubscriptions(socket);
        if (this.current(socket)) this.invalidate();
        break;
      }
      case 2:
        if (!this.hello || typeof data.count !== "number" || !Number.isFinite(data.count) || data.count < 0) return;
        this.attempts = 0;
        if (!this.reconnectRequested) this.armDeadline(socket, this.heartbeatInterval * 3);
        break;
      case 0: {
        if (!this.hello || typeof data.type !== "string") return;
        const body = object(data.body);
        if (typeof body?.id !== "string") return;
        if (this.desired.has(subscriptionKey(data.type, body.id))) this.invalidate();
        break;
      }
      case 5: {
        if (!this.hello || typeof data.command !== "string" || data.command.toUpperCase() !== "SUBSCRIBE") return;
        const acknowledged = object(data.data);
        const condition = object(acknowledged?.condition);
        if (typeof acknowledged?.type !== "string" || typeof condition?.object_id !== "string") return;
        const key = subscriptionKey(acknowledged.type, condition.object_id);
        // Resnapshot after the subscription becomes active, closing the gap
        // between the initial REST response and starting event delivery.
        if (this.desired.has(key) && this.sent.has(key)) this.invalidate();
        break;
      }
      case 4:
        this.reconnectRequested = true;
        // Current 7TV sends END_OF_STREAM after RECONNECT. Briefly retain the
        // socket to receive the authoritative reason (including maintenance).
        this.armDeadline(socket, 5_000);
        break;
      case 6:
        if (typeof data.message !== "string") return;
        this.protocolError = true;
        this.dependencies.log(`7TV live update error: ${data.message}`);
        break;
      case 7:
        if (typeof data.code === "number" && Number.isInteger(data.code)) this.fail(data.code);
        break;
    }
  }

  private syncSubscriptions(socket: SevenTvSocket): void {
    if (!this.current(socket) || socket.readyState !== 1) return;
    try {
      for (const [key, subscription] of this.sent) {
        if (!this.desired.has(key)) {
          socket.send(JSON.stringify({ op: 36, d: subscription }));
          this.sent.delete(key);
        }
      }
      for (const [key, subscription] of this.desired) {
        if (!this.sent.has(key)) {
          socket.send(JSON.stringify({ op: 35, d: subscription }));
          this.sent.set(key, subscription);
        }
      }
    } catch {
      this.fail(1006);
    }
  }

  private invalidate(): void {
    try { this.onInvalidate(); } catch {
      this.dependencies.log("7TV live update refresh failed.");
    }
  }

  private armDeadline(socket: SevenTvSocket, delay: number): void {
    this.cancelDeadline();
    const timer = this.dependencies.setTimeout(() => {
      if (this.current(socket) && this.deadlineTimer === timer) this.fail(1006);
    }, delay);
    this.deadlineTimer = timer;
  }

  private fail(code: number): void {
    const protocolError = this.protocolError && !this.reconnectRequested;
    this.retireSocket();
    this.scheduleReconnect(code, protocolError);
  }

  private scheduleReconnect(code: number, protocolError: boolean): void {
    if (!this.active() || this.reconnectTimer !== null) return;
    const maintenance = code === 4007 || code === 1013;
    if (permanentCloseCodes.has(code) || (protocolError && !maintenance && !explicitRetryCodes.has(code))) {
      this.blocked = true;
      this.dependencies.log(`7TV live updates stopped after rejection (${code}).`);
      return;
    }
    const jitter = Math.max(0, Math.min(1, this.dependencies.random()));
    const base = Math.min(30_000, 1_000 * 2 ** Math.min(this.attempts, 5));
    const delay = maintenance ? 300_000 + jitter * 60_000 : Math.min(30_000, base * (1 + jitter * 0.25));
    this.attempts += 1;
    const epoch = this.epoch;
    const timer = this.dependencies.setTimeout(() => {
      if (epoch !== this.epoch || this.reconnectTimer !== timer || !this.active()) return;
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer = timer;
  }

  private current(socket: SevenTvSocket): boolean {
    return this.active() && this.socket === socket;
  }

  private active(): boolean {
    return !this.disposed && !this.blocked && this.desired.size > 0;
  }

  private retireSocket(): void {
    this.cancelDeadline();
    const socket = this.socket;
    this.socket = null;
    this.sent.clear();
    this.hello = false;
    this.protocolError = false;
    this.reconnectRequested = false;
    if (!socket) return;
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    try { socket.close(1000, "7TV watch ended"); } catch { /* Already closed. */ }
  }

  private cancelDeadline(): void {
    if (this.deadlineTimer !== null) this.dependencies.clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) this.dependencies.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}
