export type ChatConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "offline";

export interface ChatMessage {
  id: string;
  login: string;
  displayName: string;
  color: string;
  text: string;
  badges: string[];
  emoteTag: string;
  timestamp: number;
  isAction: boolean;
  isNotice: boolean;
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
      this.reconnectAttempt = 0;
      this.callbacks.onState("connected");
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
      return;
    }

    if (message.command === "PRIVMSG") {
      this.callbacks.onMessage(toChatMessage(message));
      return;
    }

    if (message.command === "USERNOTICE") {
      const systemMessage = message.tags["system-msg"];
      if (systemMessage) this.callbacks.onMessage(toNotice(systemMessage));
      return;
    }

    if (message.command === "CLEARCHAT") {
      const user = message.params.at(-1);
      const duration = message.tags["ban-duration"];
      const text = user
        ? duration
          ? `${user} was timed out for ${duration}s.`
          : `${user} was removed from chat.`
        : "Chat was cleared by a moderator.";
      this.callbacks.onMessage(toNotice(text));
      return;
    }

    if (message.command === "NOTICE") {
      const text = message.params.at(-1);
      if (text) this.callbacks.onMessage(toNotice(text));
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
  while (rest) {
    if (rest.startsWith(":")) {
      params.push(rest.slice(1));
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

  return { tags, prefix, command, params };
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

function toChatMessage(message: IrcMessage): ChatMessage {
  let text = message.params.at(-1) ?? "";
  let isAction = false;
  if (text.startsWith("\u0001ACTION ") && text.endsWith("\u0001")) {
    text = text.slice(8, -1);
    isAction = true;
  }

  const login = message.prefix.split("!", 1)[0] || "unknown";
  return {
    id: message.tags.id || crypto.randomUUID(),
    login,
    displayName: message.tags["display-name"] || login,
    color: message.tags.color || "",
    text,
    badges: (message.tags.badges || "").split(",").filter(Boolean),
    emoteTag: message.tags.emotes || "",
    timestamp: Number(message.tags["tmi-sent-ts"]) || Date.now(),
    isAction,
    isNotice: false,
  };
}

function toNotice(text: string): ChatMessage {
  return {
    id: crypto.randomUUID(),
    login: "",
    displayName: "",
    color: "",
    text,
    badges: [],
    emoteTag: "",
    timestamp: Date.now(),
    isAction: false,
    isNotice: true,
  };
}
