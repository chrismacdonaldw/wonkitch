import { PlaybackHealth, type PlaybackHealthSnapshot } from "./playback-health";

export type LiveTransport = "mpegts" | "hls";
export type LiveRecoveryReason = "ended" | "error" | "stalled";

export interface StreamInfo {
  sessionId?: number;
  url: string;
  channel: string;
  quality: string;
  qualities: string[];
  title: string;
  category: string;
  transport: LiveTransport;
}

export interface StreamStatus {
  sessionId: number;
  adBreak: boolean;
  adRemainingSeconds: number | null;
  event: string | null;
  revision: number;
}

export interface LivePlaybackRequest {
  isCurrent(): boolean;
  shouldPlay(): boolean;
  recoverFormat(detail: unknown): boolean;
  recover(reason: LiveRecoveryReason): boolean;
}

interface LivePlaybackHooks {
  start(channel: string, quality: string, transport: LiveTransport): Promise<StreamInfo>;
  attach(info: StreamInfo, request: LivePlaybackRequest): Promise<void>;
  loading(channel: string, quality: string, hardSwitch: boolean, recovering: boolean): void;
  recovering?(channel: string, reason: LiveRecoveryReason, attempt: number, delayMs: number): void;
  resumed?(): void;
  adBreak?(channel: string, active: boolean): void;
  destroy(): void;
  stop(): Promise<void>;
  error(channel: string, error: unknown): void;
  settled(): void;
}

interface LivePlaybackDependencies {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(timer: number): void;
}

const RETRY_DELAYS = [1000, 2000, 4000, 8000, 15000];
const START_TIMEOUT = 40_000;

export class LivePlayback {
  private generation = 0;
  private transport: LiveTransport = "mpegts";
  private readonly health = new PlaybackHealth();
  private readonly dependencies: LivePlaybackDependencies;
  private desired: { channel: string; quality: string } | null = null;
  private attached = false;
  private healthReady = false;
  private mediaStarted = false;
  private userPaused = false;
  private exhausted = false;
  private recoveryAttempts = 0;
  private retryTimer: number | null = null;
  private recoveryReason: LiveRecoveryReason | null = null;
  private recoveryTime = 0;
  private observedTime = 0;
  private cancelStart: (() => void) | null = null;
  private stopping: Promise<void> | null = null;
  private adBreak = false;
  private adDeadline = 0;
  private resumingAd = false;
  private adRevision = 0;
  private expiredAdRevision: number | null = null;

  constructor(private readonly hooks: LivePlaybackHooks, dependencies?: Partial<LivePlaybackDependencies>) {
    this.dependencies = {
      now: () => performance.now(),
      setTimeout: (callback, delay) => window.setTimeout(callback, delay),
      clearTimeout: (timer) => window.clearTimeout(timer),
      ...dependencies,
    };
  }

  reset(): Promise<void> {
    this.generation += 1;
    this.cancelRecovery();
    this.cancelStart?.();
    this.desired = null;
    this.attached = false;
    this.userPaused = false;
    this.exhausted = false;
    this.recoveryAttempts = 0;
    this.adBreak = false;
    this.resumingAd = false;
    this.expiredAdRevision = null;
    this.transport = "mpegts";
    return this.stopping ?? Promise.resolve();
  }

  async tune(channel: string, quality: string, hardSwitch: boolean): Promise<void> {
    this.cancelRecovery();
    this.exhausted = false;
    this.recoveryAttempts = 0;
    await this.open(channel, quality, hardSwitch, false);
  }

  setPaused(paused: boolean): void {
    this.userPaused = paused;
    if (paused) this.clearRetryTimer();
    else if (this.recoveryReason && this.retryTimer === null) this.scheduleRecovery();
  }

  setAdBreak(active: boolean, revision = 0): void {
    if (!this.attached || !this.desired || this.exhausted) return;
    if (active) {
      if (this.expiredAdRevision !== null && revision <= this.expiredAdRevision) return;
      this.adRevision = revision;
      if (this.adBreak) return;
      this.adBreak = true;
      // Do not trust a missing or stale status source indefinitely.
      this.adDeadline = this.dependencies.now() + 615_000;
      this.resumingAd = false;
      this.healthReady = false;
      if (this.recoveryReason === "stalled") this.cancelRecovery();
      else this.clearRetryTimer();
      this.hooks.adBreak?.(this.desired.channel, true);
    } else if (this.adBreak) {
      this.adBreak = false;
      this.healthReady = false;
      this.resumingAd = true;
      this.hooks.adBreak?.(this.desired.channel, false);
      if (this.recoveryReason) this.scheduleRecovery();
    }
  }

  observe(snapshot: PlaybackHealthSnapshot): void {
    if (!this.attached || !this.desired || this.exhausted) return;
    const previousTime = this.observedTime;
    if ((this.healthReady || this.resumingAd) && !snapshot.paused && !snapshot.seeking
      && snapshot.currentTime > previousTime + 0.01) {
      this.mediaStarted = true;
    }
    if (this.adBreak) {
      this.observedTime = snapshot.currentTime;
      if (this.dependencies.now() < this.adDeadline) return;
      this.expiredAdRevision = this.adRevision;
      this.setAdBreak(false);
    }
    if (!this.healthReady) {
      this.health.reset(this.dependencies.now(), snapshot.currentTime, this.mediaStarted);
      this.healthReady = true;
    }
    this.observedTime = snapshot.currentTime;
    // HLS may remain paused while its first playlist/media never arrives.
    // Before any playback, only an explicit pause should disable the watchdog.
    const paused = this.userPaused || (this.mediaStarted && snapshot.paused && !snapshot.ended);
    const result = this.health.sample({ ...snapshot, paused }, this.dependencies.now());
    if (this.resumingAd && !this.recoveryReason && !paused && !snapshot.paused && !snapshot.seeking
      && snapshot.currentTime > previousTime + 0.05) {
      this.resumingAd = false;
      this.hooks.resumed?.();
    }
    if (this.recoveryReason === "stalled" && !paused && !snapshot.paused && !snapshot.seeking
      && snapshot.currentTime > this.recoveryTime + 0.05) {
      this.cancelRecovery();
      this.resumingAd = false;
      this.hooks.resumed?.();
    }
    if (result.healthy && !this.recoveryReason) this.recoveryAttempts = 0;
    if (result.stalled && !this.userPaused) this.recover(snapshot.ended ? "ended" : "stalled");
  }

  recover(reason: LiveRecoveryReason): boolean {
    // Native media events can still be queued while a newer session is opening.
    if (!this.attached) return false;
    return this.requestRecovery(reason);
  }

  private requestRecovery(reason: LiveRecoveryReason): boolean {
    if (!this.desired || this.exhausted) return false;
    if (!this.recoveryReason) {
      this.recoveryReason = reason;
      this.recoveryTime = this.observedTime;
      this.scheduleRecovery();
    } else if (this.recoveryReason === "stalled" && reason !== "stalled") {
      // Buffered frames can still advance after EOF or a fatal error. They
      // cannot cancel a recovery once the transport is known to be finished.
      this.recoveryReason = reason;
    }
    return true;
  }

  private async open(channel: string, quality: string, hardSwitch: boolean, recovering: boolean): Promise<void> {
    const generation = ++this.generation;
    this.cancelStart?.();
    this.attached = false;
    this.healthReady = false;
    this.mediaStarted = false;
    this.adBreak = false;
    this.resumingAd = false;
    this.expiredAdRevision = null;
    this.desired = { channel, quality };
    const transport = this.transport;
    const isCurrent = () => generation === this.generation;
    this.hooks.loading(channel, quality, hardSwitch, recovering);

    try {
      // A new user selection must not overtake cleanup of the failed session.
      if (this.stopping) {
        await this.stopping;
        if (!isCurrent()) return;
      }
      const info = await this.start(channel, quality, transport);
      if (!isCurrent()) return;
      this.desired = { channel: info.channel, quality: info.quality };
      await this.hooks.attach(info, {
        isCurrent,
        shouldPlay: () => isCurrent() && !this.userPaused,
        recoverFormat: (detail) => {
          if (!isCurrent() || transport !== "mpegts" || detail !== "FormatUnsupported") return false;
          // Twitch can deliver fragmented MP4 even for H.264 renditions.
          // Keep HLS for quality changes in this channel; reset on a new channel.
          this.transport = "hls";
          this.cancelRecovery();
          void this.open(info.channel, info.quality, true, recovering);
          return true;
        },
        recover: (reason) => isCurrent() && this.requestRecovery(reason),
      });
      if (!isCurrent()) return;
      this.observedTime = 0;
      this.attached = true;
    } catch (error) {
      if (!isCurrent()) return;
      this.attached = false;
      if (hardSwitch) {
        this.hooks.destroy();
        await this.stop();
        if (!isCurrent()) return;
      }
      if (recovering) this.requestRecovery("error");
      else {
        this.cancelRecovery();
        this.desired = null;
        this.hooks.error(channel, error);
      }
    } finally {
      if (isCurrent()) this.hooks.settled();
    }
  }

  private start(channel: string, quality: string, transport: LiveTransport): Promise<StreamInfo> {
    return new Promise((resolve, reject) => {
      const clear = () => {
        this.dependencies.clearTimeout(timer);
        if (this.cancelStart === cancel) this.cancelStart = null;
      };
      const cancel = () => {
        clear();
        reject(new Error("Stream request was superseded"));
      };
      const timer = this.dependencies.setTimeout(() => {
        clear();
        reject(new Error("The stream connection took too long. Try reopening the channel."));
      }, START_TIMEOUT);
      this.cancelStart = cancel;
      try {
        void this.hooks.start(channel, quality, transport).then((info) => {
          clear();
          resolve(info);
        }, (error) => {
          clear();
          reject(error);
        });
      } catch (error) {
        clear();
        reject(error);
      }
    });
  }

  private scheduleRecovery(): void {
    if (this.userPaused || this.adBreak || !this.desired || !this.recoveryReason) return;
    if (this.recoveryAttempts >= RETRY_DELAYS.length) {
      const channel = this.desired.channel;
      this.exhausted = true;
      this.attached = false;
      this.generation += 1;
      this.cancelRecovery();
      this.hooks.destroy();
      void this.stop();
      this.hooks.error(channel, new Error("Playback stopped repeatedly. Try another quality or reopen the channel."));
      this.hooks.settled();
      return;
    }
    const generation = this.generation;
    const delay = RETRY_DELAYS[this.recoveryAttempts];
    this.hooks.recovering?.(this.desired.channel, this.recoveryReason, this.recoveryAttempts + 1, delay);
    this.retryTimer = this.dependencies.setTimeout(() => {
      this.retryTimer = null;
      if (generation !== this.generation || !this.desired || this.userPaused) return;
      const { channel, quality } = this.desired;
      this.recoveryReason = null;
      this.recoveryAttempts += 1;
      void this.open(channel, quality, true, true);
    }, delay);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) this.dependencies.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private stop(): Promise<void> {
    const pending = this.hooks.stop().catch(() => undefined);
    this.stopping = pending;
    void pending.then(() => {
      if (this.stopping === pending) this.stopping = null;
    });
    return pending;
  }

  private cancelRecovery(): void {
    this.clearRetryTimer();
    this.recoveryReason = null;
  }
}
