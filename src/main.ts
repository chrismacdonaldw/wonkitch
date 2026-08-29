import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import {
  getCurrentWindow,
  UserAttentionType,
} from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import mpegts from "mpegts.js";
import { BadgeCatalog, humanizeBadgeName } from "./badges";
import { TwitchChat, type ChatConnectionState, type ChatMessage } from "./chat";
import { appendRichText, EmoteCatalog, type ThirdPartyEmote } from "./emotes";
import {
  type AppPreferences,
  DEFAULT_PREFERENCES,
  PreferencesPanel,
} from "./preferences";

interface StreamInfo {
  url: string;
  channel: string;
  quality: string;
  qualities: string[];
  title: string;
  category: string;
}

interface TwitchAuthStatus {
  configured: boolean;
  loggedIn: boolean;
  clientId?: string;
  username?: string;
}

interface DeviceLogin {
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

type DevicePoll =
  | { state: "pending"; retryAfter: number }
  | { state: "complete"; account: TwitchAuthStatus };

interface MessageDisposition {
  blocked: boolean;
  highlighted: boolean;
  reason: string;
}

interface CompiledChatRules {
  highlightTerms: RegExp[];
  highlightUsers: RegExp[];
  blockedTerms: RegExp[];
  blockedUsers: RegExp[];
}

type WindowResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

const element = <T extends HTMLElement>(selector: string): T => {
  const match = document.querySelector<T>(selector);
  if (!match) throw new Error(`Missing UI element: ${selector}`);
  return match;
};

const channelForm = element<HTMLFormElement>("#channel-form");
const app = element<HTMLElement>("#app");
const topbar = element<HTMLElement>(".topbar");
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
const layoutToggle = element<HTMLButtonElement>("#layout-toggle");
const theaterToggle = element<HTMLButtonElement>("#theater-toggle");
const theaterPlayerToggle = element<HTMLButtonElement>("#theater-player-toggle");
const chatPlayerToggle = element<HTMLButtonElement>("#chat-player-toggle");
const fullscreenToggle = element<HTMLButtonElement>("#fullscreen-toggle");
const clock = element<HTMLElement>("#clock");
const badgeTooltip = element<HTMLElement>("#badge-tooltip");
const settingsToggle = element<HTMLButtonElement>("#settings-toggle");
const updateAvailable = element<HTMLButtonElement>("#update-available");
const windowMinimize = element<HTMLButtonElement>("#window-minimize");
const windowMaximize = element<HTMLButtonElement>("#window-maximize");
const windowClose = element<HTMLButtonElement>("#window-close");
const accountButton = element<HTMLButtonElement>("#account-button");
const chatReadonly = element<HTMLElement>("#chat-readonly");
const chatLoginButton = element<HTMLButtonElement>("#chat-login-button");
const authSummary = element<HTMLElement>("#auth-summary");
const chatForm = element<HTMLFormElement>("#chat-form");
const chatInput = element<HTMLInputElement>("#chat-input");
const chatSend = element<HTMLButtonElement>("#chat-send");
const chatResizer = element<HTMLElement>("#chat-resizer");
const emoteSuggestions = element<HTMLElement>("#emote-suggestions");
const authDialog = element<HTMLDialogElement>("#auth-dialog");
const authClose = element<HTMLButtonElement>("#auth-close");
const authClientStep = element<HTMLElement>("#auth-client-step");
const authDeviceStep = element<HTMLElement>("#auth-device-step");
const clientIdInput = element<HTMLInputElement>("#client-id-input");
const clientIdSave = element<HTMLButtonElement>("#client-id-save");
const twitchConsoleButton = element<HTMLButtonElement>("#twitch-console-button");
const authChangeClient = element<HTMLButtonElement>("#auth-change-client");
const deviceCode = element<HTMLOutputElement>("#device-code");
const openTwitchButton = element<HTMLButtonElement>("#open-twitch-button");
const authProgress = element<HTMLElement>("#auth-progress");
const authError = element<HTMLElement>("#auth-error");
const updateCurrentVersion = element<HTMLOutputElement>("#update-current-version");
const updateStatus = element<HTMLElement>("#update-status");
const updateCheck = element<HTMLButtonElement>("#update-check");
const updateReady = element<HTMLElement>("#update-ready");
const updateVersion = element<HTMLElement>("#update-version");
const updateNotes = element<HTMLElement>("#update-notes");
const updateInstall = element<HTMLButtonElement>("#update-install");
const updateProgress = element<HTMLProgressElement>("#update-progress");

const catalog = new EmoteCatalog();
const badgeCatalog = new BadgeCatalog();
const appWindow = getCurrentWindow();
const portraitOrientation = window.matchMedia("(orientation: portrait)");
let player: ReturnType<typeof mpegts.createPlayer> | null = null;
let currentChannel = "";
let currentGeneration = 0;
let messageQueue: ChatMessage[] = [];
let messageFrame = 0;
let theaterMode = false;
let activeBadge: HTMLElement | null = null;
let currentRoomId = "";
let loginGeneration = 0;
let verificationUrl = "";
let twitchAuth: TwitchAuthStatus = { configured: false, loggedIn: false };
let preferences = structuredClone(DEFAULT_PREFERENCES);
let assetLoadGeneration = 0;
let unreadHighlights = 0;
const visibleMessages = new Map<string, ChatMessage>();
let compiledRules = compileChatRules(preferences);
let notificationAudioContext: AudioContext | null = null;
let customSoundBlob: Blob | null = null;
let customSoundUrl = "";
const activeCustomSounds = new Set<HTMLAudioElement>();
let suggestedEmotes: ThirdPartyEmote[] = [];
let selectedEmoteSuggestion = 0;
let emoteSuggestionRange: { start: number; end: number } | null = null;
let resizePointerId: number | null = null;
let previewedChatWidth = preferences.chatWidth;
let pendingUpdate: Update | null = null;
let updateCheckActive = false;
let updateInstallActive = false;

const preferencesPanel = new PreferencesPanel({
  onChange: applyPreferences,
  onTestNotification: testHighlightNotification,
  onCustomSound: storeCustomNotificationSound,
  onRemoveCustomSound: removeCustomNotificationSound,
});

const chat = new TwitchChat({
  onState: updateChatState,
  onRoom: (roomId) => {
    currentRoomId = roomId;
    void loadRoomAssets(roomId);
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
  setChatVisible(deck.classList.contains("chat-hidden"));
});
chatPlayerToggle.addEventListener("click", () => {
  setChatVisible(deck.classList.contains("chat-hidden"));
});

layoutToggle.addEventListener("click", () => {
  setVerticalLayout(!deck.classList.contains("vertical-layout"));
});

portraitOrientation.addEventListener("change", (event) => {
  setVerticalLayout(event.matches);
});

theaterToggle.addEventListener("click", () => void setTheaterMode(!theaterMode));
theaterPlayerToggle.addEventListener("click", () => void setTheaterMode(!theaterMode));
settingsToggle.addEventListener("click", () => preferencesPanel.open());
updateAvailable.addEventListener("click", () => preferencesPanel.open("updates"));
updateCheck.addEventListener("click", () => void checkForUpdate(true));
updateInstall.addEventListener("click", () => void installPendingUpdate());
windowMinimize.addEventListener("click", () => void appWindow.minimize());
windowMaximize.addEventListener("click", () => void toggleWindowMaximized());
windowClose.addEventListener("click", () => void appWindow.close());
topbar.addEventListener("mousedown", handleTitlebarMouseDown);
for (const handle of document.querySelectorAll<HTMLElement>("[data-resize-direction]")) {
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const direction = handle.dataset.resizeDirection as WindowResizeDirection | undefined;
    if (direction) void appWindow.startResizeDragging(direction);
  });
}
void appWindow.onResized(() => void syncWindowMaximizedState());

playToggle.addEventListener("click", () => togglePlayback());
video.addEventListener("click", () => togglePlayback());
video.addEventListener("play", () => playToggle.classList.add("is-playing"));
video.addEventListener("pause", () => playToggle.classList.remove("is-playing"));
video.addEventListener("playing", () => setTransport("live", true));
video.addEventListener("waiting", () => setTransport("buffering", false));
video.addEventListener("timeupdate", updateLatency);

muteToggle.addEventListener("click", () => {
  video.muted = !video.muted;
  muteToggle.classList.toggle("is-muted", video.muted);
});

volume.addEventListener("input", () => {
  video.volume = Number(volume.value);
  video.muted = video.volume === 0;
  muteToggle.classList.toggle("is-muted", video.muted);
});

fullscreenToggle.addEventListener("click", () => {
  if (document.fullscreenElement) {
    void document.exitFullscreen();
  } else {
    void stage.requestFullscreen();
  }
});

window.addEventListener("keydown", (event) => {
  if (event.key === "F11") {
    event.preventDefault();
    void setTheaterMode(!theaterMode);
  } else if (event.key === "Escape" && theaterMode && !document.fullscreenElement) {
    event.preventDefault();
    void setTheaterMode(false);
  }
});

chatLog.addEventListener("scroll", () => {
  jumpLive.classList.toggle("visible", !isChatNearBottom());
  if (activeBadge?.isConnected) positionBadgeTooltip(activeBadge);
  else hideBadgeTooltip();
});
jumpLive.addEventListener("click", () => scrollChatToLive());
chatLog.addEventListener("pointerover", (event) => {
  const badge = findBadgeElement(event.target);
  if (badge) showBadgeTooltip(badge);
});
chatLog.addEventListener("pointerout", (event) => {
  const badge = findBadgeElement(event.target);
  const related = event.relatedTarget;
  if (badge && !(related instanceof Node && badge.contains(related))) hideBadgeTooltip();
});

accountButton.addEventListener("click", () => {
  if (twitchAuth.loggedIn) void logoutFromTwitch();
  else void openLoginDialog();
});
chatLoginButton.addEventListener("click", () => void openLoginDialog());
chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void sendChatMessage();
});
chatInput.addEventListener("input", updateEmoteSuggestions);
chatInput.addEventListener("keydown", handleEmoteSuggestionKeydown);
chatInput.addEventListener("blur", () => window.setTimeout(hideEmoteSuggestions, 100));

chatResizer.addEventListener("pointerdown", beginChatResize);
chatResizer.addEventListener("pointermove", continueChatResize);
chatResizer.addEventListener("pointerup", finishChatResize);
chatResizer.addEventListener("pointercancel", finishChatResize);
chatResizer.addEventListener("dblclick", () => preferencesPanel.setChatWidth(380));
chatResizer.addEventListener("keydown", handleChatResizeKeydown);

authClose.addEventListener("click", closeLoginDialog);
authDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeLoginDialog();
});
clientIdSave.addEventListener("click", () => void saveClientId());
twitchConsoleButton.addEventListener("click", () => {
  void openUrl("https://dev.twitch.tv/console").catch((error) => showAuthError(error));
});
authChangeClient.addEventListener("click", () => {
  loginGeneration += 1;
  void invoke("cancel_twitch_login").catch(() => undefined);
  showClientSetup();
});
openTwitchButton.addEventListener("click", () => {
  if (verificationUrl) void openUrl(verificationUrl).catch((error) => showAuthError(error));
});

window.addEventListener("beforeunload", () => {
  loginGeneration += 1;
  chat.disconnect();
  destroyPlayer();
});
window.addEventListener("focus", clearUnreadHighlights);

async function tuneChannel(rawChannel: string): Promise<void> {
  const channel = normalizeChannel(rawChannel);
  if (!channel) {
    channelInput.focus();
    channelInput.select();
    return;
  }

  currentGeneration += 1;
  currentChannel = channel;
  currentRoomId = "";
  hideEmoteSuggestions();
  localStorage.setItem("wonkitch.channel", channel);
  channelInput.value = channel;
  chatChannel.textContent = `#${channel}`;
  chatInput.placeholder = `Message #${channel}`;
  nowChannel.textContent = channel;
  chatLog.replaceChildren();
  visibleMessages.clear();
  messageQueue = [];
  emoteCount.textContent = "--- emotes";
  appendSystemMessage(`Connecting to #${channel}...`);
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
  nowChannel.textContent = info.channel;
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
    setTransport(`playback error: ${String(detail).toLowerCase()}`, false);
  });
  player.attachMediaElement(video);
  player.load();
  videoState.classList.add("hidden");
  livePill.textContent = "LIVE";
  livePill.classList.add("active");
  setTransport(`connecting / ${info.quality.toLowerCase()}`, false);
  void video.play().catch(() => {
    playToggle.classList.remove("is-playing");
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
  videoStateKicker.textContent = "CONNECTING";
  videoStateTitle.textContent = `Opening #${channel}...`;
  videoStateDetail.textContent = `Requesting ${quality.toUpperCase()}.`;
  livePill.textContent = "TUNING";
  livePill.classList.remove("active");
  setTransport("connecting", false);
}

function setErrorState(channel: string, detail: string): void {
  videoState.className = "video-state error";
  videoStateKicker.textContent = "NO SIGNAL";
  videoStateTitle.textContent = `Could not open #${channel}.`;
  videoStateDetail.textContent = detail;
  livePill.textContent = "OFFLINE";
  livePill.classList.remove("active");
  setTransport("no signal", false);
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
  if (state !== "connected") currentRoomId = "";
  const labels: Record<ChatConnectionState, string> = {
    connecting: "connecting",
    connected: "connected",
    reconnecting: "reconnecting",
    offline: "offline",
  };
  chatStatus.textContent = labels[state];
  chatDot.classList.toggle("active", state === "connected");
}

async function loadRoomAssets(roomId: string): Promise<void> {
  const channelGeneration = currentGeneration;
  const loadGeneration = ++assetLoadGeneration;
  emoteCount.textContent = "loading emotes";
  const providers = {
    ffz: preferences.ffzEmotes,
    bttv: preferences.bttvEmotes,
    sevenTv: preferences.sevenTvEmotes,
  };
  const [count] = await Promise.all([
    catalog.load(roomId, providers),
    preferences.showBadges ? badgeCatalog.load(roomId) : Promise.resolve(),
  ]);
  if (
    channelGeneration !== currentGeneration ||
    loadGeneration !== assetLoadGeneration ||
    roomId !== currentRoomId
  ) {
    return;
  }
  emoteCount.textContent = `${count} emotes`;
  rerenderVisibleMessages();
  updateEmoteSuggestions();
}

function applyPreferences(next: AppPreferences): void {
  const enableDesktopNotifications =
    !preferences.desktopNotifications && next.desktopNotifications;
  const reloadAssets =
    preferences.ffzEmotes !== next.ffzEmotes ||
    preferences.bttvEmotes !== next.bttvEmotes ||
    preferences.sevenTvEmotes !== next.sevenTvEmotes ||
    preferences.showBadges !== next.showBadges;
  preferences = structuredClone(next);
  compiledRules = compileChatRules(preferences);

  const root = document.documentElement;
  root.style.setProperty("--accent", preferences.accentColor);
  root.style.setProperty("--accent-bright", preferences.accentColor);
  root.style.setProperty("--accent-soft", `${preferences.accentColor}24`);
  root.style.setProperty("--chat-background", preferences.chatBackground);
  root.style.setProperty("--chat-text-color", preferences.chatTextColor);
  root.style.setProperty("--chat-font-family", `"${preferences.chatFontFamily}", sans-serif`);
  root.style.setProperty("--chat-font-size", `${preferences.chatFontSize}px`);
  root.style.setProperty("--emote-size", `${preferences.emoteSize}px`);
  root.style.setProperty("--highlight-color", preferences.highlightColor);
  root.style.setProperty("--chat-width", `min(${preferences.chatWidth}px, 60vw)`);
  previewedChatWidth = preferences.chatWidth;
  chatResizer.setAttribute("aria-valuenow", String(preferences.chatWidth));

  const density = {
    compact: { padding: "2px", lineHeight: "1.3" },
    comfortable: { padding: "4px", lineHeight: "1.45" },
    spacious: { padding: "7px", lineHeight: "1.55" },
  }[preferences.lineDensity];
  root.style.setProperty("--chat-message-padding", density.padding);
  root.style.setProperty("--chat-line-height", density.lineHeight);
  document.body.classList.toggle("chat-alternating", preferences.alternatingRows);
  document.body.classList.toggle("reduced-motion", preferences.reducedMotion);
  if (!preferences.unreadCount) clearUnreadHighlights();

  rerenderVisibleMessages();
  trimChatHistory();
  if (reloadAssets && currentRoomId) void loadRoomAssets(currentRoomId);
  if (enableDesktopNotifications) {
    void ensureDesktopNotificationPermission().catch(() => undefined);
  }
}

function compileChatRules(settings: AppPreferences): CompiledChatRules {
  return {
    highlightTerms: compilePatterns(settings.highlightTerms, false),
    highlightUsers: compilePatterns(settings.highlightUsers, true),
    blockedTerms: compilePatterns(settings.blockedTerms, false),
    blockedUsers: compilePatterns(settings.blockedUsers, true),
  };
}

function compilePatterns(patterns: string[], exact: boolean): RegExp[] {
  const compiled: RegExp[] = [];
  for (const pattern of patterns) {
    const expression = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    try {
      compiled.push(new RegExp(exact ? `^${expression}$` : expression, "i"));
    } catch {
      // Invalid patterns are ignored rather than interrupting chat rendering.
    }
  }
  return compiled;
}

function classifyMessage(message: ChatMessage): MessageDisposition {
  if (message.isNotice) return { blocked: false, highlighted: false, reason: "" };
  if (matchesRules(message.login, compiledRules.blockedUsers)) {
    return { blocked: true, highlighted: false, reason: "a blocked user rule" };
  }
  if (matchesRules(message.text, compiledRules.blockedTerms)) {
    return { blocked: true, highlighted: false, reason: "a blocked term rule" };
  }
  if (matchesRules(message.login, compiledRules.highlightUsers)) {
    return { blocked: false, highlighted: true, reason: "user" };
  }
  if (matchesRules(message.text, compiledRules.highlightTerms)) {
    return { blocked: false, highlighted: true, reason: "term" };
  }
  if (preferences.highlightMentions && mentionsCurrentUser(message.text)) {
    return { blocked: false, highlighted: true, reason: "mention" };
  }
  return { blocked: false, highlighted: false, reason: "" };
}

function matchesRules(value: string, rules: RegExp[]): boolean {
  return rules.some((rule) => rule.test(value));
}

function mentionsCurrentUser(text: string): boolean {
  const username = twitchAuth.username;
  if (!username) return false;
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9_])@${escaped}(?=$|[^a-z0-9_])`, "i").test(text);
}

function rerenderVisibleMessages(): void {
  const shouldScroll = isChatNearBottom();
  hideBadgeTooltip();
  for (const row of chatLog.querySelectorAll<HTMLElement>("[data-message-id]")) {
    const message = row.dataset.messageId ? visibleMessages.get(row.dataset.messageId) : undefined;
    if (message) row.replaceWith(renderMessage(message));
  }
  if (shouldScroll) scrollChatToLive();
}

function trimChatHistory(): void {
  while (chatLog.childElementCount > preferences.maxMessages) {
    const first = chatLog.firstElementChild;
    if (first instanceof HTMLElement && first.dataset.messageId) {
      visibleMessages.delete(first.dataset.messageId);
    }
    first?.remove();
  }
}

function formatTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: preferences.timestampSeconds ? "2-digit" : undefined,
    hour12: preferences.timestampFormat === "12",
  }).format(new Date(timestamp));
}

function usernameColor(color: string, login: string): string {
  const twitchColor = validColor(color);
  if (!twitchColor || !preferences.adjustUsernameColors) {
    return twitchColor || fallbackColor(login);
  }
  const foreground = parseHexColor(twitchColor);
  const background = parseHexColor(preferences.chatBackground);
  if (!foreground || !background) return twitchColor;
  let adjusted = foreground;
  while (contrastRatio(adjusted, background) < 4.5 && adjusted.some((channel) => channel < 255)) {
    adjusted = adjusted.map((channel) => Math.min(255, Math.round(channel + (255 - channel) * 0.12)));
  }
  return `#${adjusted.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function parseHexColor(color: string): number[] | null {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return null;
  return [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16));
}

function contrastRatio(first: number[], second: number[]): number {
  const luminance = (color: number[]) => {
    const channels = color.map((channel) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const lighter = Math.max(luminance(first), luminance(second));
  const darker = Math.min(luminance(first), luminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

async function handleHighlightAlert(message: ChatMessage, reason: string): Promise<void> {
  if (document.hasFocus()) return;
  unreadHighlights += 1;
  if (preferences.unreadCount) document.title = `(${unreadHighlights}) wonkitch`;
  if (preferences.taskbarAlert) {
    void appWindow.requestUserAttention(UserAttentionType.Informational).catch(() => undefined);
  }
  if (preferences.notificationSound) void playNotificationSound();
  if (preferences.desktopNotifications && (await isPermissionGranted())) {
    sendNotification({
      title: `${message.displayName} · #${currentChannel} · ${reason}`,
      body: message.text.replace(/[\r\n]+/g, " ").slice(0, 180),
    });
  }
}

async function testHighlightNotification(): Promise<string> {
  const enabled =
    preferences.desktopNotifications ||
    preferences.notificationSound ||
    preferences.taskbarAlert ||
    preferences.unreadCount;
  if (!enabled) return "Enable at least one alert option first.";

  let desktopSent = false;
  if (preferences.desktopNotifications) {
    const granted = await ensureDesktopNotificationPermission();
    if (granted) {
      sendNotification({ title: "wonkitch test", body: "Highlight notifications are working." });
      desktopSent = true;
    }
  }
  if (preferences.notificationSound) await playNotificationSound();
  if (preferences.taskbarAlert) {
    await appWindow.requestUserAttention(UserAttentionType.Informational);
  }
  if (preferences.unreadCount) {
    unreadHighlights = Math.max(1, unreadHighlights);
    document.title = `(${unreadHighlights}) wonkitch`;
  }
  return preferences.desktopNotifications && !desktopSent
    ? "Desktop permission was not granted; other enabled alerts were tested."
    : "Enabled alert methods were tested.";
}

async function ensureDesktopNotificationPermission(): Promise<boolean> {
  if (await isPermissionGranted()) return true;
  return (await requestPermission()) === "granted";
}

async function playNotificationSound(): Promise<void> {
  if (preferences.notificationVolume <= 0) return;
  if (preferences.notificationSoundMode === "custom" && (await playCustomSound())) return;

  notificationAudioContext ??= new AudioContext();
  const context = notificationAudioContext;
  if (context.state === "suspended") await context.resume();
  const start = context.currentTime + 0.01;
  const master = context.createGain();
  master.gain.setValueAtTime(preferences.notificationVolume / 100, start);
  master.connect(context.destination);

  if (preferences.notificationSoundMode === "pulse") {
    scheduleTone(context, master, 520, start, 0.24, "sine", 0.28);
    scheduleTone(context, master, 780, start + 0.17, 0.32, "sine", 0.24);
    window.setTimeout(() => master.disconnect(), 800);
    return;
  }

  scheduleTone(context, master, 659.25, start, 0.44, "sine", 0.24);
  scheduleTone(context, master, 830.61, start + 0.07, 0.48, "triangle", 0.2);
  scheduleTone(context, master, 987.77, start + 0.14, 0.56, "sine", 0.18);
  window.setTimeout(() => master.disconnect(), 900);
}

function scheduleTone(
  context: AudioContext,
  output: AudioNode,
  frequency: number,
  start: number,
  duration: number,
  type: OscillatorType,
  peak: number,
): void {
  const oscillator = context.createOscillator();
  const envelope = context.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  envelope.gain.setValueAtTime(0.0001, start);
  envelope.gain.exponentialRampToValueAtTime(peak, start + 0.025);
  envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(envelope);
  envelope.connect(output);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

async function storeCustomNotificationSound(file: File): Promise<string> {
  const extensionAllowed = /\.(mp3|wav|ogg|webm|m4a)$/i.test(file.name);
  if (!file.type.startsWith("audio/") && !extensionAllowed) {
    throw new Error("Choose an MP3, WAV, OGG, WebM, or M4A audio file.");
  }
  if (!file.size || file.size > 10 * 1024 * 1024) {
    throw new Error("Custom sounds must be smaller than 10 MB.");
  }
  await validateAudioFile(file);
  const database = await openNotificationDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction("sounds", "readwrite");
    transaction.objectStore("sounds").put(file, "notification");
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not save custom sound."));
  });
  database.close();
  clearCustomSoundCache();
  customSoundBlob = file;
  return file.name;
}

async function removeCustomNotificationSound(): Promise<void> {
  const database = await openNotificationDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction("sounds", "readwrite");
    transaction.objectStore("sounds").delete("notification");
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not remove custom sound."));
  });
  database.close();
  clearCustomSoundCache();
}

async function playCustomSound(): Promise<boolean> {
  customSoundBlob ??= await loadCustomNotificationSound();
  if (!customSoundBlob) return false;
  if (!customSoundUrl) customSoundUrl = URL.createObjectURL(customSoundBlob);
  const audio = new Audio(customSoundUrl);
  audio.volume = preferences.notificationVolume / 100;
  activeCustomSounds.add(audio);
  const release = () => activeCustomSounds.delete(audio);
  audio.addEventListener("ended", release, { once: true });
  audio.addEventListener("error", release, { once: true });
  try {
    await audio.play();
    return true;
  } catch {
    release();
    return false;
  }
}

async function loadCustomNotificationSound(): Promise<Blob | null> {
  const database = await openNotificationDatabase();
  const sound = await new Promise<Blob | null>((resolve, reject) => {
    const request = database.transaction("sounds", "readonly").objectStore("sounds").get("notification");
    request.onsuccess = () => resolve(request.result instanceof Blob ? request.result : null);
    request.onerror = () => reject(request.error ?? new Error("Could not load custom sound."));
  });
  database.close();
  return sound;
}

function openNotificationDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("wonkitch-media", 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("sounds")) {
        request.result.createObjectStore("sounds");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Local audio storage is unavailable."));
  });
}

async function validateAudioFile(file: File): Promise<void> {
  const url = URL.createObjectURL(file);
  try {
    const duration = await new Promise<number>((resolve, reject) => {
      const audio = new Audio();
      const timeout = window.setTimeout(() => reject(new Error("The audio file took too long to load.")), 5000);
      audio.addEventListener("loadedmetadata", () => {
        window.clearTimeout(timeout);
        resolve(audio.duration);
      });
      audio.addEventListener("error", () => {
        window.clearTimeout(timeout);
        reject(new Error("The selected file is not playable audio."));
      });
      audio.src = url;
    });
    if (!Number.isFinite(duration) || duration <= 0 || duration > 15) {
      throw new Error("Custom notification sounds must be 15 seconds or shorter.");
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}

function clearCustomSoundCache(): void {
  customSoundBlob = null;
  if (customSoundUrl) URL.revokeObjectURL(customSoundUrl);
  customSoundUrl = "";
}

function clearUnreadHighlights(): void {
  unreadHighlights = 0;
  document.title = "wonkitch";
  void appWindow.requestUserAttention(null).catch(() => undefined);
}

async function loadTwitchAuth(): Promise<void> {
  try {
    renderTwitchAuth(await invoke<TwitchAuthStatus>("get_twitch_auth_status"));
  } catch (error) {
    authSummary.textContent = "login unavailable";
    console.error("Could not load Twitch login", error);
  }
}

function renderTwitchAuth(status: TwitchAuthStatus): void {
  twitchAuth = status;
  const username = status.username || "Twitch account";
  accountButton.textContent = status.loggedIn ? `@${username}` : "LOG IN";
  accountButton.title = status.loggedIn ? `Log out @${username}` : "Log in to Twitch";
  chatReadonly.hidden = status.loggedIn;
  chatForm.hidden = !status.loggedIn;
  authSummary.textContent = "anonymous IRC";
  chatInput.disabled = !status.loggedIn;
  chatSend.disabled = !status.loggedIn;
  rerenderVisibleMessages();
}

async function openLoginDialog(): Promise<void> {
  clearAuthError();
  clientIdInput.value = twitchAuth.clientId || "";
  if (!authDialog.open) authDialog.showModal();
  if (twitchAuth.configured) await beginDeviceLogin();
  else showClientSetup();
}

function closeLoginDialog(): void {
  loginGeneration += 1;
  verificationUrl = "";
  void invoke("cancel_twitch_login").catch(() => undefined);
  if (authDialog.open) authDialog.close();
}

function showClientSetup(): void {
  clearAuthError();
  authClientStep.hidden = false;
  authDeviceStep.hidden = true;
  clientIdInput.value = twitchAuth.clientId || clientIdInput.value;
  window.setTimeout(() => clientIdInput.focus(), 0);
}

async function saveClientId(): Promise<void> {
  const clientId = clientIdInput.value.trim();
  clientIdSave.disabled = true;
  clearAuthError();
  try {
    renderTwitchAuth(
      await invoke<TwitchAuthStatus>("configure_twitch_client", { clientId }),
    );
    await beginDeviceLogin();
  } catch (error) {
    showAuthError(error);
  } finally {
    clientIdSave.disabled = false;
  }
}

async function beginDeviceLogin(): Promise<void> {
  const generation = ++loginGeneration;
  clearAuthError();
  authClientStep.hidden = true;
  authDeviceStep.hidden = false;
  deviceCode.value = "--------";
  authProgress.textContent = "Requesting a code...";
  openTwitchButton.disabled = true;

  try {
    const login = await invoke<DeviceLogin>("begin_twitch_login");
    if (generation !== loginGeneration) return;
    verificationUrl = login.verificationUri;
    deviceCode.value = login.userCode;
    authProgress.textContent = "Waiting for approval in your browser...";
    openTwitchButton.disabled = false;
    void openUrl(verificationUrl).catch((error) => showAuthError(error));
    window.setTimeout(
      () => void pollDeviceLogin(generation, login.interval),
      login.interval * 1000,
    );
  } catch (error) {
    if (generation !== loginGeneration) return;
    showAuthError(error);
    authProgress.textContent = "Login could not be started.";
  }
}

async function pollDeviceLogin(generation: number, interval: number): Promise<void> {
  if (generation !== loginGeneration || !authDialog.open) return;
  try {
    const result = await invoke<DevicePoll>("poll_twitch_login");
    if (generation !== loginGeneration) return;
    if (result.state === "complete") {
      renderTwitchAuth(result.account);
      const username = result.account.username || "your Twitch account";
      appendSystemMessage(`Logged in as ${username}.`);
      closeLoginDialog();
      chatInput.focus();
      return;
    }
    const nextInterval = interval + result.retryAfter;
    window.setTimeout(
      () => void pollDeviceLogin(generation, nextInterval),
      nextInterval * 1000,
    );
  } catch (error) {
    if (generation !== loginGeneration) return;
    showAuthError(error);
    authProgress.textContent = "Login stopped.";
  }
}

async function logoutFromTwitch(): Promise<void> {
  const username = twitchAuth.username || "this account";
  if (!window.confirm(`Log out ${username}?`)) return;
  accountButton.disabled = true;
  try {
    renderTwitchAuth(await invoke<TwitchAuthStatus>("logout_twitch"));
    appendSystemMessage(`Logged out ${username}.`);
  } catch (error) {
    appendSystemMessage(readableError(error));
  } finally {
    accountButton.disabled = false;
  }
}

function updateEmoteSuggestions(): void {
  if (document.activeElement !== chatInput) {
    hideEmoteSuggestions();
    return;
  }
  const cursor = chatInput.selectionStart ?? chatInput.value.length;
  const beforeCursor = chatInput.value.slice(0, cursor);
  const match = beforeCursor.match(/(^|\s):([a-z0-9_]{2,}):?$/i);
  if (!match) {
    hideEmoteSuggestions();
    return;
  }

  const query = match[2];
  const results = catalog.search(query);
  if (!results.length) {
    hideEmoteSuggestions();
    return;
  }

  const start = beforeCursor.length - match[0].length + match[1].length;
  emoteSuggestionRange = { start, end: cursor };
  suggestedEmotes = results;
  selectedEmoteSuggestion = 0;
  const fragment = document.createDocumentFragment();
  results.forEach((emote, index) => {
    const button = document.createElement("button");
    button.id = `emote-suggestion-${index}`;
    button.className = "emote-suggestion";
    button.type = "button";
    button.role = "option";
    button.setAttribute("aria-selected", String(index === 0));
    button.classList.toggle("selected", index === 0);
    const image = document.createElement("img");
    image.src = emote.url;
    image.alt = "";
    const name = document.createElement("strong");
    name.textContent = emote.name;
    const provider = document.createElement("span");
    provider.textContent = emote.provider;
    button.append(image, name, provider);
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      insertEmoteSuggestion(index);
    });
    fragment.append(button);
  });
  emoteSuggestions.replaceChildren(fragment);
  emoteSuggestions.hidden = false;
  chatInput.setAttribute("aria-controls", "emote-suggestions");
  chatInput.setAttribute("aria-expanded", "true");
  chatInput.setAttribute("aria-activedescendant", "emote-suggestion-0");
}

function handleEmoteSuggestionKeydown(event: KeyboardEvent): void {
  if (emoteSuggestions.hidden || !suggestedEmotes.length) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const direction = event.key === "ArrowDown" ? 1 : -1;
    selectEmoteSuggestion(selectedEmoteSuggestion + direction);
    return;
  }
  if (event.key === "Enter" || event.key === "Tab") {
    event.preventDefault();
    insertEmoteSuggestion(selectedEmoteSuggestion);
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    hideEmoteSuggestions();
  }
}

function selectEmoteSuggestion(index: number): void {
  selectedEmoteSuggestion = (index + suggestedEmotes.length) % suggestedEmotes.length;
  for (const [itemIndex, button] of [
    ...emoteSuggestions.querySelectorAll<HTMLButtonElement>(".emote-suggestion"),
  ].entries()) {
    const selected = itemIndex === selectedEmoteSuggestion;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-selected", String(selected));
    if (selected) button.scrollIntoView({ block: "nearest" });
  }
  chatInput.setAttribute(
    "aria-activedescendant",
    `emote-suggestion-${selectedEmoteSuggestion}`,
  );
}

function insertEmoteSuggestion(index: number): void {
  const emote = suggestedEmotes[index];
  const range = emoteSuggestionRange;
  if (!emote || !range) return;
  const replacement = `${emote.name} `;
  chatInput.value =
    chatInput.value.slice(0, range.start) + replacement + chatInput.value.slice(range.end);
  const cursor = range.start + replacement.length;
  chatInput.setSelectionRange(cursor, cursor);
  hideEmoteSuggestions();
  chatInput.focus();
}

function hideEmoteSuggestions(): void {
  suggestedEmotes = [];
  selectedEmoteSuggestion = 0;
  emoteSuggestionRange = null;
  emoteSuggestions.hidden = true;
  emoteSuggestions.replaceChildren();
  chatInput.setAttribute("aria-expanded", "false");
  chatInput.removeAttribute("aria-activedescendant");
}

async function sendChatMessage(): Promise<void> {
  const message = chatInput.value.trim();
  if (!message) return;
  if (!currentRoomId) {
    appendSystemMessage("Wait for chat to connect before sending a message.");
    return;
  }

  chatInput.disabled = true;
  chatSend.disabled = true;
  try {
    await invoke("send_chat_message", { broadcasterId: currentRoomId, message });
    chatInput.value = "";
    hideEmoteSuggestions();
  } catch (error) {
    appendSystemMessage(readableError(error));
  } finally {
    chatInput.disabled = false;
    chatSend.disabled = false;
    chatInput.focus();
  }
}

function showAuthError(error: unknown): void {
  authError.textContent = readableError(error);
  authError.hidden = false;
}

function clearAuthError(): void {
  authError.textContent = "";
  authError.hidden = true;
}

function setVerticalLayout(vertical: boolean): void {
  deck.classList.toggle("vertical-layout", vertical);
  layoutToggle.setAttribute("aria-pressed", String(vertical));
  layoutToggle.title = vertical ? "Move chat beside video" : "Move chat below video";
  layoutToggle.setAttribute("aria-label", layoutToggle.title);
}

function setChatVisible(visible: boolean): void {
  deck.classList.toggle("chat-hidden", !visible);
  for (const button of [chatToggle, chatPlayerToggle]) {
    button.setAttribute("aria-pressed", String(visible));
    button.title = visible ? "Hide chat" : "Show chat";
    button.setAttribute("aria-label", button.title);
  }
}

function beginChatResize(event: PointerEvent): void {
  if (
    event.button !== 0 ||
    deck.classList.contains("vertical-layout") ||
    deck.classList.contains("chat-hidden") ||
    window.innerWidth <= 800
  ) {
    return;
  }
  event.preventDefault();
  resizePointerId = event.pointerId;
  chatResizer.setPointerCapture(event.pointerId);
  chatResizer.classList.add("active");
  document.body.classList.add("chat-resizing");
  previewChatWidth(widthFromPointer(event.clientX));
}

function continueChatResize(event: PointerEvent): void {
  if (event.pointerId !== resizePointerId) return;
  previewChatWidth(widthFromPointer(event.clientX));
}

function finishChatResize(event: PointerEvent): void {
  if (event.pointerId !== resizePointerId) return;
  if (chatResizer.hasPointerCapture(event.pointerId)) {
    chatResizer.releasePointerCapture(event.pointerId);
  }
  resizePointerId = null;
  chatResizer.classList.remove("active");
  document.body.classList.remove("chat-resizing");
  preferencesPanel.setChatWidth(previewedChatWidth);
}

function handleChatResizeKeydown(event: KeyboardEvent): void {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  const step = event.shiftKey ? 50 : 20;
  const direction = event.key === "ArrowLeft" ? 1 : -1;
  preferencesPanel.setChatWidth(clampChatWidth(preferences.chatWidth + step * direction));
}

function widthFromPointer(clientX: number): number {
  return clampChatWidth(deck.getBoundingClientRect().right - clientX);
}

function clampChatWidth(width: number): number {
  const maximum = Math.max(260, Math.min(640, deck.clientWidth - 320));
  return Math.round(Math.max(260, Math.min(maximum, width)));
}

function previewChatWidth(width: number): void {
  previewedChatWidth = width;
  document.documentElement.style.setProperty("--chat-width", `${width}px`);
  chatResizer.setAttribute("aria-valuenow", String(width));
}

function handleTitlebarMouseDown(event: MouseEvent): void {
  if (event.buttons !== 1) return;
  const target = event.target;
  if (
    target instanceof Element &&
    target.closest("button, input, select, option, label, form, a, [role='button']")
  ) {
    return;
  }
  event.preventDefault();
  if (event.detail === 2) void toggleWindowMaximized();
  else void appWindow.startDragging();
}

async function toggleWindowMaximized(): Promise<void> {
  await appWindow.toggleMaximize();
  await syncWindowMaximizedState();
}

async function syncWindowMaximizedState(): Promise<void> {
  const maximized = await appWindow.isMaximized();
  document.body.classList.toggle("window-maximized", maximized);
  windowMaximize.classList.toggle("is-maximized", maximized);
  windowMaximize.title = maximized ? "Restore" : "Maximize";
  windowMaximize.setAttribute("aria-label", maximized ? "Restore" : "Maximize");
}

async function setTheaterMode(enabled: boolean): Promise<void> {
  if (enabled && document.fullscreenElement) await document.exitFullscreen();

  theaterMode = enabled;
  app.classList.toggle("theater-mode", enabled);
  for (const button of [theaterToggle, theaterPlayerToggle]) {
    button.setAttribute("aria-pressed", String(enabled));
    button.title = enabled ? "Exit theater mode (F11)" : "Theater mode (F11)";
    button.setAttribute("aria-label", enabled ? "Exit theater mode" : "Enter theater mode");
  }

  try {
    await appWindow.setFullscreen(enabled);
  } catch (error) {
    theaterMode = !enabled;
    app.classList.toggle("theater-mode", theaterMode);
    for (const button of [theaterToggle, theaterPlayerToggle]) {
      button.setAttribute("aria-pressed", String(theaterMode));
      button.title = theaterMode ? "Exit theater mode (F11)" : "Theater mode (F11)";
      button.setAttribute(
        "aria-label",
        theaterMode ? "Exit theater mode" : "Enter theater mode",
      );
    }
    console.error("Could not change theater mode", error);
  }
  document.body.classList.toggle("window-fullscreen", theaterMode);
}

function queueMessage(message: ChatMessage): void {
  visibleMessages.set(message.id, message);
  const disposition = classifyMessage(message);
  if (disposition.highlighted && !disposition.blocked) {
    void handleHighlightAlert(message, disposition.reason);
  }
  messageQueue.push(message);
  if (!messageFrame) messageFrame = requestAnimationFrame(flushMessages);
}

function flushMessages(): void {
  messageFrame = 0;
  if (!messageQueue.length) return;
  const shouldScroll =
    isChatNearBottom() && !(preferences.pauseOnHover && chatLog.matches(":hover"));
  const fragment = document.createDocumentFragment();
  for (const message of messageQueue.splice(0)) fragment.append(renderMessage(message));
  chatLog.append(fragment);

  trimChatHistory();
  if (shouldScroll) scrollChatToLive();
  jumpLive.classList.toggle("visible", !isChatNearBottom());
}

function renderMessage(message: ChatMessage, revealFiltered = false): HTMLElement {
  const row = document.createElement("article");
  row.className = message.isNotice ? "chat-message chat-message--notice" : "chat-message";
  row.dataset.messageId = message.id;

  if (message.isNotice) {
    if (!preferences.showSystemMessages) row.classList.add("chat-message--removed");
    row.textContent = message.text;
    return row;
  }

  const disposition = classifyMessage(message);
  if (disposition.blocked && !revealFiltered) {
    if (preferences.blockedBehavior === "remove") {
      row.classList.add("chat-message--removed");
      return row;
    }
    row.classList.add("chat-message--filtered");
    const label = document.createElement("span");
    label.textContent = `Message hidden by ${disposition.reason}.`;
    const reveal = document.createElement("button");
    reveal.className = "filter-reveal";
    reveal.type = "button";
    reveal.textContent = "SHOW";
    reveal.addEventListener("click", () => row.replaceWith(renderMessage(message, true)));
    row.append(label, reveal);
    return row;
  }
  if (disposition.highlighted) {
    row.classList.add("chat-message--highlighted");
    row.dataset.highlightReason = disposition.reason;
  }

  const header = document.createElement("span");
  header.className = "message-header";
  if (preferences.showBadges) {
    for (const badge of message.badges) header.append(renderBadge(badge));
  }

  const username = document.createElement("span");
  username.className = "username";
  username.textContent = message.displayName;
  username.style.color = usernameColor(message.color, message.login);
  header.append(username, document.createTextNode(message.isAction ? " " : ": "));

  const body = document.createElement("span");
  body.className = message.isAction ? "message-body message-body--action" : "message-body";
  const richText = document.createDocumentFragment();
  appendRichText(richText, message.text, message.emoteTag, catalog, preferences.twitchEmotes);
  body.append(richText);

  if (preferences.showTimestamps) {
    const timestamp = document.createElement("span");
    timestamp.className = "message-ts";
    timestamp.textContent = formatTimestamp(message.timestamp);
    row.append(timestamp);
  }
  row.append(header, body);
  return row;
}

function renderBadge(badge: string): HTMLElement {
  const kind = badge.split("/", 1)[0];
  const item = document.createElement("span");
  item.className = `chat-badge chat-badge--${kind}`;
  item.dataset.badgeKey = badge;
  item.dataset.badgeTitle = humanizeBadgeName(kind);
  applyBadgeMetadata(item);
  return item;
}

function applyBadgeMetadata(item: HTMLElement): void {
  const key = item.dataset.badgeKey;
  if (!key) return;
  const metadata = badgeCatalog.find(key);
  if (!metadata) return;

  const image = document.createElement("img");
  image.src = metadata.imageUrl;
  image.alt = "";
  image.decoding = "async";
  item.replaceChildren(image);
  item.classList.add("chat-badge--image");
  item.dataset.badgeTitle = metadata.title;
  item.dataset.badgeDescription = metadata.description;
}

function findBadgeElement(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>(".chat-badge") : null;
}

function showBadgeTooltip(badge: HTMLElement): void {
  const title = badge.dataset.badgeTitle;
  if (!title) return;
  const description = badge.dataset.badgeDescription;
  badgeTooltip.replaceChildren();

  const heading = document.createElement("strong");
  heading.textContent = title;
  badgeTooltip.append(heading);
  if (description && description !== title) {
    const detail = document.createElement("span");
    detail.textContent = description;
    badgeTooltip.append(detail);
  }

  badgeTooltip.classList.add("visible");
  badgeTooltip.setAttribute("aria-hidden", "false");
  activeBadge = badge;
  positionBadgeTooltip(badge);
}

function positionBadgeTooltip(badge: HTMLElement): void {
  const badgeRect = badge.getBoundingClientRect();
  if (badgeRect.bottom < 0 || badgeRect.top > window.innerHeight) {
    hideBadgeTooltip();
    return;
  }
  const tooltipRect = badgeTooltip.getBoundingClientRect();
  const left = Math.min(
    window.innerWidth - tooltipRect.width - 8,
    Math.max(8, badgeRect.left + badgeRect.width / 2 - tooltipRect.width / 2),
  );
  const above = badgeRect.top - tooltipRect.height - 8;
  const top = above >= 8 ? above : badgeRect.bottom + 8;
  badgeTooltip.style.left = `${left}px`;
  badgeTooltip.style.top = `${top}px`;
}

function hideBadgeTooltip(): void {
  activeBadge = null;
  badgeTooltip.classList.remove("visible");
  badgeTooltip.setAttribute("aria-hidden", "true");
}

function appendSystemMessage(text: string): void {
  const row = document.createElement("article");
  row.className = "chat-message chat-message--notice";
  row.textContent = text;
  chatLog.append(row);
  trimChatHistory();
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

async function checkForUpdate(showFailure: boolean): Promise<void> {
  if (updateCheckActive || updateInstallActive) return;
  updateCheckActive = true;
  updateCheck.disabled = true;
  updateStatus.textContent = "Checking GitHub Releases...";

  try {
    updateCurrentVersion.textContent = await getVersion();
    const available = await check({ timeout: 15_000 });
    if (pendingUpdate) await pendingUpdate.close();
    pendingUpdate = available;

    if (!available) {
      updateAvailable.hidden = true;
      updateReady.hidden = true;
      updateStatus.textContent = "You have the latest version.";
      return;
    }

    updateAvailable.hidden = false;
    updateReady.hidden = false;
    updateVersion.textContent = `wonkitch ${available.version}`;
    updateNotes.textContent = available.body?.trim() || "Install when you are ready to restart wonkitch.";
    updateStatus.textContent = `Version ${available.version} is ready to install.`;
  } catch (error) {
    console.warn("Could not check for a wonkitch update", error);
    updateStatus.textContent = showFailure
      ? `Update check failed: ${readableError(error)}`
      : "Automatic update check unavailable. Use Check Now to retry.";
  } finally {
    updateCheckActive = false;
    updateCheck.disabled = false;
  }
}

async function installPendingUpdate(): Promise<void> {
  if (!pendingUpdate || updateInstallActive) return;
  updateInstallActive = true;
  updateInstall.disabled = true;
  updateCheck.disabled = true;
  updateProgress.hidden = false;
  updateProgress.removeAttribute("value");
  updateStatus.textContent = "Preparing download...";
  let downloaded = 0;

  try {
    await pendingUpdate.downloadAndInstall((event: DownloadEvent) => {
      if (event.event === "Started") {
        downloaded = 0;
        if (event.data.contentLength) {
          updateProgress.max = event.data.contentLength;
          updateProgress.value = 0;
        }
        updateStatus.textContent = "Downloading signed update...";
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
        updateProgress.value = downloaded;
      } else {
        updateStatus.textContent = "Verifying and installing update...";
        updateProgress.value = updateProgress.max;
      }
    });
    updateStatus.textContent = "Update installed. Restarting wonkitch...";
    await relaunch();
  } catch (error) {
    console.error("Could not install the wonkitch update", error);
    updateStatus.textContent = `Update failed: ${readableError(error)}`;
    updateInstallActive = false;
    updateInstall.disabled = false;
    updateCheck.disabled = false;
    updateProgress.hidden = true;
  }
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

const initialChannel = normalizeChannel(localStorage.getItem("wonkitch.channel") || "moonmoon");
setVerticalLayout(portraitOrientation.matches);
channelInput.value = initialChannel;
void initialize();

async function initialize(): Promise<void> {
  await syncWindowMaximizedState();
  applyPreferences(await preferencesPanel.load());
  await loadTwitchAuth();
  void getVersion().then((version) => {
    updateCurrentVersion.textContent = version;
  });
  window.setTimeout(() => void checkForUpdate(false), 2500);
  await tuneChannel(initialChannel);
}
