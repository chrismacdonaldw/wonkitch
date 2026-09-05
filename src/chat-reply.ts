import type { ChatReply } from "./chat";

export function createReplyContext(reply: ChatReply): HTMLElement {
  const context = document.createElement("div");
  context.className = "message-reply";

  const arrow = document.createElement("span");
  arrow.className = "message-reply-arrow";
  arrow.setAttribute("aria-hidden", "true");
  arrow.textContent = "↪";

  const label = document.createElement("span");
  label.className = "message-reply-label";
  const name = reply.displayName || reply.login;
  label.textContent = name ? `Replying to @${name}` : "Replying to a user";
  if (reply.login && reply.login !== name) label.title = `@${reply.login}`;

  context.append(arrow, document.createTextNode(" "), label);
  return context;
}
