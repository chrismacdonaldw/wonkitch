export const SEVENTV_GQL = "https://7tv.io/v4/gql";
export const SEVENTV_GLOBAL = "SevenTvGlobal";

export function sevenTvChannel(twitchId) {
  return `SevenTvChannel:${twitchId}`;
}

/** Key a fake fetch by URL, or for 7TV GraphQL by operation name and variables. */
export function requestKey(url, init = {}) {
  if (url !== SEVENTV_GQL) return url;
  const { operationName, variables } = JSON.parse(init.body);
  return [operationName, ...Object.values(variables)].join(":");
}

export function sevenTvItem(alias, id = alias, { zeroWidth = false, scales = [1, 4], name = `Original_${alias}` } = {}) {
  return {
    alias,
    flags: { zeroWidth },
    emote: {
      defaultName: name,
      images: scales.map((scale) => ({
        url: `https://cdn.example/${id}/${scale}x.webp`, mime: "image/webp", scale, frameCount: 1,
      })),
    },
  };
}

export function sevenTvSet(id, items, pageCount = 1) {
  return { id, emotes: { pageCount, items } };
}

export function sevenTvGlobalData(set) {
  return { data: { emoteSets: { global: set } } };
}

export function sevenTvChannelData(set, userId = "seventv-user") {
  return { data: { users: { userByConnection: { id: userId, style: { activeEmoteSet: set } } } } };
}

export const SEVENTV_NO_ACCOUNT = { data: { users: { userByConnection: null } } };

const gambaImage = (file, mime, scale, frameCount) => ({
  url: `https://cdn.7tv.app/emote/01G3WEGZN0000ET2J0MQP5YJ0G/${file}`, mime, scale, frameCount,
});
const hmmImage = (file, mime, scale) => ({
  url: `https://cdn.7tv.app/emote/01F6MA6Y100002B6P5MWZ5D916/${file}`, mime, scale, frameCount: 1,
});

/** Real V4 items trimmed to scales 1 and 4. GAMBA keeps 7TV's order; Hmm lists WebP after the other formats. */
export const GAMBA_ITEM = {
  alias: "GAMBA",
  flags: { zeroWidth: false },
  emote: { images: [
    gambaImage("1x_static.webp", "image/webp", 1, 1),
    gambaImage("1x_static.png", "image/png", 1, 1),
    gambaImage("1x_static.avif", "image/avif", 1, 1),
    gambaImage("1x.webp", "image/webp", 1, 102),
    gambaImage("1x.gif", "image/gif", 1, 105),
    gambaImage("4x_static.avif", "image/avif", 4, 1),
    gambaImage("1x.avif", "image/avif", 1, 105),
    gambaImage("4x_static.png", "image/png", 4, 1),
    gambaImage("4x.gif", "image/gif", 4, 105),
    gambaImage("4x_static.webp", "image/webp", 4, 1),
    gambaImage("4x.webp", "image/webp", 4, 105),
    gambaImage("4x.avif", "image/avif", 4, 105),
  ] },
};

export const HMM_ITEM = {
  alias: "Hmm",
  flags: { zeroWidth: false },
  emote: { images: [
    hmmImage("1x.avif", "image/avif", 1),
    hmmImage("1x.png", "image/png", 1),
    hmmImage("4x.png", "image/png", 4),
    hmmImage("1x.webp", "image/webp", 1),
    hmmImage("4x.avif", "image/avif", 4),
    hmmImage("4x.webp", "image/webp", 4),
  ] },
};
