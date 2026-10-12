function pointerInside(element: HTMLElement, event: PointerEvent): boolean {
  const view = element.ownerDocument.defaultView;
  if (!view || !(event.target instanceof view.Node) || !element.contains(event.target)) return false;
  const rect = element.getBoundingClientRect();
  return event.clientX >= rect.left && event.clientX < rect.right
    && event.clientY >= rect.top && event.clientY < rect.bottom;
}

function listen<T extends Event>(
  target: EventTarget,
  type: string,
  handler: (event: T) => void,
  signal: AbortSignal,
): void {
  target.addEventListener(type, (event) => handler(event as T), { signal, passive: true });
}

export class PlayerControlsVisibility {
  private readonly controller;
  private hovered = false;
  private keyboard = false;
  private pressed = new Set<number>();

  constructor(private readonly stage: HTMLElement, private readonly controls: HTMLElement) {
    const view = stage.ownerDocument.defaultView;
    if (!view) throw new Error("Player controls require a window.");
    this.controller = new view.AbortController();
    const signal = this.controller.signal;
    listen<PointerEvent>(stage, "pointerenter", (event) => {
      if (event.pointerType === "touch") return;
      this.hovered = true;
      this.render();
    }, signal);
    listen(stage, "pointerleave", () => {
      this.hovered = false;
      this.render();
    }, signal);
    listen<PointerEvent>(view, "pointermove", (event) => {
      if (event.pointerType === "touch") return;
      // A release can happen in native UI without a matching pointerup here.
      if (event.buttons === 0) this.pressed.clear();
      this.hovered = pointerInside(stage, event);
      this.render();
    }, signal);
    listen<PointerEvent>(view, "pointerdown", (event) => {
      this.keyboard = false;
      this.hovered = pointerInside(stage, event);
      if (event.target instanceof view.Node && controls.contains(event.target)) {
        this.pressed.add(event.pointerId);
      }
      this.render();
    }, signal);
    listen<PointerEvent>(view, "pointerup", (event) => {
      this.pressed.delete(event.pointerId);
      this.hovered = pointerInside(stage, event);
      this.render();
    }, signal);
    listen<PointerEvent>(view, "lostpointercapture", (event) => {
      if (this.pressed.delete(event.pointerId)) this.hovered = false;
      this.render();
    }, signal);
    listen(view, "pointercancel", () => this.interrupt(), signal);
    listen<PointerEvent>(view, "pointerout", (event) => {
      if (event.relatedTarget) return;
      this.hovered = false;
      this.render();
    }, signal);
    listen<KeyboardEvent>(stage.ownerDocument, "keydown", (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      this.keyboard = true;
      this.render();
    }, signal);
    listen(controls, "focusin", () => this.render(), signal);
    listen(controls, "focusout", () => {
      // focusout fires before activeElement changes to the next control.
      view.queueMicrotask(() => this.render());
    }, signal);
    listen(view, "blur", () => this.interrupt(), signal);
    listen(stage.ownerDocument, "visibilitychange", () => {
      if (stage.ownerDocument.hidden) this.interrupt();
    }, signal);
  }

  interrupt(): void {
    this.hovered = false;
    this.keyboard = false;
    this.pressed.clear();
    this.render();
  }

  dispose(): void {
    this.controller.abort();
    this.interrupt();
  }

  private render(): void {
    const keyboardFocus = this.keyboard && this.controls.contains(this.stage.ownerDocument.activeElement);
    this.stage.classList.toggle("controls-visible", this.hovered || this.pressed.size > 0 || keyboardFocus);
  }
}

interface ChatAutoscrollOptions {
  pauseOnHover(): boolean;
  dismissPreview(): void;
}

export class ChatAutoscroll {
  private readonly view;
  private readonly controller;
  private following = true;
  private hovered = false;
  private preview = false;
  private manualInput = false;
  private manualIntent: "backward" | "forward" | "drag" = "forward";
  private manualStartTop = 0;
  private scrollPointer: number | null = null;
  private inputFrame = 0;
  private resumeFrame = 0;

  constructor(
    private readonly log: HTMLElement,
    private readonly jump: HTMLElement,
    private readonly options: ChatAutoscrollOptions,
  ) {
    const view = log.ownerDocument.defaultView;
    if (!view) throw new Error("Chat autoscroll requires a window.");
    this.view = view;
    this.controller = new view.AbortController();
    const signal = this.controller.signal;
    listen<PointerEvent>(log, "pointerenter", (event) => {
      if (event.pointerType !== "touch") this.hovered = true;
    }, signal);
    listen(log, "pointerleave", () => {
      this.hovered = false;
      this.scheduleResume();
    }, signal);
    const updateHover = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const inside = pointerInside(log, event);
      if (this.hovered && !inside) this.scheduleResume();
      this.hovered = inside;
    };
    listen(view, "pointermove", updateHover, signal);
    listen(view, "pointerdown", updateHover, signal);
    listen<PointerEvent>(view, "pointerout", (event) => {
      if (event.relatedTarget) return;
      this.hovered = false;
      this.scheduleResume();
    }, signal);
    listen<WheelEvent>(log, "wheel", (event) => {
      if (event.deltaY) this.beginManualInput(event.deltaY < 0 ? "backward" : "forward");
    }, signal);
    listen<KeyboardEvent>(log, "keydown", (event) => {
      if (!["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) return;
      if (event.target instanceof view.Element && event.target.closest("button, a, input, select, textarea")) return;
      const backward = ["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey);
      this.beginManualInput(backward ? "backward" : "forward");
    }, signal);
    listen<PointerEvent>(log, "pointerdown", (event) => {
      const rect = log.getBoundingClientRect();
      const scrollbar = event.target === log && event.clientX >= rect.left + log.clientLeft + log.clientWidth;
      if (event.pointerType !== "touch" && !scrollbar) return;
      this.scrollPointer = event.pointerId;
      this.beginManualInput("drag");
    }, signal);
    const finishScroll = (event: PointerEvent) => {
      if (event.pointerId !== this.scrollPointer) return;
      this.scrollPointer = null;
      this.sampleManualInput();
    };
    listen(view, "pointerup", finishScroll, signal);
    listen(view, "lostpointercapture", finishScroll, signal);
    listen(view, "pointercancel", () => this.interrupt(), signal);
    listen(log, "scroll", () => {
      // Browser anchoring, new rows, and resize-induced scrolling are not a
      // request to stop following. Only a user's scroll input can do that.
      if (this.isNearBottom) this.following = true;
      else if (this.scrollPointer !== null && log.scrollTop !== this.manualStartTop) this.following = false;
      this.updateJump();
    }, signal);
    listen(view, "blur", () => this.interrupt(), signal);
    listen(log.ownerDocument, "visibilitychange", () => {
      if (log.ownerDocument.hidden) this.interrupt();
    }, signal);
  }

  get isNearBottom(): boolean {
    return this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 90;
  }

  setPreview(active: boolean): void {
    this.preview = active;
    if (!active) this.scheduleResume();
  }

  flush(): void {
    if (this.following && !this.preview && !this.manualInput && this.scrollPointer === null
      && !(this.hovered && this.options.pauseOnHover())) {
      this.log.scrollTop = this.log.scrollHeight;
    }
    this.updateJump();
  }

  jumpToLive(): void {
    this.following = true;
    this.log.scrollTop = this.log.scrollHeight;
    this.updateJump();
  }

  interrupt(): void {
    if (this.manualInput || this.scrollPointer !== null) this.sampleFollowing();
    this.hovered = false;
    this.preview = false;
    this.manualInput = false;
    this.scrollPointer = null;
    if (this.inputFrame) this.view.cancelAnimationFrame(this.inputFrame);
    this.inputFrame = 0;
    this.scheduleResume();
  }

  reset(): void {
    this.cancelFrames();
    this.following = true;
    this.hovered = false;
    this.preview = false;
    this.manualInput = false;
    this.scrollPointer = null;
    this.jump.classList.remove("visible");
  }

  dispose(): void {
    this.controller.abort();
    this.cancelFrames();
  }

  private beginManualInput(intent: "backward" | "forward" | "drag"): void {
    if (!this.manualInput) this.manualStartTop = this.log.scrollTop;
    this.manualIntent = intent;
    if (intent === "backward" && this.log.scrollTop > 0) this.following = false;
    this.manualInput = true;
    this.options.dismissPreview();
    this.sampleManualInput();
  }

  private sampleManualInput(): void {
    if (this.inputFrame) this.view.cancelAnimationFrame(this.inputFrame);
    this.inputFrame = this.view.requestAnimationFrame(() => {
      this.inputFrame = 0;
      this.sampleFollowing();
      this.manualInput = this.scrollPointer !== null;
      this.flush();
    });
  }

  private scheduleResume(): void {
    if (this.resumeFrame) return;
    // Moving between emotes can produce out/over in the same frame.
    this.resumeFrame = this.view.requestAnimationFrame(() => {
      this.resumeFrame = 0;
      this.flush();
    });
  }

  private updateJump(): void {
    this.jump.classList.toggle("visible", !this.isNearBottom);
  }

  private sampleFollowing(): void {
    if (this.isNearBottom) this.following = true;
    else if (this.manualIntent === "drag" && this.log.scrollTop !== this.manualStartTop) this.following = false;
  }

  private cancelFrames(): void {
    if (this.inputFrame) this.view.cancelAnimationFrame(this.inputFrame);
    if (this.resumeFrame) this.view.cancelAnimationFrame(this.resumeFrame);
    this.inputFrame = 0;
    this.resumeFrame = 0;
  }
}
