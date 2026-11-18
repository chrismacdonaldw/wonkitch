import { appendTwitchGif, parseTwitchGifRanges, type TwitchGifRange } from "./chat-gif";
import { retainSuccess, type RetainedLoad } from "./chat-assets";
import { EMOTE_SOURCES, type EmoteProvider, type EmoteSource } from "./emote-providers";
import type { SevenTvSubscription } from "./seventv-events";

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

export interface EmoteSet {
  emotes: ThirdPartyEmote[];
  /** 7TV object IDs whose events invalidate this set. */
  watch?: SevenTvSubscription;
}

export type RefreshOutcome = "complete" | "partial" | "failed";

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

const PROVIDER_SETTINGS: Record<EmoteProvider, keyof EmoteProviderSettings> = {
  FFZ: "ffz",
  BTTV: "bttv",
  "7TV": "sevenTv",
};

type SourceOutcome = "committed" | "failed" | "discarded";

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

// Module scope, so every catalog in a session shares one successful global load per source.
const sharedGlobals = new Map<EmoteSource, RetainedLoad<EmoteSet>>();

function requestSet(source: EmoteSource, roomId: string, fresh: boolean): Promise<EmoteSet | null> {
  if (source.channel) return source.fetch(roomId).catch(() => null);
  let shared = sharedGlobals.get(source);
  if (!shared) sharedGlobals.set(source, shared = retainSuccess(source.fetch));
  return fresh ? shared.reload() : shared.get();
}

export class EmoteCatalog {
  private emotes = new Map<string, ThirdPartyEmote>();
  private providerEmotes: ThirdPartyEmote[] = [];
  private twitchEmotes = new Map<string, ThirdPartyEmote>();
  private twitchEmoteList: ThirdPartyEmote[] = [];
  private room: { id: string; providers: EmoteProviderSettings } | null = null;
  private sets = new Map<EmoteSource, EmoteSet>();
  private failed = new Set<EmoteSource>();
  private requests = new Map<EmoteSource, symbol>();

  get size(): number {
    return this.combined().size;
  }

  get sevenTvSubscription(): SevenTvSubscription | null {
    if (!this.room?.providers.sevenTv) return null;
    const setIds = new Set<string>();
    let userId: string | null = null;
    for (const source of EMOTE_SOURCES) {
      const watch = this.sets.get(source)?.watch;
      if (!watch) continue;
      for (const id of watch.setIds) setIds.add(id);
      userId = watch.userId ?? userId;
    }
    return { setIds: [...setIds], userId };
  }

  get loadIncomplete(): boolean {
    return this.failed.size > 0;
  }

  async load(roomId: string, providers: EmoteProviderSettings, onUpdated?: () => void): Promise<number> {
    const sameRoom = this.room?.id === roomId;
    this.room = { id: roomId, providers: { ...providers } };
    this.requests.clear();
    this.failed.clear();
    for (const source of EMOTE_SOURCES) {
      if (!this.enabled(source) || (source.channel && !sameRoom)) this.sets.delete(source);
    }
    this.rebuildProviders();
    await this.fetchSources(EMOTE_SOURCES.filter((source) => this.enabled(source)), false, onUpdated);
    return this.emotes.size;
  }

  /** Retry failed sources, leaving any source with a newer request (such as a live refresh) in flight. */
  async retryFailed(onUpdated?: () => void): Promise<void> {
    await this.fetchSources([...this.failed].filter((source) => !this.requests.has(source)), false, onUpdated);
  }

  /** Refetch one provider's sets, bypassing shared global caches to recover changes missed while disconnected. */
  async refresh(provider: EmoteProvider): Promise<RefreshOutcome> {
    const sources = EMOTE_SOURCES.filter((source) => source.provider === provider && this.enabled(source));
    const outcomes = await this.fetchSources(sources, true);
    const committed = outcomes.filter((outcome) => outcome === "committed").length;
    if (committed === 0) return "failed";
    return committed === sources.length ? "complete" : "partial";
  }

  private enabled(source: EmoteSource): boolean {
    return Boolean(this.room?.providers[PROVIDER_SETTINGS[source.provider]]);
  }

  /** Commit each source as it arrives, so a slow provider never hides another. The latest request per source wins. */
  private fetchSources(
    sources: readonly EmoteSource[],
    fresh: boolean,
    onUpdated?: () => void,
  ): Promise<SourceOutcome[]> {
    const roomId = this.room?.id;
    if (roomId === undefined) return Promise.resolve([]);
    return Promise.all(sources.map(async (source): Promise<SourceOutcome> => {
      const token = Symbol(source.provider);
      this.requests.set(source, token);
      const set = await requestSet(source, roomId, fresh);
      if (this.requests.get(source) !== token) return "discarded";
      this.requests.delete(source);
      if (!set) {
        this.failed.add(source);
        return "failed";
      }
      this.failed.delete(source);
      this.sets.set(source, set);
      this.rebuildProviders();
      onUpdated?.();
      return "committed";
    }));
  }

  private rebuildProviders(): void {
    const available = EMOTE_SOURCES.flatMap((source) => this.sets.get(source)?.emotes ?? []);
    this.providerEmotes = [
      ...new Map(available.map((emote) => [`${emote.provider}:${emote.name}`, emote])).values(),
    ];
    this.emotes = new Map(available.map((emote) => [emote.name, emote]));
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
    this.room = null;
    this.sets.clear();
    this.failed.clear();
    this.requests.clear();
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
  gifTag = "",
): number {
  const characters = Array.from(text);
  const ranges: ({ kind: "emote"; range: NativeRange } | { kind: "gif"; range: TwitchGifRange })[] = [];
  const candidates = [
    ...(showNativeEmotes ? parseNativeRanges(nativeEmoteTag) : [])
      .map((range) => ({ kind: "emote" as const, range })),
    ...parseTwitchGifRanges(gifTag, characters.length).map((range) => ({ kind: "gif" as const, range })),
  ].sort((a, b) => a.range.start - b.range.start);
  for (const candidate of candidates) {
    const { range } = candidate;
    if (range.start <= (ranges.at(-1)?.range.end ?? -1) || range.end >= characters.length) continue;
    ranges.push(candidate);
  }
  // Gigantify applies to the final Twitch emote, even when text or provider emotes follow it.
  const largeRange = showNativeEmotes && gigantifiedEmote
    ? ranges.filter((candidate) => candidate.kind === "emote").at(-1)
    : undefined;
  let cursor = 0;
  let emoteCount = 0;

  for (const candidate of ranges) {
    const { range } = candidate;
    if (range.start < cursor || range.start >= characters.length) continue;
    emoteCount += appendCatalogText(
      target,
      characters.slice(cursor, range.start).join(""),
      catalog,
    );
    const label = characters.slice(range.start, range.end + 1).join("");
    if (candidate.kind === "gif") {
      appendTwitchGif(target, range, label);
      cursor = range.end + 1;
      continue;
    }
    const isLarge = candidate === largeRange;
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
