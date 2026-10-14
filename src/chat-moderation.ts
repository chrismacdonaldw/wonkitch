import type { ChatMessage } from "./chat";
import type { ChatThreadStore } from "./chat-thread";

/** Apply only when this notice is released by the video-synchronized chat clock. */
export function applyChatModeration(
  notice: ChatMessage,
  messages: Map<string, ChatMessage>,
  pending: ChatMessage[],
  threads: ChatThreadStore,
  selectedReply: ChatMessage | null = null,
): { pending: ChatMessage[]; deletedIds: Set<string> } {
  const moderation = notice.moderation;
  const deletedIds = new Set<string>();
  if (!moderation) return { pending, deletedIds };
  if (moderation.messageId) deletedIds.add(moderation.messageId);
  const matchesUser = (login: string, userId?: string) =>
    Boolean(moderation.userId && userId === moderation.userId)
    || Boolean(moderation.login && login.toLowerCase() === moderation.login.toLowerCase());
  const removeMessage = (message: ChatMessage) => !message.isNotice && (
    moderation.messageId ? message.id === moderation.messageId
      : message.timestamp <= notice.timestamp && (moderation.clearAll || matchesUser(message.login, message.userId))
  );
  const retained = new Map<string, ChatMessage>();
  for (const message of [...threads.values(), ...messages.values(), ...pending, ...(selectedReply ? [selectedReply] : [])]) {
    retained.set(message.id, message);
  }
  for (const message of retained.values()) {
    if (removeMessage(message)) deletedIds.add(message.id);
    const reply = message.reply;
    if (!reply || message.timestamp > notice.timestamp || moderation.messageId) continue;
    if (moderation.clearAll || matchesUser(reply.login, reply.userId)) deletedIds.add(reply.messageId);
    if (reply.threadRootMessageId && (moderation.clearAll || matchesUser(reply.threadRootLogin ?? "", reply.threadRootUserId))) {
      deletedIds.add(reply.threadRootMessageId);
    }
  }
  for (const id of deletedIds) {
    threads.remove(id);
    messages.delete(id);
  }
  for (const message of [...messages.values(), ...pending]) {
    if (message.reply && deletedIds.has(message.reply.messageId)) delete message.reply.body;
  }
  if (moderation.clearAll) {
    for (const [id, message] of messages) {
      if (message.isNotice && message.timestamp <= notice.timestamp) messages.delete(id);
    }
  }
  return { pending: pending.filter((message) => !deletedIds.has(message.id)
    && !(moderation.clearAll && message.timestamp <= notice.timestamp)), deletedIds };
}
