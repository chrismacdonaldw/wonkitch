import { invoke } from "@tauri-apps/api/core";

export interface AppPreferences {
  version: number;
  accentColor: string;
  chatBackground: string;
  chatTextColor: string;
  reducedMotion: boolean;
  chatFontSize: number;
  chatFontFamily: string;
  lineDensity: "compact" | "comfortable" | "spacious";
  showTimestamps: boolean;
  timestampFormat: "12" | "24";
  timestampSeconds: boolean;
  showBadges: boolean;
  alternatingRows: boolean;
  adjustUsernameColors: boolean;
  chatWidth: number;
  maxMessages: number;
  pauseOnHover: boolean;
  showSystemMessages: boolean;
  emoteSize: number;
  twitchEmotes: boolean;
  ffzEmotes: boolean;
  bttvEmotes: boolean;
  sevenTvEmotes: boolean;
  highlightMentions: boolean;
  highlightColor: string;
  highlightTerms: string[];
  highlightUsers: string[];
  blockedTerms: string[];
  blockedUsers: string[];
  blockedBehavior: "collapse" | "remove";
  desktopNotifications: boolean;
  notificationSound: boolean;
  notificationSoundMode: "chime" | "pulse" | "custom";
  customSoundName: string;
  taskbarAlert: boolean;
  unreadCount: boolean;
  notificationVolume: number;
}

export const DEFAULT_PREFERENCES: AppPreferences = {
  version: 3,
  accentColor: "#9146ff",
  chatBackground: "#0f1013",
  chatTextColor: "#bfc3cb",
  reducedMotion: false,
  chatFontSize: 14,
  chatFontFamily: "Segoe UI",
  lineDensity: "comfortable",
  showTimestamps: true,
  timestampFormat: "24",
  timestampSeconds: false,
  showBadges: true,
  alternatingRows: true,
  adjustUsernameColors: true,
  chatWidth: 380,
  maxMessages: 250,
  pauseOnHover: false,
  showSystemMessages: true,
  emoteSize: 28,
  twitchEmotes: true,
  ffzEmotes: true,
  bttvEmotes: true,
  sevenTvEmotes: true,
  highlightMentions: true,
  highlightColor: "#9146ff",
  highlightTerms: [],
  highlightUsers: [],
  blockedTerms: [],
  blockedUsers: [],
  blockedBehavior: "collapse",
  desktopNotifications: false,
  notificationSound: false,
  notificationSoundMode: "chime",
  customSoundName: "",
  taskbarAlert: false,
  unreadCount: true,
  notificationVolume: 70,
};

interface PreferencesPanelOptions {
  onChange: (preferences: AppPreferences) => void;
  onTestNotification: () => Promise<string>;
  onCustomSound: (file: File) => Promise<string>;
  onRemoveCustomSound: () => Promise<void>;
}

const element = <T extends HTMLElement>(selector: string): T => {
  const match = document.querySelector<T>(selector);
  if (!match) throw new Error(`Missing preferences UI element: ${selector}`);
  return match;
};

export class PreferencesPanel {
  private readonly dialog = element<HTMLDialogElement>("#settings-dialog");
  private readonly form = element<HTMLFormElement>("#settings-form");
  private readonly saveStatus = element<HTMLElement>("#settings-save-status");
  private readonly notificationStatus = element<HTMLElement>("#notification-test-status");
  private saveTimer: number | null = null;
  private saveGeneration = 0;
  private preferences = structuredClone(DEFAULT_PREFERENCES);

  constructor(private readonly options: PreferencesPanelOptions) {
    element<HTMLButtonElement>("#settings-close").addEventListener("click", () => this.close());
    element<HTMLButtonElement>("#settings-reset").addEventListener("click", () => {
      void this.reset();
    });
    element<HTMLButtonElement>("#notification-test").addEventListener("click", () => {
      void this.testNotification();
    });
    element<HTMLInputElement>("#custom-sound-file").addEventListener("change", (event) => {
      void this.uploadCustomSound(event);
    });
    element<HTMLButtonElement>("#custom-sound-remove").addEventListener("click", () => {
      void this.removeCustomSound();
    });
    this.dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.close();
    });
    this.form.addEventListener("submit", (event) => event.preventDefault());
    this.form.addEventListener("input", () => this.handleInput());
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-settings-page]")) {
      button.addEventListener("click", () => this.selectPage(button.dataset.settingsPage || "appearance"));
    }
  }

  async load(): Promise<AppPreferences> {
    try {
      this.preferences = await invoke<AppPreferences>("get_preferences");
      this.saveStatus.textContent = "saved automatically";
    } catch (error) {
      console.error("Could not load preferences", error);
      this.preferences = structuredClone(DEFAULT_PREFERENCES);
      this.saveStatus.textContent = "preferences unavailable";
    }
    this.populate(this.preferences);
    return this.preferences;
  }

  open(page = "appearance"): void {
    this.selectPage(page);
    if (!this.dialog.open) this.dialog.showModal();
  }

  setChatWidth(width: number): void {
    this.preferences = { ...this.preferences, chatWidth: Math.round(width) };
    this.setValue("chat-width", this.preferences.chatWidth);
    this.syncOutputs();
    this.options.onChange(this.preferences);
    this.scheduleSave();
  }

  private close(): void {
    if (this.dialog.open) this.dialog.close();
  }

  private selectPage(page: string): void {
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-settings-page]")) {
      button.classList.toggle("active", button.dataset.settingsPage === page);
    }
    for (const panel of document.querySelectorAll<HTMLElement>("[data-settings-panel]")) {
      panel.hidden = panel.dataset.settingsPanel !== page;
    }
  }

  private handleInput(): void {
    this.preferences = this.read();
    this.syncOutputs();
    this.options.onChange(this.preferences);
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    const generation = ++this.saveGeneration;
    this.saveStatus.textContent = "saving...";
    this.saveTimer = window.setTimeout(async () => {
      this.saveTimer = null;
      try {
        const saved = await invoke<AppPreferences>("save_preferences", {
          preferences: this.preferences,
        });
        if (generation !== this.saveGeneration) return;
        this.preferences = saved;
        this.saveStatus.textContent = "saved";
      } catch (error) {
        if (generation !== this.saveGeneration) return;
        this.saveStatus.textContent = String(error).replace(/^Error:\s*/i, "");
      }
    }, 300);
  }

  private async reset(): Promise<void> {
    if (!window.confirm("Reset all wonkitch preferences to their defaults?")) return;
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.saveGeneration += 1;
    try {
      await this.options.onRemoveCustomSound();
      this.preferences = await invoke<AppPreferences>("reset_preferences");
      this.populate(this.preferences);
      this.options.onChange(this.preferences);
      this.saveStatus.textContent = "defaults restored";
    } catch (error) {
      this.saveStatus.textContent = String(error).replace(/^Error:\s*/i, "");
    }
  }

  private async testNotification(): Promise<void> {
    this.notificationStatus.textContent = "testing...";
    try {
      this.notificationStatus.textContent = await this.options.onTestNotification();
    } catch (error) {
      this.notificationStatus.textContent = String(error).replace(/^Error:\s*/i, "");
    }
  }

  private async uploadCustomSound(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.notificationStatus.textContent = "checking audio...";
    try {
      const name = await this.options.onCustomSound(file);
      this.setValue("custom-sound-name-value", name);
      this.setValue("notification-sound-mode", "custom");
      this.syncCustomSound(name);
      this.handleInput();
      this.notificationStatus.textContent = "Custom sound uploaded. Use Test Alert to preview it.";
    } catch (error) {
      this.notificationStatus.textContent = String(error).replace(/^Error:\s*/i, "");
    } finally {
      input.value = "";
    }
  }

  private async removeCustomSound(): Promise<void> {
    try {
      await this.options.onRemoveCustomSound();
      this.setValue("custom-sound-name-value", "");
      if (this.value("notification-sound-mode") === "custom") {
        this.setValue("notification-sound-mode", "chime");
      }
      this.syncCustomSound("");
      this.handleInput();
      this.notificationStatus.textContent = "Custom sound removed.";
    } catch (error) {
      this.notificationStatus.textContent = String(error).replace(/^Error:\s*/i, "");
    }
  }

  private populate(preferences: AppPreferences): void {
    this.setValue("accent-color", preferences.accentColor);
    this.setValue("chat-background", preferences.chatBackground);
    this.setValue("chat-text-color", preferences.chatTextColor);
    this.setChecked("reduced-motion", preferences.reducedMotion);
    this.setValue("chat-font-size", preferences.chatFontSize);
    this.setValue("chat-font-family", preferences.chatFontFamily);
    this.setValue("line-density", preferences.lineDensity);
    this.setChecked("show-timestamps", preferences.showTimestamps);
    this.setValue("timestamp-format", preferences.timestampFormat);
    this.setChecked("timestamp-seconds", preferences.timestampSeconds);
    this.setChecked("show-badges", preferences.showBadges);
    this.setChecked("alternating-rows", preferences.alternatingRows);
    this.setChecked("adjust-username-colors", preferences.adjustUsernameColors);
    this.setValue("chat-width", preferences.chatWidth);
    this.setValue("max-messages", preferences.maxMessages);
    this.setChecked("pause-on-hover", preferences.pauseOnHover);
    this.setChecked("show-system-messages", preferences.showSystemMessages);
    this.setValue("emote-size", preferences.emoteSize);
    this.setChecked("twitch-emotes", preferences.twitchEmotes);
    this.setChecked("ffz-emotes", preferences.ffzEmotes);
    this.setChecked("bttv-emotes", preferences.bttvEmotes);
    this.setChecked("seven-tv-emotes", preferences.sevenTvEmotes);
    this.setChecked("highlight-mentions", preferences.highlightMentions);
    this.setValue("highlight-color", preferences.highlightColor);
    this.setValue("highlight-terms", preferences.highlightTerms.join("\n"));
    this.setValue("highlight-users", preferences.highlightUsers.join("\n"));
    this.setValue("blocked-terms", preferences.blockedTerms.join("\n"));
    this.setValue("blocked-users", preferences.blockedUsers.join("\n"));
    this.setValue("blocked-behavior", preferences.blockedBehavior);
    this.setChecked("desktop-notifications", preferences.desktopNotifications);
    this.setChecked("notification-sound", preferences.notificationSound);
    this.setValue("notification-sound-mode", preferences.notificationSoundMode);
    this.setValue("custom-sound-name-value", preferences.customSoundName);
    this.syncCustomSound(preferences.customSoundName);
    this.setChecked("taskbar-alert", preferences.taskbarAlert);
    this.setChecked("unread-count", preferences.unreadCount);
    this.setValue("notification-volume", preferences.notificationVolume);
    this.syncOutputs();
  }

  private read(): AppPreferences {
    return {
      version: 3,
      accentColor: this.value("accent-color"),
      chatBackground: this.value("chat-background"),
      chatTextColor: this.value("chat-text-color"),
      reducedMotion: this.checked("reduced-motion"),
      chatFontSize: this.number("chat-font-size"),
      chatFontFamily: this.value("chat-font-family"),
      lineDensity: this.value("line-density") as AppPreferences["lineDensity"],
      showTimestamps: this.checked("show-timestamps"),
      timestampFormat: this.value("timestamp-format") as AppPreferences["timestampFormat"],
      timestampSeconds: this.checked("timestamp-seconds"),
      showBadges: this.checked("show-badges"),
      alternatingRows: this.checked("alternating-rows"),
      adjustUsernameColors: this.checked("adjust-username-colors"),
      chatWidth: this.number("chat-width"),
      maxMessages: this.number("max-messages"),
      pauseOnHover: this.checked("pause-on-hover"),
      showSystemMessages: this.checked("show-system-messages"),
      emoteSize: this.number("emote-size"),
      twitchEmotes: this.checked("twitch-emotes"),
      ffzEmotes: this.checked("ffz-emotes"),
      bttvEmotes: this.checked("bttv-emotes"),
      sevenTvEmotes: this.checked("seven-tv-emotes"),
      highlightMentions: this.checked("highlight-mentions"),
      highlightColor: this.value("highlight-color"),
      highlightTerms: this.rules("highlight-terms"),
      highlightUsers: this.rules("highlight-users"),
      blockedTerms: this.rules("blocked-terms"),
      blockedUsers: this.rules("blocked-users"),
      blockedBehavior: this.value("blocked-behavior") as AppPreferences["blockedBehavior"],
      desktopNotifications: this.checked("desktop-notifications"),
      notificationSound: this.checked("notification-sound"),
      notificationSoundMode: this.value(
        "notification-sound-mode",
      ) as AppPreferences["notificationSoundMode"],
      customSoundName: this.value("custom-sound-name-value"),
      taskbarAlert: this.checked("taskbar-alert"),
      unreadCount: this.checked("unread-count"),
      notificationVolume: this.number("notification-volume"),
    };
  }

  private syncOutputs(): void {
    element<HTMLOutputElement>("#chat-font-size-value").value = `${this.value("chat-font-size")}px`;
    element<HTMLOutputElement>("#emote-size-value").value = `${this.value("emote-size")}px`;
    element<HTMLOutputElement>("#max-messages-value").value = this.value("max-messages");
    element<HTMLOutputElement>("#chat-width-value").value = `${this.value("chat-width")}px`;
    element<HTMLOutputElement>("#notification-volume-value").value = `${this.value("notification-volume")}%`;
  }

  private syncCustomSound(name: string): void {
    element<HTMLElement>("#custom-sound-name").textContent = name || "No custom sound uploaded";
    element<HTMLButtonElement>("#custom-sound-remove").hidden = !name;
  }

  private value(id: string): string {
    return element<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`#${id}`).value;
  }

  private number(id: string): number {
    return Number(this.value(id));
  }

  private checked(id: string): boolean {
    return element<HTMLInputElement>(`#${id}`).checked;
  }

  private rules(id: string): string[] {
    return [...new Set(this.value(id).split("\n").map((rule) => rule.trim()).filter(Boolean))];
  }

  private setValue(id: string, value: string | number): void {
    element<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`#${id}`).value = String(value);
  }

  private setChecked(id: string, checked: boolean): void {
    element<HTMLInputElement>(`#${id}`).checked = checked;
  }
}
