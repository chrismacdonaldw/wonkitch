export interface TwitchGifRange {
  id: string;
  start: number;
  end: number;
}

// Twitch sends Unicode code-point ranges as "start-end|GIPHY ID|source URL".
export function parseTwitchGifRanges(tag: string, characterCount: number): TwitchGifRange[] {
  const ranges: TwitchGifRange[] = [];
  for (const entry of tag.split(",")) {
    const match = /^(\d+)-(\d+)\|([a-zA-Z0-9]{1,128})\|(.+)$/.exec(entry);
    if (!match || !isGiphySource(match[4])) continue;
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (
      Number.isSafeInteger(start) && Number.isSafeInteger(end) &&
      start <= end && end < characterCount
    ) {
      ranges.push({ id: match[3], start, end });
    }
  }
  return ranges;
}

export function appendTwitchGif(
  target: DocumentFragment | HTMLElement,
  range: TwitchGifRange,
  originalText: string,
): void {
  const id = encodeURIComponent(range.id);
  const link = document.createElement("a");
  link.className = "chat-gif";
  link.href = `https://i.giphy.com/${id}.webp`;
  link.dataset.gifUrl = link.href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.setAttribute("aria-label", `${originalText} (Twitch GIF, powered by GIPHY)`);

  const image = document.createElement("img");
  image.className = "chat-gif__image";
  // Construct known CDN URLs instead of loading the untrusted URL in the IRC tag.
  image.src = `https://media4.giphy.com/media/${id}/100.webp`;
  image.srcset = `https://media4.giphy.com/media/${id}/200.webp 2x`;
  image.alt = "";
  image.setAttribute("aria-hidden", "true");
  image.referrerPolicy = "no-referrer";
  image.loading = "lazy";
  image.decoding = "async";
  image.addEventListener("error", () => {
    image.remove();
    link.classList.add("chat-gif--failed");
  }, { once: true });

  // Retain the original token for selection, copying, and failed image loads.
  const label = document.createElement("span");
  label.className = "chat-gif__label";
  label.textContent = originalText;
  link.append(image, label);
  target.append(link);
}

function isGiphySource(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      /^(?:media\d*|i)\.giphy\.com$/.test(url.hostname);
  } catch {
    return false;
  }
}
