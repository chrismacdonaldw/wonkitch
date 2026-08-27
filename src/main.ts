import { invoke } from "@tauri-apps/api/core";
import mpegts from "mpegts.js";
import { TwitchChat, type ChatConnectionState, type ChatMessage } from "./chat";
import { appendRichText, EmoteCatalog } from "./emotes";

interface StreamInfo {
  url: string;
  channel: string;
  quality: string;
  qualities: string[];
  title: string;
  category: string;
}

const element = <T extends HTMLElement>(selector: string): T => {
  const match = document.querySelector<T>(selector);
  if (!match) throw new Error(`Missing UI element: ${selector}`);
  return match;
};

const channelForm = element<HTMLFormElement>("#channel-form");
const channelInput = element<HTMLInputElement>("#channel-input");
const qualitySelect = element<HTMLSelectElement>("#quality-select");
const tuneButton = element<HTMLButtonElement>(".tune-button");
const deck = element<HTMLElement>("#deck");
const stage = element<HTMLElement>("#stage");
const video = element<HTMLVideoElement>("#video");
const videoState = element<HTMLElement>("#video-state");
const videoStateKicker = element<HTMLElement>("#video-state-kicker");
const videoStateTitle = element<HTMLElement>("#video-state-title");
const videoStateDetail = element<HTMLElement>("#video-state-detail");
const livePill = element<HTMLElement>("#live-pill");
const nowChannel = element<HTMLElement>("#now-channel");
const nowTitle = element<HTMLElement>("#now-title");
const transportDot = element<HTMLElement>("#transport-dot");
const transportStatus = element<HTMLElement>("#transport-status");
const chatChannel = element<HTMLElement>("#chat-channel");
const chatStatus = element<HTMLElement>("#chat-status");
const chatDot = element<HTMLElement>("#chat-dot");
const chatLog = element<HTMLElement>("#chat-log");
const emoteCount = element<HTMLElement>("#emote-count");
const jumpLive = element<HTMLButtonElement>("#jump-live");
const playToggle = element<HTMLButtonElement>("#play-toggle");
const muteToggle = element<HTMLButtonElement>("#mute-toggle");
const volume = element<HTMLInputElement>("#volume");
const latencyReadout = element<HTMLElement>("#latency-readout");
const chatToggle = element<HTMLButtonElement>("#chat-toggle");
const fullscreenToggle = element<HTMLButtonElement>("#fullscreen-toggle");
const clock = element<HTMLElement>("#clock");

const catalog = new EmoteCatalog();
let player: ReturnType<typeof mpegts.createPlayer> | null = null;
let currentChannel = "";
let currentGeneration = 0;
let messageQueue: ChatMessage[] = [];
let messageFrame = 0;

const chat = new TwitchChat({
  onState: updateChatState,
  onRoom: (roomId) => {
    const generation = currentGeneration;
    emoteCount.textContent = "EMOTES LOADING";
    void catalog.load(roomId).then((count) => {
      if (generation === currentGeneration) emoteCount.textContent = `EMOTES ${count}`;
    });
  },
  onMessage: queueMessage,
});

channelForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void tuneChannel(channelInput.value);
});

qualitySelect.addEventListener("change", () => {
  if (currentChannel) void tuneVideo(currentChannel, qualitySelect.value, false);
});

chatToggle.addEventListener("click", () => {
  const hidden = deck.classList.toggle("chat-hidden");
  chatToggle.setAttribute("aria-pressed", String(!hidden));
  chatToggle.textContent = hidden ? "SHOW CHAT" : "CHAT";
});

playToggle.addEventListener("click", () => togglePlayback());
video.addEventListener("click", () => togglePlayback());
video.addEventListener("play", () => (playToggle.textContent = "PAUSE"));
video.addEventListener("pause", () => (playToggle.textContent = "PLAY"));
video.addEventListener("playing", () => setTransport("LIVE", true));
video.addEventListener("waiting", () => setTransport("BUFFERING", false));
video.addEventListener("timeupdate", updateLatency);

muteToggle.addEventListener("click", () => {
  video.muted = !video.muted;
  muteToggle.textContent = video.muted ? "UNMUTE" : "MUTE";
});

volume.addEventListener("input", () => {
  video.volume = Number(volume.value);
  video.muted = video.volume === 0;
  muteToggle.textContent = video.muted ? "UNMUTE" : "MUTE";
});

fullscreenToggle.addEventListener("click", () => {
  if (document.fullscreenElement) {
    void document.exitFullscreen();
  } else {
    void stage.requestFullscreen();
  }
});

chatLog.addEventListener("scroll", () => {
  jumpLive.classList.toggle("visible", !isChatNearBottom());
});
jumpLive.addEventListener("click", () => scrollChatToLive());

window.addEventListener("beforeunload", () => {
  chat.disconnect();
  destroyPlayer();
});

async function tuneChannel(rawChannel: string): Promise<void> {
  const channel = normalizeChannel(rawChannel);
  if (!channel) {
    channelInput.focus();
    channelInput.select();
    return;
  }

  currentGeneration += 1;
  currentChannel = channel;
  localStorage.setItem("moondeck.channel", channel);
  channelInput.value = channel;
  chatChannel.textContent = `#${channel}`;
  nowChannel.textContent = channel.toUpperCase();
  chatLog.replaceChildren();
  messageQueue = [];
  emoteCount.textContent = "EMOTES ---";
  appendSystemMessage(`Tuning chat relay to #${channel}…`);
  chat.connect(channel);
  await tuneVideo(channel, qualitySelect.value, true);
}

async function tuneVideo(channel: string, quality: string, hardSwitch: boolean): Promise<void> {
  const generation = currentGeneration;
  setLoadingState(channel, quality);
  tuneButton.disabled = true;
  qualitySelect.disabled = true;
  if (hardSwitch) video.pause();

  try {
    const info = await invoke<StreamInfo>("start_stream", { channel, quality });
    if (generation !== currentGeneration) return;
    attachStream(info);
  } catch (error) {
    if (generation !== currentGeneration) return;
    if (hardSwitch) {
      destroyPlayer();
      await invoke("stop_stream").catch(() => undefined);
    }
    setErrorState(channel, readableError(error));
  } finally {
    if (generation === currentGeneration) {
      tuneButton.disabled = false;
      qualitySelect.disabled = false;
    }
  }
}

function attachStream(info: StreamInfo): void {
  destroyPlayer();
  updateQualityOptions(info.qualities, info.quality);
  nowChannel.textContent = info.channel.toUpperCase();
  nowTitle.textContent = [info.category, info.title].filter(Boolean).join(" · ");

  if (!mpegts.isSupported()) {
    setErrorState(info.channel, "This WebView does not support Media Source playback.");
    return;
  }

  player = mpegts.createPlayer(
    {
      type: "mpegts",
      isLive: true,
      url: info.url,
    },
    {
      enableWorker: false,
      enableStashBuffer: false,
      stashInitialSize: 128,
      lazyLoad: false,
      autoCleanupSourceBuffer: true,
      autoCleanupMaxBackwardDuration: 20,
      autoCleanupMinBackwardDuration: 8,
      liveBufferLatencyChasing: true,
      liveBufferLatencyMaxLatency: 4,
      liveBufferLatencyMinRemain: 0.8,
    },
  );

  player.on(mpegts.Events.ERROR, (_type, detail) => {
    setTransport(`RELAY ERROR · ${String(detail).toUpperCase()}`, false);
  });
  player.attachMediaElement(video);
  player.load();
  videoState.classList.add("hidden");
  livePill.textContent = "LIVE";
  livePill.classList.add("active");
  setTransport(`CONNECTING · ${info.quality.toUpperCase()}`, false);
  void video.play().catch(() => {
    playToggle.textContent = "PLAY";
  });
}

function destroyPlayer(): void {
  if (player) {
    try {
      player.pause();
      player.unload();
      player.detachMediaElement();
      player.destroy();
    } catch {
      // The transport may already be gone during an app or channel shutdown.
    }
    player = null;
  }
  video.removeAttribute("src");
  video.load();
}

function setLoadingState(channel: string, quality: string): void {
  videoState.className = "video-state loading";
  videoStateKicker.textContent = "ACQUIRING DIRECT SIGNAL";
  videoStateTitle.textContent = `Tuning #${channel}…`;
  videoStateDetail.textContent = `Requesting ${quality.toUpperCase()} through the local Streamlink relay.`;
  livePill.textContent = "TUNING";
  livePill.classList.remove("active");
  setTransport("NEGOTIATING", false);
}

function setErrorState(channel: string, detail: string): void {
  videoState.className = "video-state error";
  videoStateKicker.textContent = "NO SIGNAL";
  videoStateTitle.textContent = `Could not open #${channel}.`;
  videoStateDetail.textContent = detail;
  livePill.textContent = "OFFLINE";
  livePill.classList.remove("active");
  setTransport("NO SIGNAL", false);
}

function setTransport(status: string, active: boolean): void {
  transportStatus.textContent = status;
  transportDot.classList.toggle("active", active);
}

function updateQualityOptions(qualities: string[], selected: string): void {
  qualitySelect.replaceChildren();
  for (const quality of qualities) {
    const option = document.createElement("option");
    option.value = quality;
    option.textContent = quality === "audio_only" ? "AUDIO" : quality.toUpperCase();
    option.selected = quality === selected;
    qualitySelect.append(option);
  }
}

function updateChatState(state: ChatConnectionState): void {
  const labels: Record<ChatConnectionState, string> = {
    connecting: "CONNECTING",
    connected: "CONNECTED",
    reconnecting: "RECONNECTING",
    offline: "OFFLINE",
  };
  chatStatus.textContent = labels[state];
  chatDot.classList.toggle("active", state === "connected");
}

function queueMessage(message: ChatMessage): void {
  messageQueue.push(message);
  if (!messageFrame) messageFrame = requestAnimationFrame(flushMessages);
}

function flushMessages(): void {
  messageFrame = 0;
  if (!messageQueue.length) return;
  const shouldScroll = isChatNearBottom();
  const fragment = document.createDocumentFragment();
  for (const message of messageQueue.splice(0)) fragment.append(renderMessage(message));
  chatLog.append(fragment);

  while (chatLog.childElementCount > 250) chatLog.firstElementChild?.remove();
  if (shouldScroll) scrollChatToLive();
  jumpLive.classList.toggle("visible", !isChatNearBottom());
}

function renderMessage(message: ChatMessage): HTMLElement {
  const row = document.createElement("article");
  row.className = message.isNotice ? "chat-message chat-message--notice" : "chat-message";
  row.dataset.messageId = message.id;

  if (message.isNotice) {
    row.textContent = message.text;
    return row;
  }

  const header = document.createElement("span");
  header.className = "message-header";
  for (const badge of message.badges) header.append(renderBadge(badge));

  const username = document.createElement("span");
  username.className = "username";
  username.textContent = message.displayName;
  username.style.color = validColor(message.color) || fallbackColor(message.login);
  header.append(username, document.createTextNode(message.isAction ? " " : ": "));

  const body = document.createElement("span");
  body.className = message.isAction ? "message-body message-body--action" : "message-body";
  const richText = document.createDocumentFragment();
  appendRichText(richText, message.text, message.emoteTag, catalog);
  body.append(richText);
  row.append(header, body);
  return row;
}

function renderBadge(badge: string): HTMLElement {
  const kind = badge.split("/", 1)[0];
  const symbols: Record<string, string> = {
    broadcaster: "★",
    moderator: "◆",
    vip: "◆",
    subscriber: "●",
    founder: "●",
    staff: "S",
    admin: "A",
    bits: "♦",
  };
  const item = document.createElement("span");
  item.className = `chat-badge chat-badge--${kind}`;
  item.textContent = symbols[kind] ?? "·";
  item.title = kind;
  return item;
}

function appendSystemMessage(text: string): void {
  const row = document.createElement("article");
  row.className = "chat-message chat-message--notice";
  row.textContent = text;
  chatLog.append(row);
}

function isChatNearBottom(): boolean {
  return chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 90;
}

function scrollChatToLive(): void {
  chatLog.scrollTop = chatLog.scrollHeight;
  jumpLive.classList.remove("visible");
}

function togglePlayback(): void {
  if (!player) return;
  if (video.paused) void video.play();
  else video.pause();
}

function updateLatency(): void {
  if (!video.buffered.length) {
    latencyReadout.textContent = "BUFFER --";
    return;
  }
  const edge = video.buffered.end(video.buffered.length - 1);
  const latency = Math.max(0, edge - video.currentTime);
  latencyReadout.textContent = `BUFFER ${latency.toFixed(1)}S`;
}

function normalizeChannel(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^(https?:\/\/)?(www\.)?twitch\.tv\//, "")
    .replace(/^[#@]/, "")
    .split(/[/?]/, 1)[0]
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 25);
}

function validColor(color: string): string {
  return /^#[0-9a-f]{6}$/i.test(color) ? color : "";
}

function fallbackColor(login: string): string {
  let hash = 0;
  for (const character of login) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(hash) % 360} 68% 66%)`;
}

function readableError(error: unknown): string {
  const text = String(error).replace(/^Error:\s*/i, "");
  return text || "The stream is offline or Twitch did not return a playable feed.";
}

function updateClock(): void {
  clock.textContent = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}

updateClock();
window.setInterval(updateClock, 1000);

const initialChannel = normalizeChannel(localStorage.getItem("moondeck.channel") || "moonmoon");
channelInput.value = initialChannel;
void tuneChannel(initialChannel);
