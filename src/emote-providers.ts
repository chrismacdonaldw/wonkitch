import { fetchChatAssetJson } from "./chat-assets";
import type { EmoteSet, ThirdPartyEmote } from "./emotes";

export type EmoteProvider = Exclude<ThirdPartyEmote["provider"], "TWITCH">;

export type EmoteSource =
  | { provider: EmoteProvider; channel: false; fetch(): Promise<EmoteSet | null> }
  | { provider: EmoteProvider; channel: true; fetch(roomId: string): Promise<EmoteSet | null> };

// Order is precedence: channels override globals, and 7TV channel aliases win name conflicts.
export const EMOTE_SOURCES: readonly EmoteSource[] = [
  { provider: "FFZ", channel: false, fetch: fetchFfzGlobal },
  { provider: "BTTV", channel: false, fetch: fetchBttvGlobal },
  { provider: "7TV", channel: false, fetch: fetchSevenTvGlobal },
  { provider: "FFZ", channel: true, fetch: fetchFfzChannel },
  { provider: "BTTV", channel: true, fetch: fetchBttvChannel },
  { provider: "7TV", channel: true, fetch: fetchSevenTvChannel },
];

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

async function fetchFfzGlobal(): Promise<EmoteSet | null> {
  const json = (await fetchChatAssetJson("https://api.frankerfacez.com/v1/set/global"))?.json;
  if (!Array.isArray(json?.default_sets)) return null;
  return {
    emotes: json.default_sets.flatMap((setId: number | string) => parseFfzSet(json.sets?.[String(setId)])),
  };
}

async function fetchBttvGlobal(): Promise<EmoteSet | null> {
  const json = (await fetchChatAssetJson("https://api.betterttv.net/3/cached/emotes/global"))?.json;
  return Array.isArray(json) ? { emotes: parseBttvEmotes(json, true) } : null;
}

function fetchFfzChannel(roomId: string): Promise<EmoteSet | null> {
  return fetchChannelSet(
    `https://api.frankerfacez.com/v1/room/id/${encodeURIComponent(roomId)}`,
    (json) => ({ emotes: parseFfzSet(json.sets?.[String(json.room?.set)]) }),
  );
}

function fetchBttvChannel(roomId: string): Promise<EmoteSet | null> {
  return fetchChannelSet(
    `https://api.betterttv.net/3/cached/users/twitch/${encodeURIComponent(roomId)}`,
    (json) => ({ emotes: parseBttvEmotes([...(json.channelEmotes ?? []), ...(json.sharedEmotes ?? [])]) }),
  );
}

async function fetchSevenTvGlobal(): Promise<EmoteSet | null> {
  const json = (await fetchChatAssetJson("https://7tv.io/v3/emote-sets/global"))?.json;
  if (!Array.isArray(json?.emotes)) return null;
  return { emotes: parseSevenTvSet(json), watch: { setIds: ids(sevenTvId(json.id)), userId: null } };
}

function fetchSevenTvChannel(roomId: string): Promise<EmoteSet | null> {
  return fetchChannelSet(`https://7tv.io/v3/users/twitch/${encodeURIComponent(roomId)}`, (json) => {
    if (!("emote_set" in json) && !("emote_set_id" in json) && !sevenTvId(json.user?.id)) return null;
    if (json.emote_set && !Array.isArray(json.emote_set.emotes)) return null;
    return {
      emotes: parseSevenTvSet(json.emote_set),
      watch: {
        setIds: ids(sevenTvId(json.emote_set?.id) ?? sevenTvId(json.emote_set_id)),
        // The connection's top-level ID belongs to Twitch, not to the 7TV user.
        userId: sevenTvId(json.user?.id),
      },
    };
  });
}

/** A missing channel account is an authoritative empty set; a malformed body is a failure. */
async function fetchChannelSet(
  url: string,
  parse: (json: Record<string, any>) => EmoteSet | null,
): Promise<EmoteSet | null> {
  const result = await fetchChatAssetJson(url);
  if (!result) return null;
  if (result.status === 404) return { emotes: [] };
  const json = result.json;
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  return parse(json);
}

function sevenTvId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function ids(id: string | null): string[] {
  return id ? [id] : [];
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
  if (typeof url !== "string" || !url) return "";
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("http://")) return url.replace("http://", "https://");
  return url;
}
