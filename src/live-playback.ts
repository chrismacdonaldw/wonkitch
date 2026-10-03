export type LiveTransport = "mpegts" | "hls";

export interface StreamInfo {
  url: string;
  channel: string;
  quality: string;
  qualities: string[];
  title: string;
  category: string;
  transport: LiveTransport;
}

export interface LivePlaybackRequest {
  isCurrent(): boolean;
  recoverFormat(detail: unknown): boolean;
}

interface LivePlaybackHooks {
  start(channel: string, quality: string, transport: LiveTransport): Promise<StreamInfo>;
  attach(info: StreamInfo, request: LivePlaybackRequest): Promise<void>;
  loading(channel: string, quality: string, hardSwitch: boolean): void;
  destroy(): void;
  stop(): Promise<void>;
  error(channel: string, error: unknown): void;
  settled(): void;
}

export class LivePlayback {
  private generation = 0;
  private transport: LiveTransport = "mpegts";

  constructor(private readonly hooks: LivePlaybackHooks) {}

  reset(): void {
    this.generation += 1;
    this.transport = "mpegts";
  }

  async tune(channel: string, quality: string, hardSwitch: boolean): Promise<void> {
    const generation = ++this.generation;
    const transport = this.transport;
    const isCurrent = () => generation === this.generation;
    this.hooks.loading(channel, quality, hardSwitch);

    try {
      const info = await this.hooks.start(channel, quality, transport);
      if (!isCurrent()) return;
      await this.hooks.attach(info, {
        isCurrent,
        recoverFormat: (detail) => {
          if (!isCurrent() || transport !== "mpegts" || detail !== "FormatUnsupported") return false;
          // Twitch can deliver fragmented MP4 even for H.264 renditions.
          // Keep HLS for quality changes in this channel; reset on a new channel.
          this.transport = "hls";
          void this.tune(info.channel, info.quality, true);
          return true;
        },
      });
    } catch (error) {
      if (!isCurrent()) return;
      if (hardSwitch) {
        this.hooks.destroy();
        await this.hooks.stop();
        if (!isCurrent()) return;
      }
      this.hooks.error(channel, error);
    } finally {
      if (isCurrent()) this.hooks.settled();
    }
  }
}
