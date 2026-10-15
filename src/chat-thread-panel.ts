import type { ChatThreadEntry, ChatThreadStore } from "./chat-thread";
import { ChatAutoscroll } from "./interactions";

interface ThreadPanelOptions {
  renderEntry(entry: ChatThreadEntry): HTMLElement | null;
  onClose(restoreFocus: boolean): void;
}

export class ChatThreadPanel {
  private activeId = "";
  private rootId = "";
  private signature = "";
  private rows = new Map<string, { signature: string; row: HTMLElement | null }>();
  private trigger: HTMLElement | null = null;
  private readonly log: HTMLElement;
  private readonly count: HTMLElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly autoscroll: ChatAutoscroll;
  private readonly controller;

  constructor(
    private readonly panel: HTMLElement,
    private readonly store: ChatThreadStore,
    private readonly options: ThreadPanelOptions,
  ) {
    const view = panel.ownerDocument.defaultView!;
    this.controller = new view.AbortController();
    this.log = panel.querySelector<HTMLElement>(".thread-log")!;
    this.count = panel.querySelector<HTMLElement>(".thread-count")!;
    this.closeButton = panel.querySelector<HTMLButtonElement>(".thread-close")!;
    this.autoscroll = new ChatAutoscroll(this.log, null, {
      pauseOnHover: () => false,
      dismissPreview: () => {},
    });
    this.closeButton.addEventListener("click", () => this.close(), { signal: this.controller.signal });
    panel.ownerDocument.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !this.isOpen || event.defaultPrevented) return;
      // Let an open modal or emote picker handle its own Escape first.
      if (panel.ownerDocument.querySelector("dialog[open], #emote-picker:not([hidden])")) return;
      event.preventDefault();
      this.close();
    }, { signal: this.controller.signal });
  }

  get isOpen(): boolean { return !this.panel.hidden; }

  open(messageId: string, trigger?: HTMLElement): boolean {
    const thread = this.store.getThread(messageId);
    if (!thread) return false;
    this.activeId = messageId;
    this.rootId = thread.rootId;
    this.trigger = trigger ?? null;
    this.panel.hidden = false;
    this.panel.parentElement?.classList.add("thread-open");
    this.autoscroll.reset(false);
    this.log.scrollTop = 0;
    this.refresh(true);
    this.log.scrollTop = 0;
    this.autoscroll.reset(this.log.scrollHeight <= this.log.clientHeight);
    this.closeButton.focus();
    return true;
  }

  refresh(force = false): void {
    if (!this.isOpen) return;
    const thread = this.store.getThread(this.activeId) ?? this.store.getThread(this.rootId);
    if (thread) this.rootId = thread.rootId;
    const signature = JSON.stringify(thread);
    if (!force && signature === this.signature) return;
    const previousTop = this.log.scrollTop;
    const active = this.panel.ownerDocument.activeElement as HTMLElement | null;
    const focusedId = active?.closest<HTMLElement>("[data-message-id]")?.dataset.messageId;
    const focusedControl = active?.matches(".message-reply") ? "preview"
      : active?.matches(".thread-reply-action") ? "reply"
      : active?.matches(".filter-reveal") ? "reveal"
      : active?.matches("a[data-gif-url]") ? "gif" : null;
    const focusedGifUrl = active?.dataset.gifUrl;
    this.signature = signature;
    const rows: HTMLElement[] = [];
    const retainedRows = new Map<string, { signature: string; row: HTMLElement | null }>();
    for (const entry of thread?.entries ?? []) {
      const entrySignature = JSON.stringify({ entry,
        parent: entry.parentId ? this.store.get(entry.parentId) : null,
        parentDeleted: entry.parentId ? this.store.isDeleted(entry.parentId) : false });
      const previous = this.rows.get(entry.id);
      const row = !force && previous?.signature === entrySignature ? previous.row : this.options.renderEntry(entry);
      retainedRows.set(entry.id, { signature: entrySignature, row });
      if (row) rows.push(row);
    }
    this.rows = retainedRows;
    if (!rows.length) {
      const empty = this.panel.ownerDocument.createElement("p");
      empty.className = "thread-empty";
      empty.textContent = "Messages in this thread are unavailable or hidden by your filters.";
      rows.push(empty);
    }
    const total = thread?.entries.filter((entry) => entry.message !== null && retainedRows.get(entry.id)?.row).length ?? 0;
    this.count.textContent = total === 1 ? "1 message" : `${total} messages`;
    this.log.replaceChildren(...rows);
    this.log.scrollTop = previousTop;
    this.autoscroll.flush();
    if (focusedId && focusedControl) {
      const row = rows.find((item) => item.dataset.messageId === focusedId);
      const control = focusedControl === "gif"
        ? [...row?.querySelectorAll<HTMLElement>("a[data-gif-url]") ?? []].find((link) => link.dataset.gifUrl === focusedGifUrl)
        : row?.querySelector<HTMLElement>(focusedControl === "preview" ? ".message-reply"
          : focusedControl === "reveal" && row.querySelector(".filter-reveal") ? ".filter-reveal" : ".thread-reply-action");
      (control ?? this.log).focus({ preventScroll: true });
    }
  }

  interrupt(): void {
    this.autoscroll.interrupt();
  }

  close(restoreFocus = true): void {
    const wasOpen = this.isOpen;
    this.panel.hidden = true;
    this.panel.parentElement?.classList.remove("thread-open");
    this.activeId = "";
    this.rootId = "";
    this.signature = "";
    this.rows.clear();
    this.autoscroll.reset();
    this.log.replaceChildren();
    if (wasOpen) this.options.onClose(restoreFocus);
    if (restoreFocus && this.trigger?.isConnected) this.trigger.focus({ preventScroll: true });
    this.trigger = null;
  }

  dispose(): void {
    this.close(false);
    this.autoscroll.dispose();
    this.controller.abort();
  }
}
