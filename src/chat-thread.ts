import type { ChatMessage, ChatReply } from "./chat";

export interface ChatThreadEntry {
  id: string;
  parentId: string | null;
  message: ChatMessage | null;
  login: string;
  displayName: string;
  text: string | null;
  isMissing: boolean;
  isDeleted: boolean;
}

export interface ChatThreadSnapshot {
  rootId: string;
  entries: ChatThreadEntry[];
}

interface RetainedMessage {
  message: ChatMessage | null;
  reply: ChatReply | null;
  login: string;
  displayName: string;
  deleted: boolean;
}

interface OrderedEntry {
  entry: ChatThreadEntry;
  timestamp: number;
  order: number;
}

function copyMessage(message: ChatMessage): ChatMessage {
  return { ...message, badges: [...message.badges], reply: message.reply ? { ...message.reply } : null };
}

/** Retain released messages only; clear whenever the channel or playback context changes. */
export class ChatThreadStore {
  private readonly messages = new Map<string, RetainedMessage>();
  private maximum = 1000;

  constructor(maximum = 1000) {
    this.limit(maximum);
  }

  get size(): number {
    return this.messages.size;
  }

  add(message: ChatMessage): void {
    if (!message.id || message.isNotice || this.messages.get(message.id)?.deleted) return;
    const saved = copyMessage(message);
    if (saved.reply && this.isDeleted(saved.reply.messageId)) delete saved.reply.body;
    this.messages.set(message.id, {
      message: saved,
      reply: saved.reply,
      login: saved.login,
      displayName: saved.displayName,
      deleted: false,
    });
    this.trim();
  }

  get(messageId: string): ChatMessage | null {
    const message = this.messages.get(messageId)?.message;
    return message ? copyMessage(message) : null;
  }

  values(): ChatMessage[] {
    return [...this.messages.values()].flatMap(({ message }) => message ? [copyMessage(message)] : []);
  }

  isDeleted(messageId: string): boolean {
    return this.messages.get(messageId)?.deleted ?? false;
  }

  /** Keep a bounded tombstone so reply tags cannot reveal a deleted parent's text. */
  remove(messageId: string): void {
    if (!messageId) return;
    const retained = this.messages.get(messageId);
    this.messages.set(messageId, {
      message: null,
      reply: retained?.reply ?? null,
      login: retained?.login ?? "",
      displayName: retained?.displayName ?? "",
      deleted: true,
    });
    for (const child of this.messages.values()) {
      if (child.reply?.messageId === messageId) delete child.reply.body;
    }
    this.trim();
  }

  clear(): void {
    this.messages.clear();
  }

  limit(maximum: number): void {
    this.maximum = Number.isFinite(maximum) ? Math.max(1, Math.min(5000, Math.floor(maximum))) : 1000;
    this.trim();
  }

  getThread(messageId: string): ChatThreadSnapshot | null {
    if (!messageId) return null;
    const roots = this.threadRoots();
    const selectedRoot = roots.get(messageId) ?? messageId;
    const members: Array<[string, RetainedMessage]> = [];
    let referenced = false;
    for (const [id, retained] of this.messages) {
      if ((roots.get(id) ?? id) === selectedRoot) members.push([id, retained]);
      if (retained.reply?.messageId === messageId || retained.reply?.threadRootMessageId === messageId) referenced = true;
    }
    if (!members.length || (!this.messages.has(messageId) && !referenced)) return null;

    const entries = new Map<string, OrderedEntry>();
    let order = 0;
    for (const [id, retained] of members) {
      const message = retained.message;
      entries.set(id, {
        entry: {
          id,
          parentId: retained.reply?.messageId || null,
          message: message ? copyMessage(message) : null,
          login: retained.login,
          displayName: retained.displayName,
          text: message?.text ?? null,
          isMissing: false,
          isDeleted: retained.deleted,
        },
        timestamp: message?.timestamp ?? 0,
        order: order++,
      });
    }

    const ensureMissing = (id: string, parentId: string | null, login: string, displayName: string, text: string | null, timestamp: number) => {
      if (!id) return;
      const existing = entries.get(id);
      if (existing) {
        if (existing.entry.isMissing || existing.entry.isDeleted) {
          existing.entry.login ||= login;
          existing.entry.displayName ||= displayName;
          if (!existing.entry.isDeleted) existing.entry.text ??= text;
          existing.entry.parentId ??= parentId;
        }
        return;
      }
      const deleted = this.messages.get(id)?.deleted ?? false;
      entries.set(id, {
        entry: { id, parentId, message: null, login, displayName, text: deleted ? null : text, isMissing: !deleted, isDeleted: deleted },
        timestamp: timestamp - 0.5,
        order: order++,
      });
    };

    for (const [, retained] of members) {
      const reply = retained.reply;
      if (!reply) continue;
      const timestamp = retained.message?.timestamp ?? 0;
      ensureMissing(reply.messageId, reply.messageId === selectedRoot ? null : selectedRoot,
        reply.login, reply.displayName, reply.body ?? null, timestamp);
      if (reply.threadRootMessageId) {
        ensureMissing(reply.threadRootMessageId, reply.threadRootMessageId === selectedRoot ? null : selectedRoot,
          reply.threadRootLogin ?? "", reply.threadRootDisplayName ?? reply.threadRootLogin ?? "", null, timestamp);
      }
    }
    ensureMissing(selectedRoot, null, "", "", null, 0);

    const sorted = [...entries.values()].sort((left, right) => {
      if (left.entry.id === selectedRoot) return -1;
      if (right.entry.id === selectedRoot) return 1;
      return left.timestamp - right.timestamp || left.order - right.order;
    });
    return { rootId: selectedRoot, entries: sorted.map(({ entry }) => entry) };
  }

  private threadRoots(): Map<string, string> {
    const parents = new Map<string, string>();
    for (const [id, retained] of this.messages) {
      const reply = retained.reply;
      const parent = reply?.threadRootMessageId || reply?.messageId;
      if (parent && parent !== id) parents.set(id, parent);
    }
    for (const retained of this.messages.values()) {
      const reply = retained.reply;
      if (reply?.threadRootMessageId && reply.threadRootMessageId !== reply.messageId
        && !this.messages.get(reply.messageId)?.message && !parents.has(reply.messageId)) {
        parents.set(reply.messageId, reply.threadRootMessageId);
      }
    }

    const roots = new Map<string, string>();
    const ids = new Set([...this.messages.keys(), ...parents.keys(), ...parents.values()]);
    for (const id of ids) {
      const visited: string[] = [];
      const seen = new Set<string>();
      let current = id;
      while (parents.has(current) && !roots.has(current) && !seen.has(current)) {
        visited.push(current);
        seen.add(current);
        current = parents.get(current)!;
      }
      const cycle = visited.indexOf(current);
      const root = cycle >= 0 ? visited.slice(cycle).sort()[0] : roots.get(current) ?? current;
      roots.set(current, root);
      for (const ancestor of visited) roots.set(ancestor, root);
    }
    return roots;
  }

  private trim(): void {
    while (this.messages.size > this.maximum) {
      const first = this.messages.keys().next().value;
      if (first === undefined) break;
      this.messages.delete(first);
    }
  }
}
