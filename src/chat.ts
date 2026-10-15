export type ChatConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "waiting"
  | "offline";

export interface ChatReply {
  messageId: string;
  userId: string;
  login: string;
  displayName: string;
  body?: string;
  threadRootMessageId?: string;
  threadRootUserId?: string;
  threadRootLogin?: string;
  threadRootDisplayName?: string;
}

export interface ChatModeration {
  messageId?: string;
  userId?: string;
  login?: string;
  clearAll?: boolean;
}

export interface ChatMessage {
  id: string;
  userId?: string;
  login: string;
  displayName: string;
  color: string;
  text: string;
  badges: string[];
  emoteTag: string;
  gifTag?: string;
  isGigantifiedEmote: boolean;
  reply: ChatReply | null;
  timestamp: number;
  isAction: boolean;
  isNotice: boolean;
  isFirstMessage: boolean;
  /** USERNOTICE's system header accompanies the rich user-authored body. */
  noticeText?: string;
  noticeType?: string;
  moderation?: ChatModeration;
}

interface ChatCallbacks {
  onState: (state: ChatConnectionState) => void;
  onRoom: (roomId: string) => void;
  onMessage: (message: ChatMessage) => void;
}

interface IrcMessage {
  tags: Record<string, string>;
  prefix: string;
  command: string;
  params: string[];
  trailing: string | null;
}

export type ChatSocket = Pick<WebSocket,
  "onopen" | "onmessage" | "onclose" | "onerror" | "send" | "close">;

export interface ChatDependencies {
  createSocket(url: string): ChatSocket;
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(timer: number): void;
  now(): number;
  random(): number;
  networkTarget: EventTarget | null;
  isOnline(): boolean;
}

const CONNECTION_TIMEOUT = 8_000;
const IDLE_PROBE_DELAY = 5_000;
const PONG_TIMEOUT = 5_000;
const MIN_ATTEMPT_INTERVAL = 1_000;
const RETRY_DELAYS = [250, 1_000, 2_000, 4_000, 8_000, 15_000];

export class TwitchChat {
  private readonly dependencies: ChatDependencies;
  private socket: ChatSocket | null = null;
  private reconnectTimer: number | null = null;
  private connectionTimer: number | null = null;
  private healthTimer: number | null = null;
  private generation = 0;
  private connectionEpoch = 0;
  private reconnectAttempt = 0;
  private channel = "";
  private state: ChatConnectionState = "offline";
  private lastAttemptAt = -Infinity;
  private joinedAt: number | null = null;
  private pendingPing: string | null = null;
  private pingSequence = 0;
  private networkOffline = false;
  private disposed = false;

  constructor(
    private readonly callbacks: ChatCallbacks,
    dependencies: Partial<ChatDependencies> = {},
  ) {
    this.dependencies = {
      createSocket: (url) => new WebSocket(url),
      setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
      clearTimeout: (timer) => globalThis.clearTimeout(timer),
      now: () => performance.now(),
      random: Math.random,
      networkTarget: typeof window === "undefined" ? null : window,
      isOnline: () => typeof navigator === "undefined" || navigator.onLine !== false,
      ...dependencies,
    };
  }

  connect(channel: string): void {
    if (this.disposed) return;
    this.disconnect();
    this.channel = channel;
    this.reconnectAttempt = 0;
    this.lastAttemptAt = -Infinity;
    this.networkOffline = !this.dependencies.isOnline();
    this.dependencies.networkTarget?.addEventListener("online", this.onOnline);
    this.dependencies.networkTarget?.addEventListener("offline", this.onOffline);
    this.open(this.generation);
  }

  /** Rejoin the same chat without resetting history, video, or synchronization. */
  reconnect(): void {
    if (!this.channel || this.disposed) return;
    const generation = this.generation;
    this.cancelReconnect();
    this.retireSocket();
    this.reconnectAttempt = Math.max(1, this.reconnectAttempt);
    // Network availability is a hint. An explicit retry can test the server
    // even if the system has not yet reported that access has returned.
    this.open(generation, true);
  }

  disconnect(): void {
    this.generation += 1;
    this.channel = "";
    this.dependencies.networkTarget?.removeEventListener("online", this.onOnline);
    this.dependencies.networkTarget?.removeEventListener("offline", this.onOffline);
    this.cancelReconnect();
    this.retireSocket();
    this.setState("offline");
  }

  dispose(): void {
    this.disposed = true;
    this.disconnect();
  }

  private readonly onOffline = (): void => {
    if (!this.channel || this.disposed) return;
    this.networkOffline = true;
    this.waitForNetwork();
  };

  private readonly onOnline = (): void => {
    if (!this.channel || this.disposed) return;
    this.networkOffline = false;
    if (this.state === "connected" && this.socket) {
      // A network hint alone need not interrupt a healthy session.
      this.sendProbe(this.socket, this.generation);
    } else this.reconnect();
  };

  private active(generation: number): boolean {
    return !this.disposed && Boolean(this.channel) && generation === this.generation;
  }

  private current(socket: ChatSocket, generation: number): boolean {
    return this.active(generation) && this.socket === socket;
  }

  private setState(state: ChatConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.callbacks.onState(state);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) {
      this.dependencies.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearHealthTimer(): void {
    if (this.healthTimer !== null) {
      this.dependencies.clearTimeout(this.healthTimer);
      this.healthTimer = null;
    }
  }

  private retireSocket(): void {
    this.connectionEpoch += 1;
    this.clearHealthTimer();
    if (this.connectionTimer !== null) {
      this.dependencies.clearTimeout(this.connectionTimer);
      this.connectionTimer = null;
    }
    this.pendingPing = null;
    this.joinedAt = null;
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    // Closing can itself stall when packets disappear. Recovery never awaits it.
    try { socket.close(); } catch { /* The retired socket cannot affect its replacement. */ }
  }

  private waitForNetwork(): void {
    this.cancelReconnect();
    this.retireSocket();
    this.setState("waiting");
  }

  private open(generation: number, force = false): void {
    if (!this.active(generation)) return;
    if (!force && (this.networkOffline || !this.dependencies.isOnline())) {
      this.waitForNetwork();
      return;
    }
    this.cancelReconnect();
    this.retireSocket();
    const epoch = this.connectionEpoch;
    this.setState(this.reconnectAttempt ? "reconnecting" : "connecting");
    if (!this.active(generation) || epoch !== this.connectionEpoch) return;
    const remaining = MIN_ATTEMPT_INTERVAL - (this.dependencies.now() - this.lastAttemptAt);
    if (remaining > 0) {
      this.scheduleOpen(generation, remaining, force);
      return;
    }

    this.lastAttemptAt = this.dependencies.now();
    let socket: ChatSocket;
    try {
      socket = this.dependencies.createSocket("wss://irc-ws.chat.twitch.tv:443");
    } catch {
      this.scheduleReconnect(generation);
      return;
    }
    if (!this.active(generation) || epoch !== this.connectionEpoch) {
      try { socket.close(); } catch { /* No active session owns this socket. */ }
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      if (!this.current(socket, generation)) return;
      const nick = `justinfan${Math.floor(100000 + this.dependencies.random() * 900000)}`;
      for (const command of [
        "CAP REQ :twitch.tv/tags twitch.tv/commands\r\n",
        "PASS SCHMOOPIIE\r\n",
        `NICK ${nick}\r\n`,
        `JOIN #${this.channel}\r\n`,
      ]) {
        if (!this.current(socket, generation)) return;
        try { socket.send(command); } catch {
          this.fail(socket, generation);
          return;
        }
      }
    };

    socket.onmessage = (event) => {
      if (!this.current(socket, generation) || typeof event.data !== "string") return;
      for (const line of event.data.split("\r\n")) {
        // User callbacks and server RECONNECT can retire the socket mid-frame.
        if (!this.current(socket, generation)) return;
        if (line) this.handleLine(line, socket, generation);
      }
      if (this.current(socket, generation)) this.armIdleProbe(socket, generation);
    };

    socket.onerror = () => this.fail(socket, generation);
    socket.onclose = () => this.fail(socket, generation);
    const timer = this.dependencies.setTimeout(() => {
      if (this.connectionTimer !== timer || !this.current(socket, generation)) return;
      this.connectionTimer = null;
      if (this.joinedAt === null) this.fail(socket, generation);
    }, CONNECTION_TIMEOUT);
    this.connectionTimer = timer;
  }

  private armIdleProbe(socket: ChatSocket, generation: number): void {
    if (this.joinedAt === null || this.pendingPing !== null) return;
    this.clearHealthTimer();
    const timer = this.dependencies.setTimeout(() => {
      if (this.healthTimer !== timer || !this.current(socket, generation)) return;
      this.healthTimer = null;
      this.sendProbe(socket, generation);
    }, IDLE_PROBE_DELAY);
    this.healthTimer = timer;
  }

  private sendProbe(socket: ChatSocket, generation: number): void {
    if (!this.current(socket, generation) || this.joinedAt === null || this.pendingPing !== null) return;
    this.clearHealthTimer();
    const token = `wonkitch-${generation}-${++this.pingSequence}`;
    this.pendingPing = token;
    const timer = this.dependencies.setTimeout(() => {
      if (this.healthTimer !== timer || !this.current(socket, generation) || this.pendingPing !== token) return;
      this.healthTimer = null;
      this.fail(socket, generation);
    }, PONG_TIMEOUT);
    this.healthTimer = timer;
    try { socket.send(`PING :${token}\r\n`); } catch { this.fail(socket, generation); }
  }

  private fail(socket: ChatSocket, generation: number, delay?: number): void {
    if (!this.current(socket, generation)) return;
    // Very short successful joins must not reset an ongoing failure backoff.
    if (this.joinedAt !== null && this.dependencies.now() - this.joinedAt >= 10_000) {
      this.reconnectAttempt = 0;
    }
    this.retireSocket();
    this.scheduleReconnect(generation, delay);
  }

  private handleLine(line: string, socket: ChatSocket, generation: number): void {
    if (line.startsWith("PING ")) {
      try { socket.send(`PONG ${line.slice(5)}\r\n`); } catch { this.fail(socket, generation); }
      return;
    }

    const message = parseIrcMessage(line);
    if (!message) return;

    if (message.command === "RECONNECT") {
      this.fail(socket, generation, 100);
      return;
    }

    if (message.command === "PONG") {
      if (this.pendingPing !== null && message.params.at(-1) === this.pendingPing) {
        this.pendingPing = null;
        this.clearHealthTimer();
        this.reconnectAttempt = 0;
      }
      return;
    }

    if (message.command === "ROOMSTATE") {
      if (message.params[0]?.toLowerCase() !== `#${this.channel.toLowerCase()}`) return;
      this.networkOffline = false;
      if (this.connectionTimer !== null) {
        this.dependencies.clearTimeout(this.connectionTimer);
        this.connectionTimer = null;
      }
      this.joinedAt ??= this.dependencies.now();
      const roomId = message.tags["room-id"];
      if (roomId) this.callbacks.onRoom(roomId);
      if (this.current(socket, generation)) this.setState("connected");
      return;
    }

    if (message.command === "PRIVMSG") {
      this.callbacks.onMessage(toChatMessage(message));
      return;
    }

    if (message.command === "USERNOTICE") {
      const notice = toUserNotice(message);
      if (notice) this.callbacks.onMessage(notice);
      return;
    }

    if (message.command === "CLEARMSG") {
      // Twitch includes the removed body's original text. Never display it again.
      const notice = toNotice("A message was deleted by a moderator.", message.tags);
      const messageId = message.tags["target-msg-id"];
      const login = message.tags.login;
      if (messageId) {
        notice.moderation = {
          messageId,
          ...(login ? { login } : {}),
        };
      }
      this.callbacks.onMessage(notice);
      return;
    }

    if (message.command === "CLEARCHAT") {
      // The first parameter is always the channel, including a full /clear.
      const user = message.params[1];
      const userId = message.tags["target-user-id"];
      const target = user || (userId ? "A user" : "");
      const duration = message.tags["ban-duration"];
      const text = target
        ? duration
          ? `${target} was timed out for ${duration}s.`
          : `${target} was removed from chat.`
        : "Chat was cleared by a moderator.";
      const notice = toNotice(text, message.tags);
      notice.moderation = user || userId
        ? { ...(user ? { login: user } : {}), ...(userId ? { userId } : {}) }
        : { clearAll: true };
      this.callbacks.onMessage(notice);
      return;
    }

    if (message.command === "NOTICE") {
      const text = message.params.at(-1);
      if (text) this.callbacks.onMessage(toNotice(text, message.tags));
    }
  }

  private scheduleReconnect(generation: number, overrideDelay?: number): void {
    if (!this.active(generation)) return;
    if (this.networkOffline || !this.dependencies.isOnline()) {
      this.waitForNetwork();
      return;
    }
    this.cancelReconnect();
    this.reconnectAttempt += 1;
    const epoch = this.connectionEpoch;
    this.setState("reconnecting");
    if (!this.active(generation) || epoch !== this.connectionEpoch) return;
    const base = RETRY_DELAYS[Math.min(this.reconnectAttempt - 1, RETRY_DELAYS.length - 1)];
    const delay = Math.max(
      MIN_ATTEMPT_INTERVAL - (this.dependencies.now() - this.lastAttemptAt),
      overrideDelay ?? Math.min(15_000, base + Math.floor(this.dependencies.random() * 250)),
    );
    this.scheduleOpen(generation, delay);
  }

  private scheduleOpen(generation: number, delay: number, force = false): void {
    this.cancelReconnect();
    const epoch = this.connectionEpoch;
    const timer = this.dependencies.setTimeout(() => {
      if (this.reconnectTimer !== timer || epoch !== this.connectionEpoch || !this.active(generation)) return;
      this.reconnectTimer = null;
      this.open(generation, force);
    }, delay);
    this.reconnectTimer = timer;
  }
}

function parseIrcMessage(line: string): IrcMessage | null {
  let rest = line;
  const tags: Record<string, string> = {};
  let prefix = "";

  if (rest.startsWith("@")) {
    const end = rest.indexOf(" ");
    if (end < 0) return null;
    for (const entry of rest.slice(1, end).split(";")) {
      const equals = entry.indexOf("=");
      const key = equals < 0 ? entry : entry.slice(0, equals);
      const value = equals < 0 ? "" : entry.slice(equals + 1);
      tags[key] = unescapeTag(value);
    }
    rest = rest.slice(end + 1);
  }

  if (rest.startsWith(":")) {
    const end = rest.indexOf(" ");
    if (end < 0) return null;
    prefix = rest.slice(1, end);
    rest = rest.slice(end + 1);
  }

  const commandEnd = rest.indexOf(" ");
  const command = commandEnd < 0 ? rest : rest.slice(0, commandEnd);
  rest = commandEnd < 0 ? "" : rest.slice(commandEnd + 1);

  const params: string[] = [];
  let trailing: string | null = null;
  while (rest) {
    if (rest.startsWith(":")) {
      trailing = rest.slice(1);
      params.push(trailing);
      break;
    }
    const end = rest.indexOf(" ");
    if (end < 0) {
      params.push(rest);
      break;
    }
    params.push(rest.slice(0, end));
    rest = rest.slice(end + 1).replace(/^ +/, "");
  }

  return { tags, prefix, command, params, trailing };
}

function unescapeTag(value: string): string {
  return value.replace(/\\([s:\\rn])/g, (_, escape: string) => {
    const replacements: Record<string, string> = {
      s: " ",
      ":": ";",
      "\\": "\\",
      r: "\r",
      n: "\n",
    };
    return replacements[escape] ?? escape;
  });
}

function toChatMessage(
  message: IrcMessage,
  login = message.prefix.split("!", 1)[0] || "unknown",
): ChatMessage {
  let text = message.params.at(-1) ?? "";
  let isAction = false;
  if (text.startsWith("\u0001ACTION ") && text.endsWith("\u0001")) {
    text = text.slice(8, -1);
    isAction = true;
  }

  return {
    id: message.tags.id || crypto.randomUUID(),
    userId: message.tags["user-id"] || "",
    login,
    displayName: message.tags["display-name"] || login,
    color: message.tags.color || "",
    text,
    badges: (message.tags.badges || "").split(",").filter(Boolean),
    emoteTag: message.tags.emotes || "",
    gifTag: message.tags.gifs || "",
    // Twitch sends this Power-up over IRC, including to anonymous readers.
    isGigantifiedEmote: message.tags["msg-id"] === "gigantified-emote-message",
    reply: toChatReply(message.tags),
    timestamp: messageTimestamp(message.tags),
    isAction,
    isNotice: false,
    isFirstMessage: message.tags["first-msg"] === "1",
  };
}

function toUserNotice(message: IrcMessage): ChatMessage | null {
  const noticeText = message.tags["system-msg"] || "";
  if (message.trailing?.trim()) {
    // Unlike PRIVMSG, USERNOTICE's prefix is Twitch's server, not the author.
    const userMessage = toChatMessage(message, message.tags.login || "unknown");
    if (noticeText) userMessage.noticeText = noticeText;
    if (message.tags["msg-id"]) userMessage.noticeType = message.tags["msg-id"];
    return userMessage;
  }

  // An absent trailing parameter is a header-only event, not a #channel body.
  return noticeText ? toNotice(noticeText, message.tags) : null;
}

function toChatReply(tags: Record<string, string>): ChatReply | null {
  const messageId = tags["reply-parent-msg-id"];
  if (!messageId) return null;

  const login = tags["reply-parent-user-login"] || "";
  return {
    messageId,
    userId: tags["reply-parent-user-id"] || "",
    login,
    // The direct parent can differ from the original thread's author.
    displayName: tags["reply-parent-display-name"] || login,
    ...(Object.hasOwn(tags, "reply-parent-msg-body")
      ? { body: tags["reply-parent-msg-body"] }
      : {}),
    ...(Object.hasOwn(tags, "reply-thread-parent-msg-id")
      ? { threadRootMessageId: tags["reply-thread-parent-msg-id"] }
      : {}),
    ...(Object.hasOwn(tags, "reply-thread-parent-user-id")
      ? { threadRootUserId: tags["reply-thread-parent-user-id"] }
      : {}),
    ...(Object.hasOwn(tags, "reply-thread-parent-user-login")
      ? { threadRootLogin: tags["reply-thread-parent-user-login"] }
      : {}),
    ...(Object.hasOwn(tags, "reply-thread-parent-display-name")
      ? { threadRootDisplayName: tags["reply-thread-parent-display-name"] }
      : {}),
  };
}

function messageTimestamp(tags: Record<string, string>): number {
  const timestamp = Number(tags["tmi-sent-ts"]);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now();
}

function toNotice(text: string, tags: Record<string, string>): ChatMessage {
  return {
    id: tags.id || crypto.randomUUID(),
    login: "",
    displayName: "",
    color: "",
    text,
    badges: [],
    emoteTag: "",
    isGigantifiedEmote: false,
    reply: null,
    timestamp: messageTimestamp(tags),
    isAction: false,
    isNotice: true,
    isFirstMessage: false,
  };
}
