import { fetchChatAssetJson } from "./chat-assets";
import type { EmoteSet, ThirdPartyEmote } from "./emotes";

const ENDPOINT = "https://7tv.io/v4/gql";
// V4 answers took 4 to 26 seconds regardless of payload size.
const DEADLINE_MS = 30_000;

const SET_FIELDS = `
fragment SetFields on EmoteSet {
  id
  emotes {
    pageCount
    items { alias flags { zeroWidth } emote { images { url mime scale frameCount } } }
  }
}`;

const GLOBAL_QUERY = `
query SevenTvGlobal {
  emoteSets { global { ...SetFields } }
}${SET_FIELDS}`;

const CHANNEL_QUERY = `
query SevenTvChannel($id: String!) {
  users {
    userByConnection(platform: TWITCH, platformId: $id) {
      id
      style { activeEmoteSet { ...SetFields } }
    }
  }
}${SET_FIELDS}`;

interface Image {
  url: string;
  mime: string;
  scale: number;
  frameCount: number;
}

let warnedPaging = false;

export async function fetchSevenTvGlobal(): Promise<EmoteSet | null> {
  const set = parseSet((await query("SevenTvGlobal", GLOBAL_QUERY, {}))?.emoteSets?.global);
  return set && { emotes: set.emotes, watch: { setIds: set.setIds, userId: null } };
}

export async function fetchSevenTvChannel(twitchId: string): Promise<EmoteSet | null> {
  const users = (await query("SevenTvChannel", CHANNEL_QUERY, { id: twitchId }))?.users;
  if (!users || !("userByConnection" in users)) return null;
  const user = users.userByConnection;
  if (user === null) return { emotes: [], watch: { setIds: [], userId: null } };
  const userId = sevenTvId(user?.id);
  if (!userId) return null;
  const active = user.style?.activeEmoteSet;
  if (active == null) return { emotes: [], watch: { setIds: [], userId } };
  const set = parseSet(active);
  return set && { emotes: set.emotes, watch: { setIds: set.setIds, userId } };
}

async function query(
  operationName: string,
  document: string,
  variables: Record<string, string>,
): Promise<Record<string, any> | null> {
  const result = await fetchChatAssetJson(ENDPOINT, {
    body: { operationName, query: document, variables },
    deadlineMs: DEADLINE_MS,
  });
  const json = result?.json;
  if (!isObject(json) || "errors" in json || !isObject(json.data)) return null;
  return json.data;
}

function parseSet(set: any): { setIds: string[]; emotes: ThirdPartyEmote[] } | null {
  const items = set?.emotes?.items;
  if (!Array.isArray(items)) return null;
  if (set.emotes.pageCount > 1 && !warnedPaging) {
    warnedPaging = true;
    console.warn(`7TV emote set ${set.id} has ${set.emotes.pageCount} pages; only the first was loaded.`);
  }
  const id = sevenTvId(set.id);
  return { setIds: id ? [id] : [], emotes: items.flatMap(parseEmote) };
}

function parseEmote(item: any): ThirdPartyEmote[] {
  const name = item?.alias;
  const images = item?.emote?.images;
  if (typeof name !== "string" || !name || !Array.isArray(images)) return [];
  const bestByScale = new Map<number, Image>();
  for (const image of images.filter(isImage).sort(preferred)) {
    if (!bestByScale.has(image.scale)) bestByScale.set(image.scale, image);
  }
  const best = [...bestByScale.values()].sort((first, second) => first.scale - second.scale);
  if (!best.length) return [];
  return [{
    name,
    url: best[0].url,
    previewUrl: best[best.length - 1].url,
    provider: "7TV",
    zeroWidth: Boolean(item.flags?.zeroWidth),
    overlayX: 0,
    overlayY: 0,
  }];
}

/** Within a scale, WebP first, then the most frames, so an animated emote never renders its static variant. */
function preferred(first: Image, second: Image): number {
  return Number(second.mime === "image/webp") - Number(first.mime === "image/webp")
    || second.frameCount - first.frameCount;
}

function isImage(value: any): value is Image {
  return typeof value?.url === "string" && value.url.length > 0
    && typeof value.mime === "string"
    && Number.isInteger(value.scale) && value.scale > 0
    && typeof value.frameCount === "number";
}

function isObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sevenTvId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
