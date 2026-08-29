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

let globalBadgesPromise: Promise<IvrBadgeSet[]> | null = null;

export class BadgeCatalog {
  private badges = new Map<string, BadgeMetadata>();

  async load(roomId: string): Promise<void> {
    globalBadgesPromise ??= fetchBadgeSets("https://api.ivr.fi/v2/twitch/badges/global");
    const [globalSets, channelSets] = await Promise.all([
      globalBadgesPromise,
      fetchBadgeSets(`https://api.ivr.fi/v2/twitch/badges/channel?id=${roomId}`),
    ]);

    const next = new Map<string, BadgeMetadata>();
    for (const set of [...globalSets, ...channelSets]) {
      if (!set.set_id || !Array.isArray(set.versions)) continue;
      for (const version of set.versions) {
        if (!version.id || !version.image_url_1x) continue;
        next.set(`${set.set_id}/${version.id}`, {
          imageUrl: version.image_url_2x || version.image_url_1x,
          title: version.title || humanizeBadgeName(set.set_id),
          description: version.description || "",
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

async function fetchBadgeSets(url: string): Promise<IvrBadgeSet[]> {
  try {
    const response = await fetch(url);
    if (!response.ok) return [];
    const json: unknown = await response.json();
    return Array.isArray(json) ? (json as IvrBadgeSet[]) : [];
  } catch {
    return [];
  }
}
