import { SevenTvEvents, type SevenTvSubscription } from "./seventv-events";
import type { EmoteCatalog } from "./emotes";

type LiveCatalog = Pick<EmoteCatalog, "sevenTvSubscription" | "sevenTvRefreshIncomplete" | "refreshSevenTv" | "list">;
interface EventFeed {
  watch(subscription: SevenTvSubscription): void;
  disconnect(): void;
  dispose(): void;
}
interface LiveDependencies {
  createEvents(onInvalidate: () => void): EventFeed;
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
  now(): number;
}

/** Batch event bursts and reconcile authoritative snapshots without restarting other providers. */
export class SevenTvLiveUpdates {
  private readonly dependencies: LiveDependencies;
  private readonly events: EventFeed;
  private generation = 0;
  private active = false;
  private disposed = false;
  private fetchingGeneration: number | null = null;
  private dirty = false;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshAt = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 30_000;
  private signature = "";

  constructor(
    private readonly catalog: LiveCatalog,
    private readonly onUpdated: () => void,
    dependencies: Partial<LiveDependencies> = {},
  ) {
    this.dependencies = {
      createEvents: (invalidate) => new SevenTvEvents(invalidate),
      setTimeout: (callback, delay) => setTimeout(callback, delay),
      clearTimeout: (timer) => clearTimeout(timer),
      now: () => Date.now(),
      ...dependencies,
    };
    this.events = this.dependencies.createEvents(() => this.invalidate());
  }

  start(): void {
    if (this.disposed) return;
    this.stop();
    if (!this.catalog.sevenTvSubscription) return;
    this.active = true;
    this.signature = JSON.stringify(this.catalog.list("7TV"));
    this.events.watch(this.catalog.sevenTvSubscription);
    this.schedulePoll();
  }

  /** Reconcile an external catalog retry without interrupting an in-flight live update. */
  syncCatalog(): void {
    if (!this.active) return;
    const subscription = this.catalog.sevenTvSubscription;
    if (!subscription) { this.stop(); return; }
    this.signature = JSON.stringify(this.catalog.list("7TV"));
    this.events.watch(subscription);
  }

  stop(): void {
    this.generation++;
    this.active = false;
    this.dirty = false;
    this.retryDelay = 30_000;
    if (this.refreshTimer !== null) this.dependencies.clearTimeout(this.refreshTimer);
    if (this.pollTimer !== null) this.dependencies.clearTimeout(this.pollTimer);
    this.refreshTimer = null;
    this.pollTimer = null;
    this.events.disconnect();
  }

  dispose(): void {
    this.stop();
    this.disposed = true;
    this.events.dispose();
  }

  private invalidate(delay = 250): void {
    if (!this.active) return;
    this.dirty = true;
    if (this.fetchingGeneration === this.generation) return;
    const deadline = this.dependencies.now() + delay;
    if (this.refreshTimer !== null) {
      if (this.refreshAt <= deadline) return;
      this.dependencies.clearTimeout(this.refreshTimer);
    }
    this.refreshAt = deadline;
    this.refreshTimer = this.dependencies.setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, delay);
  }

  private async refresh(): Promise<void> {
    if (!this.active) return;
    const generation = this.generation;
    this.dirty = false;
    this.fetchingGeneration = generation;
    let committed = false;
    try {
      committed = await this.catalog.refreshSevenTv();
    } catch {
      // Keep the last good catalog and retry after a transient fetch failure.
    } finally {
      if (this.fetchingGeneration === generation) this.fetchingGeneration = null;
    }
    if (!this.active || generation !== this.generation) return;
    if (committed) {
      const subscription = this.catalog.sevenTvSubscription;
      if (!subscription) { this.stop(); return; }
      this.events.watch(subscription);
      const signature = JSON.stringify(this.catalog.list("7TV"));
      if (signature !== this.signature) {
        this.signature = signature;
        this.onUpdated();
      }
      if (!this.catalog.sevenTvRefreshIncomplete) this.retryDelay = 30_000;
    }
    if (this.dirty) this.invalidate();
    else if (!committed || this.catalog.sevenTvRefreshIncomplete) {
      this.invalidate(this.retryDelay);
      this.retryDelay = Math.min(300_000, this.retryDelay * 2);
    }
  }

  private schedulePoll(): void {
    this.pollTimer = this.dependencies.setTimeout(() => {
      this.pollTimer = null;
      if (!this.active) return;
      this.invalidate();
      this.schedulePoll();
    }, 300_000);
  }
}
