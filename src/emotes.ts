export interface ThirdPartyEmote {
  name: string;
  url: string;
  provider: "7TV" | "BTTV" | "FFZ";
  zeroWidth: boolean;
}

interface NativeRange {
  id: string;
  start: number;
  end: number;
}

export interface EmoteProviderSettings {
  ffz: boolean;
  bttv: boolean;
  sevenTv: boolean;
}

const globalEmotePromises: Record<ThirdPartyEmote["provider"], Promise<ThirdPartyEmote[]> | null> = {
  FFZ: null,
  BTTV: null,
  "7TV": null,
};

export class EmoteCatalog {
  private emotes = new Map<string, ThirdPartyEmote>();

  get size(): number {
    return this.emotes.size;
  }

  async load(roomId: string, providers: EmoteProviderSettings): Promise<number> {
    const [ffzGlobal, bttvGlobal, sevenTvGlobal, ffz, bttv, sevenTv] = await Promise.all([
      providers.ffz ? loadGlobalProvider("FFZ") : [],
      providers.bttv ? loadGlobalProvider("BTTV") : [],
      providers.sevenTv ? loadGlobalProvider("7TV") : [],
      providers.ffz ? loadFfzChannel(roomId) : [],
      providers.bttv ? loadBttvChannel(roomId) : [],
      providers.sevenTv ? loadSevenTvChannel(roomId) : [],
    ]);

    const next = new Map<string, ThirdPartyEmote>();
    for (const emote of [...ffzGlobal, ...bttvGlobal, ...sevenTvGlobal, ...ffz, ...bttv, ...sevenTv]) {
      next.set(emote.name, emote);
    }
    this.emotes = next;
    return next.size;
  }

  find(name: string): ThirdPartyEmote | undefined {
    return this.emotes.get(name);
  }

  search(query: string, limit = 8): ThirdPartyEmote[] {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return [];
    return [...this.emotes.values()]
      .filter((emote) => emote.name.toLocaleLowerCase().includes(normalized))
      .sort((first, second) => {
        const firstPrefix = first.name.toLocaleLowerCase().startsWith(normalized);
        const secondPrefix = second.name.toLocaleLowerCase().startsWith(normalized);
        if (firstPrefix !== secondPrefix) return firstPrefix ? -1 : 1;
        return first.name.localeCompare(second.name);
      })
      .slice(0, limit);
  }
}

export function appendRichText(
  target: DocumentFragment | HTMLElement,
  text: string,
  nativeEmoteTag: string,
  catalog: EmoteCatalog,
  showNativeEmotes = true,
): void {
  const characters = Array.from(text);
  const ranges = showNativeEmotes
    ? parseNativeRanges(nativeEmoteTag).sort((a, b) => a.start - b.start)
    : [];
  let cursor = 0;

  for (const range of ranges) {
    if (range.start < cursor || range.start >= characters.length) continue;
    appendThirdPartyText(target, characters.slice(cursor, range.start).join(""), catalog);
    const label = characters.slice(range.start, range.end + 1).join("");
    appendEmote(
      target,
      createEmoteImage(
        `https://static-cdn.jtvnw.net/emoticons/v2/${range.id}/default/dark/1.0`,
        label,
        "TWITCH",
      ),
      false,
    );
    cursor = range.end + 1;
  }

  appendThirdPartyText(target, characters.slice(cursor).join(""), catalog);
}

function appendThirdPartyText(
  target: DocumentFragment | HTMLElement,
  text: string,
  catalog: EmoteCatalog,
): void {
  for (const token of text.split(/(\s+)/)) {
    if (!token) continue;
    const emote = catalog.find(token);
    if (!emote) {
      target.append(document.createTextNode(token));
      continue;
    }
    appendEmote(
      target,
      createEmoteImage(emote.url, emote.name, emote.provider),
      emote.zeroWidth,
    );
  }
}

function appendEmote(
  target: DocumentFragment | HTMLElement,
  image: HTMLImageElement,
  zeroWidth: boolean,
): void {
  let previous = target.lastChild;
  if (zeroWidth && previous?.nodeType === Node.TEXT_NODE && !previous.textContent?.trim()) {
    previous = previous.previousSibling;
  }

  if (
    zeroWidth &&
    previous instanceof HTMLElement &&
    previous.classList.contains("emote-stack")
  ) {
    image.classList.add("chat-emote--overlay");
    previous.append(image);
    return;
  }

  const stack = document.createElement("span");
  stack.className = "emote-stack";
  stack.append(image);
  target.append(stack);
}

function createEmoteImage(url: string, name: string, provider: string): HTMLImageElement {
  const image = document.createElement("img");
  image.className = "chat-emote";
  image.src = url;
  image.alt = name;
  image.title = `${name} · ${provider}`;
  image.loading = "lazy";
  image.decoding = "async";
  return image;
}

function parseNativeRanges(tag: string): NativeRange[] {
  const ranges: NativeRange[] = [];
  for (const group of tag.split("/")) {
    if (!group) continue;
    const colon = group.indexOf(":");
    if (colon < 0) continue;
    const id = group.slice(0, colon);
    for (const range of group.slice(colon + 1).split(",")) {
      const [start, end] = range.split("-").map(Number);
      if (Number.isInteger(start) && Number.isInteger(end)) {
        ranges.push({ id, start, end });
      }
    }
  }
  return ranges;
}

function loadGlobalProvider(provider: ThirdPartyEmote["provider"]): Promise<ThirdPartyEmote[]> {
  globalEmotePromises[provider] ??= (() => {
    if (provider === "FFZ") {
      return fetchJson("https://api.frankerfacez.com/v1/set/global").then(parseFfzGlobal);
    }
    if (provider === "BTTV") {
      return fetchJson("https://api.betterttv.net/3/cached/emotes/global").then(parseBttvEmotes);
    }
    return fetchJson("https://7tv.io/v3/emote-sets/global").then(parseSevenTvSet);
  })();
  return globalEmotePromises[provider];
}

async function loadSevenTvChannel(roomId: string): Promise<ThirdPartyEmote[]> {
  const json = await fetchJson(`https://7tv.io/v3/users/twitch/${roomId}`);
  return parseSevenTvSet(json?.emote_set);
}

async function loadBttvChannel(roomId: string): Promise<ThirdPartyEmote[]> {
  const json = await fetchJson(`https://api.betterttv.net/3/cached/users/twitch/${roomId}`);
  return parseBttvEmotes([...(json?.channelEmotes ?? []), ...(json?.sharedEmotes ?? [])]);
}

async function loadFfzChannel(roomId: string): Promise<ThirdPartyEmote[]> {
  const json = await fetchJson(`https://api.frankerfacez.com/v1/room/id/${roomId}`);
  const setId = json?.room?.set;
  return parseFfzSet(json?.sets?.[String(setId)]);
}

async function fetchJson(url: string): Promise<any> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function parseSevenTvSet(set: any): ThirdPartyEmote[] {
  if (!Array.isArray(set?.emotes)) return [];
  const emotes: ThirdPartyEmote[] = [];
  for (const entry of set.emotes) {
    const host = entry?.data?.host;
    if (!entry?.name || !host?.url || !Array.isArray(host.files)) continue;
    const file =
      host.files.find((candidate: any) => candidate.name === "1x.webp") ??
      host.files.find((candidate: any) => candidate.format === "WEBP") ??
      host.files[0];
    if (!file?.name) continue;
    emotes.push({
      name: entry.name,
      url: `${absoluteUrl(host.url)}/${file.name}`,
      provider: "7TV",
      zeroWidth: Boolean(entry.flags & 1),
    });
  }
  return emotes;
}

function parseBttvEmotes(entries: any): ThirdPartyEmote[] {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((entry) => entry?.id && entry?.code && !entry.modifier)
    .map((entry) => ({
      name: entry.code,
      url: `https://cdn.betterttv.net/emote/${entry.id}/1x.webp`,
      provider: "BTTV" as const,
      zeroWidth: false,
    }));
}

function parseFfzGlobal(json: any): ThirdPartyEmote[] {
  if (!Array.isArray(json?.default_sets)) return [];
  return json.default_sets.flatMap((setId: number | string) =>
    parseFfzSet(json?.sets?.[String(setId)]),
  );
}

function parseFfzSet(set: any): ThirdPartyEmote[] {
  if (!Array.isArray(set?.emoticons)) return [];
  return set.emoticons
    .filter((entry: any) => entry?.name && !entry.hidden && !entry.modifier)
    .map((entry: any) => ({
      name: entry.name,
      url: absoluteUrl(entry.urls?.["1"] ?? ""),
      provider: "FFZ" as const,
      zeroWidth: false,
    }))
    .filter((entry: ThirdPartyEmote) => Boolean(entry.url));
}

function absoluteUrl(url: string): string {
  if (!url) return "";
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("http://")) return url.replace("http://", "https://");
  return url;
}
