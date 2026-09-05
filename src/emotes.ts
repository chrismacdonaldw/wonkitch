export interface ThirdPartyEmote {
  name: string;
  url: string;
  previewUrl?: string;
  provider: "TWITCH" | "7TV" | "BTTV" | "FFZ";
  category?: string;
  zeroWidth: boolean;
  overlayX: number;
  overlayY: number;
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

export function getEmotePreviewUrl(
  emote: Pick<ThirdPartyEmote, "url" | "provider" | "previewUrl">,
): string {
  if (emote.previewUrl) return emote.previewUrl;
  if (emote.provider === "TWITCH") {
    return emote.url.replace(/\/[123]\.0(?=\?|$)/, "/3.0");
  }
  if (emote.provider === "BTTV") {
    return emote.url.replace(/\/[123]x(?=\.|\?|$)/, "/3x");
  }
  return emote.url;
}

const globalEmotePromises: Record<
  Exclude<ThirdPartyEmote["provider"], "TWITCH">,
  Promise<ThirdPartyEmote[]> | null
> = {
  FFZ: null,
  BTTV: null,
  "7TV": null,
};

const BTTV_ZERO_WIDTH_EMOTES = new Set([
  "SoSnowy",
  "IceCold",
  "SantaHat",
  "TopHat",
  "ReinDeer",
  "CandyCane",
  "cvMask",
  "cvHazmat",
]);

const BTTV_OVERLAY_OFFSETS: Record<string, [number, number]> = {
  cvMask: [0, 1.5],
  cvHazmat: [0, 1.5],
  SoSnowy: [0, 1],
  IceCold: [0, 1],
};

const FFZ_OVERLAY_OFFSETS: Record<string, [number, number]> = {
  "59847": [-7.5, -7.5],
  "70852": [-2.5, -10],
  "70854": [0, 15],
  "147049": [1, 2],
};

export class EmoteCatalog {
  private emotes = new Map<string, ThirdPartyEmote>();
  private providerEmotes: ThirdPartyEmote[] = [];
  private twitchEmotes = new Map<string, ThirdPartyEmote>();
  private twitchEmoteList: ThirdPartyEmote[] = [];
  private loadGeneration = 0;

  get size(): number {
    return this.combined().size;
  }

  async load(roomId: string, providers: EmoteProviderSettings): Promise<number> {
    const generation = ++this.loadGeneration;
    const [ffzGlobal, bttvGlobal, sevenTvGlobal, ffz, bttv, sevenTv] = await Promise.all([
      providers.ffz ? loadGlobalProvider("FFZ") : [],
      providers.bttv ? loadGlobalProvider("BTTV") : [],
      providers.sevenTv ? loadGlobalProvider("7TV") : [],
      providers.ffz ? loadFfzChannel(roomId) : [],
      providers.bttv ? loadBttvChannel(roomId) : [],
      providers.sevenTv ? loadSevenTvChannel(roomId) : [],
    ]);

    const available = [...ffzGlobal, ...bttvGlobal, ...sevenTvGlobal, ...ffz, ...bttv, ...sevenTv];
    const next = new Map<string, ThirdPartyEmote>();
    for (const emote of available) {
      next.set(emote.name, emote);
    }
    if (generation !== this.loadGeneration) return this.emotes.size;
    this.providerEmotes = [
      ...new Map(available.map((emote) => [`${emote.provider}:${emote.name}`, emote])).values(),
    ];
    this.emotes = next;
    return next.size;
  }

  find(name: string): ThirdPartyEmote | undefined {
    return this.emotes.get(name);
  }

  findAvailable(name: string, includeTwitch = true): ThirdPartyEmote | undefined {
    return (includeTwitch ? this.twitchEmotes.get(name) : undefined) ?? this.find(name);
  }

  setTwitchEmotes(emotes: ThirdPartyEmote[]): void {
    this.twitchEmoteList = [...new Map(emotes.map((emote) => [emote.name, emote])).values()];
    this.twitchEmotes = new Map(emotes.map((emote) => [emote.name, emote]));
  }

  clear(): void {
    this.loadGeneration += 1;
    this.emotes.clear();
    this.providerEmotes = [];
    this.twitchEmotes.clear();
    this.twitchEmoteList = [];
  }

  search(query: string, limit = 8): ThirdPartyEmote[] {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return [];
    return [...this.combined().values()]
      .filter((emote) => emote.name.toLocaleLowerCase().includes(normalized))
      .sort((first, second) => {
        const firstPrefix = first.name.toLocaleLowerCase().startsWith(normalized);
        const secondPrefix = second.name.toLocaleLowerCase().startsWith(normalized);
        if (firstPrefix !== secondPrefix) return firstPrefix ? -1 : 1;
        return first.name.localeCompare(second.name);
      })
      .slice(0, limit);
  }

  list(provider?: ThirdPartyEmote["provider"], query = ""): ThirdPartyEmote[] {
    const normalized = query.trim().toLocaleLowerCase();
    return [...this.providerEmotes, ...this.twitchEmoteList]
      .filter((emote) => !provider || emote.provider === provider)
      .filter((emote) => !normalized || emote.name.toLocaleLowerCase().includes(normalized))
      .sort((first, second) => first.name.localeCompare(second.name));
  }

  private combined(): Map<string, ThirdPartyEmote> {
    return new Map([...this.emotes, ...this.twitchEmotes]);
  }
}

export function appendRichText(
  target: DocumentFragment | HTMLElement,
  text: string,
  nativeEmoteTag: string,
  catalog: EmoteCatalog,
  showNativeEmotes = true,
  gigantifiedEmote = false,
): number {
  const characters = Array.from(text);
  const ranges: NativeRange[] = [];
  if (showNativeEmotes) {
    for (const range of parseNativeRanges(nativeEmoteTag).sort((a, b) => a.start - b.start)) {
      if (range.start <= (ranges.at(-1)?.end ?? -1) || range.end >= characters.length) continue;
      ranges.push(range);
    }
  }
  // Gigantify applies to the final Twitch emote, even when text or provider emotes follow it.
  const largeRange = gigantifiedEmote ? ranges.at(-1) : undefined;
  let cursor = 0;
  let emoteCount = 0;

  for (const range of ranges) {
    if (range.start < cursor || range.start >= characters.length) continue;
    emoteCount += appendCatalogText(
      target,
      characters.slice(cursor, range.start).join(""),
      catalog,
    );
    const label = characters.slice(range.start, range.end + 1).join("");
    const isLarge = range === largeRange;
    appendEmote(
      target,
      createEmoteImage(
        `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(range.id)}/default/dark/${isLarge ? "3.0" : "1.0"}`,
        label,
        "TWITCH",
      ),
      false,
      isLarge,
    );
    emoteCount += 1;
    cursor = range.end + 1;
  }

  emoteCount += appendCatalogText(target, characters.slice(cursor).join(""), catalog);
  return emoteCount;
}

export function appendEmotePreview(
  target: DocumentFragment | HTMLElement,
  text: string,
  catalog: EmoteCatalog,
  includeTwitch = true,
): number {
  return appendCatalogText(target, text, catalog, includeTwitch);
}

function appendCatalogText(
  target: DocumentFragment | HTMLElement,
  text: string,
  catalog: EmoteCatalog,
  includeTwitch = false,
): number {
  let emoteCount = 0;
  for (const token of text.split(/(\s+)/)) {
    if (!token) continue;
    const emote = includeTwitch ? catalog.findAvailable(token) : catalog.find(token);
    if (!emote) {
      target.append(document.createTextNode(token));
      continue;
    }
    appendEmote(
      target,
      createEmoteImage(
        emote.url,
        emote.name,
        emote.provider,
        emote.overlayX,
        emote.overlayY,
        getEmotePreviewUrl(emote),
      ),
      emote.zeroWidth,
    );
    emoteCount += 1;
  }
  return emoteCount;
}

function appendEmote(
  target: DocumentFragment | HTMLElement,
  image: HTMLImageElement,
  zeroWidth: boolean,
  gigantified = false,
): void {
  let previous = target.lastChild;
  while (zeroWidth && previous?.nodeType === Node.TEXT_NODE && !previous.textContent?.trim()) {
    previous = previous.previousSibling;
  }

  if (
    zeroWidth &&
    previous instanceof HTMLElement &&
    previous.classList.contains("emote-stack")
  ) {
    image.classList.add("chat-emote--overlay");
    previous.append(image);
    updateEmoteTooltip(previous);
    return;
  }

  const stack = document.createElement("span");
  stack.className = "emote-stack";
  if (gigantified) stack.classList.add("emote-stack--gigantified");
  stack.append(image);
  updateEmoteTooltip(stack);
  target.append(stack);
}

function updateEmoteTooltip(stack: HTMLElement): void {
  const images = [...stack.querySelectorAll<HTMLImageElement>(".chat-emote")];
  const names = images.map((image) => image.dataset.emoteName || image.alt).filter(Boolean);
  const providers = images.map((image) => image.dataset.emoteProvider).filter(Boolean);
  stack.dataset.tooltipTitle = names.join(" + ");
  const effect = stack.classList.contains("emote-stack--gigantified") ? " · Gigantify" : "";
  stack.dataset.tooltipDescription = `${providers.join(" + ")}${effect}`;
  stack.setAttribute("role", "img");
  stack.setAttribute(
    "aria-label",
    images
      .map((image) => `${image.dataset.emoteName || image.alt} (${image.dataset.emoteProvider})`)
      .join(", ") + effect,
  );
}

function createEmoteImage(
  url: string,
  name: string,
  provider: ThirdPartyEmote["provider"],
  overlayX = 0,
  overlayY = 0,
  previewUrl?: string,
): HTMLImageElement {
  const image = document.createElement("img");
  image.className = "chat-emote";
  image.src = url;
  image.alt = name;
  image.dataset.emoteName = name;
  image.dataset.emoteProvider = provider;
  image.dataset.emotePreviewUrl = previewUrl ?? getEmotePreviewUrl({
    url,
    provider,
  });
  image.style.setProperty("--overlay-x", `${overlayX}px`);
  image.style.setProperty("--overlay-y", `${overlayY}px`);
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
    if (!id) continue;
    for (const range of group.slice(colon + 1).split(",")) {
      if (!/^\d+-\d+$/.test(range)) continue;
      const [start, end] = range.split("-").map(Number);
      if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && end >= start) {
        ranges.push({ id, start, end });
      }
    }
  }
  return ranges;
}

function loadGlobalProvider(
  provider: Exclude<ThirdPartyEmote["provider"], "TWITCH">,
): Promise<ThirdPartyEmote[]> {
  globalEmotePromises[provider] ??= (() => {
    if (provider === "FFZ") {
      return fetchJson("https://api.frankerfacez.com/v1/set/global").then(parseFfzGlobal);
    }
    if (provider === "BTTV") {
      return fetchJson("https://api.betterttv.net/3/cached/emotes/global").then((entries) =>
        parseBttvEmotes(entries, true),
      );
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
    const previewFile = ["4x.webp", "3x.webp", "2x.webp"]
      .map((name) => host.files.find((candidate: any) => candidate.name === name))
      .find(Boolean) ?? file;
    emotes.push({
      name: entry.name,
      url: `${absoluteUrl(host.url)}/${file.name}`,
      previewUrl: `${absoluteUrl(host.url)}/${previewFile.name}`,
      provider: "7TV",
      zeroWidth: Boolean(entry.flags & 1),
      overlayX: 0,
      overlayY: 0,
    });
  }
  return emotes;
}

function parseBttvEmotes(entries: any, includeLegacyZeroWidth = false): ThirdPartyEmote[] {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((entry) => entry?.id && entry?.code && !entry.modifier)
    .map((entry) => {
      const zeroWidth = includeLegacyZeroWidth && BTTV_ZERO_WIDTH_EMOTES.has(entry.code);
      const [overlayX, overlayY] = zeroWidth
        ? (BTTV_OVERLAY_OFFSETS[entry.code] ?? [0, 0])
        : [0, 0];
      return {
        name: entry.code,
        url: `https://cdn.betterttv.net/emote/${entry.id}/1x.webp`,
        provider: "BTTV" as const,
        zeroWidth,
        overlayX,
        overlayY,
      };
    });
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
    .filter(
      (entry: any) =>
        entry?.name && !entry.hidden && (!entry.modifier || !(Number(entry.modifier_flags) & 1)),
    )
    .map((entry: any) => {
      const [overlayX, overlayY] = FFZ_OVERLAY_OFFSETS[String(entry.id)] ?? [0, 0];
      return {
        name: entry.name,
        url: absoluteUrl(entry.urls?.["1"] ?? ""),
        previewUrl: absoluteUrl(entry.urls?.["4"] ?? entry.urls?.["2"] ?? entry.urls?.["1"] ?? ""),
        provider: "FFZ" as const,
        zeroWidth: Boolean(entry.modifier),
        overlayX,
        overlayY,
      };
    })
    .filter((entry: ThirdPartyEmote) => Boolean(entry.url));
}

function absoluteUrl(url: string): string {
  if (!url) return "";
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("http://")) return url.replace("http://", "https://");
  return url;
}
