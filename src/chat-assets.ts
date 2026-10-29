export interface ChatAssetJsonResponse {
  status: number;
  json: any;
}

/** Bound both the connection and response body, even if a transport ignores abort. */
export async function fetchChatAssetJson(
  url: string,
  deadlineMs = 10_000,
): Promise<ChatAssetJsonResponse | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, deadlineMs);
  });

  const request = async (): Promise<ChatAssetJsonResponse | null> => {
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (response.status === 404) return { status: 404, json: null };
      if (!response.ok) return null;
      return { status: response.status, json: await response.json() };
    } catch {
      return null;
    }
  };

  try {
    return await Promise.race([request(), deadline]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
