export interface ChatAssetJsonResponse {
  status: number;
  json: any;
}

export interface ChatAssetRequest {
  body?: unknown;
  deadlineMs?: number;
}

/** Bound both the connection and response body, even if a transport ignores abort. */
export async function fetchChatAssetJson(
  url: string,
  { body, deadlineMs = 10_000 }: ChatAssetRequest = {},
): Promise<ChatAssetJsonResponse | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, deadlineMs);
  });
  const init: RequestInit = body === undefined
    ? { signal: controller.signal }
    : {
      signal: controller.signal,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    };

  const request = async (): Promise<ChatAssetJsonResponse | null> => {
    try {
      const response = await fetch(url, init);
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

export interface RetainedLoad<T> {
  get(): Promise<T | null>;
  reload(): Promise<T | null>;
}

/** Share one in-flight or successful load; a failure is not an authoritative result and stays retryable. */
export function retainSuccess<T>(load: () => Promise<T | null>): RetainedLoad<T> {
  let cached: Promise<T | null> | null = null;
  const attempt = () => load().catch(() => null);
  return {
    get() {
      if (!cached) {
        const promise = attempt();
        cached = promise;
        void promise.then((value) => {
          if (value === null && cached === promise) cached = null;
        });
      }
      return cached;
    },
    async reload() {
      const value = await attempt();
      if (value !== null) cached = Promise.resolve(value);
      return value;
    },
  };
}
