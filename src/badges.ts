import { fetchChatAssetJson } from "./chat-assets";

export interface BadgeMetadata {
  imageUrl: string;
  title: string;
  description: string;
}

interface IvrBadgeVersion {
  id: string;
  image_url_1x: string;
  image_url_2x: string;
  title: string;
  description: string;
}

interface IvrBadgeSet {
  set_id: string;
  versions: IvrBadgeVersion[];
}

let globalBadgesPromise: Promise<IvrBadgeSet[] | null> | null = null;

export class BadgeCatalog {
  private badges = new Map<string, BadgeMetadata>();
  private globalSets: IvrBadgeSet[] = [];
  private channelSets: IvrBadgeSet[] = [];
  private roomId: string | null = null;
  private generation = 0;
  private globalFailed = false;
  private channelFailed = false;

  get loadIncomplete(): boolean {
    return this.globalFailed || this.channelFailed;
  }

  async load(roomId: string, onUpdated: () => void = () => {}): Promise<void> {
    const generation = ++this.generation;
    if (roomId !== this.roomId) {
      this.roomId = roomId;
      this.channelSets = [];
      this.globalFailed = false;
      this.channelFailed = false;
      this.rebuild();
    }
    const commit = (scope: "globalSets" | "channelSets", sets: IvrBadgeSet[] | null): void => {
      if (generation !== this.generation) return;
      if (scope === "globalSets") this.globalFailed = sets === null;
      else this.channelFailed = sets === null;
      if (!sets) return;
      this[scope] = sets;
      this.rebuild();
      onUpdated();
    };
    await Promise.all([
      loadGlobalBadges().then((sets) => commit("globalSets", sets)),
      fetchBadgeSets(`https://api.ivr.fi/v2/twitch/badges/channel?id=${encodeURIComponent(roomId)}`, true)
        .then((sets) => commit("channelSets", sets)),
    ]);
  }

  clear(): void {
    this.generation++;
    this.roomId = null;
    this.globalSets = [];
    this.channelSets = [];
    this.globalFailed = false;
    this.channelFailed = false;
    this.badges.clear();
  }

  private rebuild(): void {
    const next = new Map<string, BadgeMetadata>();
    for (const set of [...this.globalSets, ...this.channelSets]) {
      if (!set || typeof set.set_id !== "string" || !set.set_id || !Array.isArray(set.versions)) continue;
      for (const version of set.versions) {
        if (!version || typeof version.id !== "string" || !version.id ||
          typeof version.image_url_1x !== "string" || !version.image_url_1x) continue;
        next.set(`${set.set_id}/${version.id}`, {
          imageUrl: typeof version.image_url_2x === "string" && version.image_url_2x || version.image_url_1x,
          title: typeof version.title === "string" && version.title || humanizeBadgeName(set.set_id),
          description: typeof version.description === "string" && version.description || "",
        });
      }
    }
    this.badges = next;
  }

  find(key: string): BadgeMetadata | undefined {
    return this.badges.get(key);
  }
}

export function humanizeBadgeName(name: string): string {
  return name
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function loadGlobalBadges(): Promise<IvrBadgeSet[] | null> {
  if (!globalBadgesPromise) {
    const promise = fetchBadgeSets("https://api.ivr.fi/v2/twitch/badges/global");
    globalBadgesPromise = promise;
    void promise.then((sets) => {
      if (!sets && globalBadgesPromise === promise) globalBadgesPromise = null;
    });
  }
  return globalBadgesPromise;
}

async function fetchBadgeSets(url: string, missingIsEmpty = false): Promise<IvrBadgeSet[] | null> {
  const response = await fetchChatAssetJson(url);
  if (missingIsEmpty && response?.status === 404) return [];
  return Array.isArray(response?.json) ? response.json as IvrBadgeSet[] : null;
}
