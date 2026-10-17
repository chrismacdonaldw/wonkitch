export interface PlaybackHealthSnapshot {
  currentTime: number;
  paused: boolean;
  ended: boolean;
  seeking: boolean;
}

export interface PlaybackHealthResult {
  stalled: boolean;
  healthy: boolean;
}

interface PlaybackHealthThresholds {
  startupMs?: number;
  stallMs?: number;
  stableMs?: number;
}

const PROGRESS_EPSILON = 0.01;
const MAX_HEALTHY_GAP_MS = 2_000;

// Browser "playing" and readyState can stay unchanged after a transport dies.
// Measure the media clock instead, using a monotonic clock supplied by the caller.
export class PlaybackHealth {
  private readonly startupMs: number;
  private readonly stallMs: number;
  private readonly stableMs: number;
  private initialized = false;
  private mediaTime = 0;
  private lastProgressAt = 0;
  private hasProgress = false;
  private suspended = false;
  private seekingProgressAt: number | null = null;
  private seekingMediaTime = 0;
  private stableSince: number | null = null;
  private stableMediaTime = 0;

  constructor(thresholds: PlaybackHealthThresholds = {}) {
    this.startupMs = thresholds.startupMs ?? 25_000;
    this.stallMs = thresholds.stallMs ?? 12_000;
    this.stableMs = thresholds.stableMs ?? 15_000;
    for (const duration of [this.startupMs, this.stallMs, this.stableMs]) {
      if (!Number.isFinite(duration) || duration <= 0) {
        throw new Error("Playback health thresholds must be positive finite durations.");
      }
    }
  }

  reset(now: number, currentTime: number, hasProgress = false): void {
    this.initialized = true;
    this.hasProgress = hasProgress;
    this.suspended = false;
    this.seekingProgressAt = null;
    this.restartBaseline(now, currentTime);
  }

  sample(snapshot: PlaybackHealthSnapshot, now: number): PlaybackHealthResult {
    if (!this.initialized || now < this.lastProgressAt) this.reset(now, snapshot.currentTime);

    if (snapshot.paused && !snapshot.ended) {
      this.restartBaseline(now, snapshot.currentTime);
      this.seekingProgressAt = null;
      this.suspended = true;
      return { stalled: false, healthy: false };
    }
    if (snapshot.seeking) {
      const movement = snapshot.currentTime - this.seekingMediaTime;
      if (this.seekingProgressAt === null
        || (Number.isFinite(movement) && Math.abs(movement) > PROGRESS_EPSILON)) {
        this.seekingProgressAt = now;
        this.seekingMediaTime = Number.isFinite(snapshot.currentTime) ? snapshot.currentTime : 0;
      }
      this.restartBaseline(now, snapshot.currentTime);
      this.suspended = true;
      // Ordinary seeks receive grace, but a stuck MSE/latency-chasing seek
      // must not suspend recovery forever.
      return { stalled: now - this.seekingProgressAt >= this.startupMs, healthy: false };
    }
    this.seekingProgressAt = null;
    // A live response can finish cleanly and leave the media both ended and
    // paused. That pause is not evidence that the viewer chose to pause it.
    if (snapshot.ended) return { stalled: true, healthy: false };

    if (this.suspended) {
      this.restartBaseline(now, snapshot.currentTime);
      this.suspended = false;
      return { stalled: false, healthy: false };
    }

    const movement = snapshot.currentTime - this.mediaTime;
    if (Number.isFinite(movement) && movement < -PROGRESS_EPSILON) {
      this.restartBaseline(now, snapshot.currentTime);
      return { stalled: false, healthy: false };
    }
    if (Number.isFinite(movement) && movement > PROGRESS_EPSILON) {
      if (this.stableSince === null || now - this.lastProgressAt > MAX_HEALTHY_GAP_MS) {
        this.stableSince = now;
        this.stableMediaTime = snapshot.currentTime;
      }
      this.mediaTime = snapshot.currentTime;
      this.lastProgressAt = now;
      this.hasProgress = true;
      // Also require substantial media advancement: a series of tiny nudges
      // must not replenish the retry budget of a mostly frozen player.
      const healthy = now - this.stableSince >= this.stableMs
        && snapshot.currentTime - this.stableMediaTime >= this.stableMs / 2_000;
      return { stalled: false, healthy };
    }

    const idleMs = now - this.lastProgressAt;
    if (idleMs > MAX_HEALTHY_GAP_MS) this.stableSince = null;
    return { stalled: idleMs >= (this.hasProgress ? this.stallMs : this.startupMs), healthy: false };
  }

  private restartBaseline(now: number, currentTime: number): void {
    this.mediaTime = Number.isFinite(currentTime) ? currentTime : 0;
    this.lastProgressAt = now;
    this.stableSince = null;
  }
}
