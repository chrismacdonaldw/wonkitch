import type { ChatMessage, ChatReply } from "./chat";

export interface ReplyContextOptions {
  parent?: ChatMessage | null;
  deleted?: boolean;
  showDeleted?: boolean;
  previewUnavailable?: boolean;
  onOpen?: () => void;
  renderMessage?: (container: HTMLElement, message: ChatMessage) => void;
}

export function createReplyContext(reply: ChatReply, options: ReplyContextOptions = {}): HTMLElement {
  const context = document.createElement(options.onOpen ? "button" : "div");
  context.className = "message-reply";
  context.dataset.parentMessageId = reply.messageId;
  if (context.tagName === "BUTTON") {
    (context as HTMLButtonElement).type = "button";
    context.title = "View reply thread";
    context.addEventListener("click", options.onOpen!);
  }

  const arrow = document.createElement("span");
  arrow.className = "message-reply-arrow";
  arrow.setAttribute("aria-hidden", "true");
  arrow.textContent = "↪";

  const label = document.createElement("span");
  label.className = "message-reply-label";
  const name = options.parent?.displayName || options.parent?.login || reply.displayName || reply.login;
  label.textContent = name ? `Replying to @${name}` : "Replying to a user";
  if (reply.login && reply.login !== name) label.title = `@${reply.login}`;

  const preview = document.createElement("span");
  preview.className = "message-reply-preview";
  // Only content already retained locally may be shown after deletion.
  const showDeleted = Boolean(options.deleted && options.showDeleted && options.parent
    && !options.previewUnavailable);
  if (options.deleted && !showDeleted) {
    preview.textContent = "Message deleted";
    preview.classList.add("message-reply-preview--unavailable");
  } else if (options.previewUnavailable) {
    preview.textContent = "Message unavailable";
    preview.classList.add("message-reply-preview--unavailable");
  } else if (options.parent) {
    if (options.renderMessage) options.renderMessage(preview, options.parent);
    else preview.textContent = options.parent.text;
  } else if (reply.body) {
    preview.textContent = reply.body;
  } else {
    preview.textContent = "Earlier message unavailable";
    preview.classList.add("message-reply-preview--unavailable");
  }

  context.append(arrow, document.createTextNode(" "), label, document.createTextNode(" · "), preview);
  if (showDeleted) {
    preview.classList.add("message-reply-preview--deleted");
    const deleted = document.createElement("small");
    deleted.className = "message-reply-deleted-label";
    deleted.textContent = "Deleted";
    context.append(deleted);
  }
  if (options.onOpen) {
    context.setAttribute("aria-label", name ? `Open reply thread with @${name}` : "Open reply thread");
    const description = showDeleted ? `${options.parent!.text} (deleted)`
      : options.deleted || options.previewUnavailable
      ? preview.textContent
      : options.parent?.text || reply.body || preview.textContent;
    context.setAttribute("aria-description", description || "Earlier message unavailable");
  }
  return context;
}
