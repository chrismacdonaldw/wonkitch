export type ChatConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
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

export class TwitchChat {
  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private generation = 0;
  private reconnectAttempt = 0;
  private channel = "";

  constructor(private readonly callbacks: ChatCallbacks) {}

  connect(channel: string): void {
    this.disconnect();
    this.channel = channel;
    this.reconnectAttempt = 0;
    this.open(this.generation);
  }

  disconnect(): void {
    this.generation += 1;
    this.channel = "";
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.close();
      this.socket = null;
    }
    this.callbacks.onState("offline");
  }

  private open(generation: number): void {
    if (!this.channel || generation !== this.generation) return;

    this.callbacks.onState(this.reconnectAttempt ? "reconnecting" : "connecting");
    const socket = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
    this.socket = socket;

    socket.onopen = () => {
      if (generation !== this.generation) {
        socket.close();
        return;
      }

      const nick = `justinfan${Math.floor(100000 + Math.random() * 900000)}`;
      socket.send("CAP REQ :twitch.tv/tags twitch.tv/commands\r\n");
      socket.send("PASS SCHMOOPIIE\r\n");
      socket.send(`NICK ${nick}\r\n`);
      socket.send(`JOIN #${this.channel}\r\n`);
    };

    socket.onmessage = (event) => {
      if (generation !== this.generation) return;
      for (const line of String(event.data).split("\r\n")) {
        if (line) this.handleLine(line, socket, generation);
      }
    };

    socket.onerror = () => socket.close();
    socket.onclose = () => {
      if (generation === this.generation) this.scheduleReconnect(generation);
    };
  }

  private handleLine(line: string, socket: WebSocket, generation: number): void {
    if (line.startsWith("PING ")) {
      socket.send(`PONG ${line.slice(5)}\r\n`);
      return;
    }

    const message = parseIrcMessage(line);
    if (!message) return;

    if (message.command === "RECONNECT") {
      socket.onclose = null;
      socket.close();
      this.reconnectAttempt = 0;
      this.scheduleReconnect(generation, 100);
      return;
    }

    if (message.command === "ROOMSTATE") {
      const roomId = message.tags["room-id"];
      if (roomId) this.callbacks.onRoom(roomId);
      this.reconnectAttempt = 0;
      this.callbacks.onState("connected");
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
    if (!this.channel || generation !== this.generation) return;
    this.reconnectAttempt += 1;
    this.callbacks.onState("reconnecting");
    const delay =
      overrideDelay ?? Math.min(15000, 750 * 2 ** Math.min(this.reconnectAttempt, 5));
    this.reconnectTimer = window.setTimeout(() => this.open(generation), delay);
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
