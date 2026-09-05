export interface ChatSuggestionContext {
  query: string;
  range: { start: number; end: number };
  trigger: "colon" | "mention";
}

export function findChatSuggestionContext(value: string, cursor: number): ChatSuggestionContext | null {
  const beforeCursor = value.slice(0, cursor);
  const match = beforeCursor.match(/(^|\s)([:@])([^\s:]*)$/);
  if (!match || Array.from(match[3]).length < 2) return null;
  const suffix = value.slice(cursor).match(/^\S*/)?.[0] ?? "";
  // A closing colon completes the token; it should no longer open suggestions.
  if (match[2] === ":" && suffix.includes(":")) return null;
  return {
    query: match[3],
    range: { start: cursor - match[2].length - match[3].length, end: cursor + suffix.length },
    trigger: match[2] === ":" ? "colon" : "mention",
  };
}

export function normalizeColonEmotes(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  findEmote: (name: string) => { name: string } | undefined,
): { value: string; selectionStart: number; selectionEnd: number } {
  const edits: { start: number; end: number; name: string }[] = [];
  for (const match of value.matchAll(/(^|\s):(\S+):(?=\s|$)/g)) {
    const emote = findEmote(match[2]);
    if (!emote) continue;
    const start = match.index + match[1].length;
    edits.push({ start, end: start + match[2].length + 2, name: emote.name });
  }
  if (!edits.length) return { value, selectionStart, selectionEnd };

  const mapPosition = (position: number): number => {
    let delta = 0;
    for (const edit of edits) {
      if (position <= edit.start) break;
      if (position < edit.end) {
        return edit.start + delta + Math.min(edit.name.length, position - edit.start - 1);
      }
      delta += edit.name.length - (edit.end - edit.start);
    }
    return position + delta;
  };
  // Apply from the end so each edit still uses the original input offsets.
  let normalized = value;
  for (const edit of [...edits].reverse()) {
    normalized = normalized.slice(0, edit.start) + edit.name + normalized.slice(edit.end);
  }
  return {
    value: normalized,
    selectionStart: mapPosition(selectionStart),
    selectionEnd: mapPosition(selectionEnd),
  };
}
