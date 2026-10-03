export interface PlaybackSnapshot {
  currentTime: number;
  bufferedEnd: number | null;
  playingDate: number | null;
  liveLatency?: number | null;
  advancing: boolean;
}

export interface ChatSyncStatus {
  mode: "off" | "live" | "waiting" | "paused" | "synced" | "estimated";
  delay: number | null;
}

// Use the range containing playback, not a future range beyond a buffer gap.
export function playbackBufferEnd(
  ranges: Pick<TimeRanges, "length" | "start" | "end">,
  currentTime: number,
): number | null {
  for (let index = 0; index < ranges.length; index += 1) {
    if (ranges.start(index) <= currentTime + 0.05 && ranges.end(index) >= currentTime) {
      return ranges.end(index);
    }
  }
  return null;
}

export class ChatSynchronizer<T extends { timestamp: number }> {
  private pending: { message: T; timestamp: number }[] = [];
  private head = 0;
  private enabled = true;
  private offset = 0;
  private active = false;
  private advancing = false;
  private playedTime: number | null = null;
  private estimated = true;
  private anchor: { mediaTime: number; wallTime: number; source: "timestamp" | "playlist" | "buffer" } | null = null;

  constructor(private readonly maximumPending = 10_000) {
    if (!Number.isInteger(maximumPending) || maximumPending < 1) {
      throw new Error("The pending chat limit must be a positive integer.");
    }
  }

  get pendingCount(): number {
    return this.pending.length - this.head;
  }

  configure(enabled: boolean, offsetSeconds: number): void {
    this.enabled = enabled;
    this.offset = Number.isFinite(offsetSeconds) ? Math.max(-30, Math.min(120, offsetSeconds)) : 0;
  }

  setVideoActive(active: boolean): void {
    if (active && !this.active) this.resetPlayback();
    this.active = active;
  }

  // Quality/transport changes keep queued messages but need a new media clock.
  resetPlayback(): void {
    this.advancing = false;
    this.playedTime = null;
    this.anchor = null;
    this.estimated = true;
  }

  // Channel/VOD changes also discard the previous channel's pending messages.
  reset(): void {
    this.pending = [];
    this.head = 0;
    this.active = false;
    this.resetPlayback();
  }

  update(snapshot: PlaybackSnapshot, now: number): void {
    this.advancing = snapshot.advancing;
    if (!this.active || !snapshot.advancing || !Number.isFinite(snapshot.currentTime)) return;
    if (snapshot.playingDate !== null && Number.isFinite(snapshot.playingDate) && snapshot.playingDate > 0) {
      this.playedTime = Math.min(now, snapshot.playingDate);
      this.anchor = { mediaTime: snapshot.currentTime, wallTime: this.playedTime, source: "timestamp" };
      this.estimated = false;
      return;
    }
    // The live playlist can be much farther ahead than the downloaded buffer.
    // Prefer its latency estimate, but retain any stronger timestamp mapping.
    if (snapshot.liveLatency != null && Number.isFinite(snapshot.liveLatency) && snapshot.liveLatency > 0
      && (!this.anchor || this.anchor.source === "buffer")) {
      this.anchor = { mediaTime: snapshot.currentTime, wallTime: now - snapshot.liveLatency * 1000, source: "playlist" };
    }
    if (!this.anchor) {
      if (snapshot.bufferedEnd === null || !Number.isFinite(snapshot.bufferedEnd)) return;
      this.anchor = { mediaTime: snapshot.bufferedEnd, wallTime: now, source: "buffer" };
    }
    // Anchor once: wall-clock ticks and newly downloaded chunks must not move
    // chat while the displayed media time stands still. Pauses and catch-up
    // therefore follow currentTime, including latency chasing by mpegts.js.
    this.playedTime = Math.min(now, this.anchor.wallTime + (snapshot.currentTime - this.anchor.mediaTime) * 1000);
    this.estimated = true;
  }

  enqueue(message: T, now: number): void {
    const timestamp = Number.isFinite(message.timestamp) && message.timestamp > 0
      ? Math.min(message.timestamp, now)
      : now;
    this.pending.push({ message, timestamp });
    if (this.pendingCount > this.maximumPending) this.head += 1;
    this.compact();
  }

  drain(now: number, limit = 200): T[] {
    const immediate = !this.enabled || !this.active;
    if (!immediate && (!this.advancing || this.playedTime === null)) return [];
    const cutoff = immediate ? now : Math.min(now, (this.playedTime ?? now) - this.offset * 1000);
    const ready: T[] = [];
    while (this.head < this.pending.length && ready.length < limit) {
      const next = this.pending[this.head];
      if (next.timestamp > cutoff) break;
      ready.push(next.message);
      this.head += 1;
    }
    this.compact();
    return ready;
  }

  status(now: number): ChatSyncStatus {
    if (!this.enabled) return { mode: "off", delay: 0 };
    if (!this.active) return { mode: "live", delay: 0 };
    if (this.playedTime === null) return { mode: "waiting", delay: null };
    const delay = Math.max(0, (now - this.playedTime) / 1000 + this.offset);
    if (!this.advancing) return { mode: "paused", delay };
    return { mode: this.estimated ? "estimated" : "synced", delay };
  }

  private compact(): void {
    if (this.head === this.pending.length) {
      this.pending = [];
      this.head = 0;
    } else if (this.head > 512 && this.head * 2 >= this.pending.length) {
      this.pending = this.pending.slice(this.head);
      this.head = 0;
    }
  }
}
