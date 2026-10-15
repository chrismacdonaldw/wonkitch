import type { ChatConnectionState } from "./chat";

interface ChatConnectionElements {
  status: HTMLElement;
  dot: HTMLElement;
  banner: HTMLElement;
  message: HTMLElement;
  retry: HTMLButtonElement;
  focusTarget: () => HTMLElement;
}

const statusLabels: Record<ChatConnectionState, string> = {
  connecting: "connecting",
  connected: "connected",
  reconnecting: "reconnecting",
  waiting: "waiting",
  offline: "offline",
};

const connectionMessages: Partial<Record<ChatConnectionState, string>> = {
  connecting: "Connecting to chat…",
  reconnecting: "Reconnecting to chat…",
  waiting: "Waiting for internet…",
};

/** Keeps connection feedback outside the delayed message stream. */
export class ChatConnectionStatus {
  constructor(
    private readonly elements: ChatConnectionElements,
    private readonly onRetry: () => void,
  ) {
    elements.retry.addEventListener("click", this.retry);
  }

  update(state: ChatConnectionState): void {
    const { status, dot, banner, message, retry, focusTarget } = this.elements;
    const description = connectionMessages[state];
    const visible = description !== undefined;

    status.textContent = statusLabels[state];
    status.title = description ?? (state === "connected" ? "Chat connected" : "Chat offline");
    status.parentElement?.setAttribute("data-state", state);
    dot.classList.toggle("active", state === "connected");
    banner.dataset.state = state;

    if (!visible && retry.ownerDocument.activeElement === retry) {
      focusTarget().focus({ preventScroll: true });
    }
    banner.hidden = !visible;
    if (message.textContent !== (description ?? "")) {
      message.textContent = description ?? "";
    }
  }

  dispose(): void {
    this.elements.retry.removeEventListener("click", this.retry);
  }

  private readonly retry = (): void => {
    if (!this.elements.banner.hidden) this.onRetry();
  };
}
