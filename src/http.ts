export type FetchLike = typeof fetch;

/** Any non-2xx response from the API. */
export class ChatApiError extends Error {
  readonly status: number;
  /** Seconds to wait before retrying, from `Retry-After` on a 429. */
  readonly retryAfter: number | null;
  /** Set on a 429 from an app-wide cap: `newUsersPerHour`, `messagesPerHour` or `messagesPerDay`. */
  readonly limit: string | null;

  constructor(status: number, message: string, retryAfter: number | null = null, limit: string | null = null) {
    super(message);
    this.name = 'ChatApiError';
    this.status = status;
    this.retryAfter = retryAfter;
    this.limit = limit;
  }
}

/** Joins `https://host/app` (with or without a trailing slash) and `/token`. */
export function chatUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/v1/chat${path}`;
}

export function resolveFetch(custom?: FetchLike): FetchLike {
  if (custom) return custom;
  if (typeof fetch !== 'function') {
    throw new Error('No global fetch found. Pass `fetch` in the options.');
  }
  // Unbound `fetch` throws "Illegal invocation" in some browsers.
  return fetch.bind(globalThis);
}

/** `Retry-After` in seconds, or null when absent or not a number. */
export function parseRetryAfter(header: string | null | undefined): number | null {
  if (header === null || header === undefined || header.trim() === '') return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

export async function toError(res: Response): Promise<ChatApiError> {
  const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
  let message = `HTTP ${res.status}`;
  let limit: string | null = null;
  // The stream route answers errors in plain text, the rest in `{ error }`.
  const text = await res.text().catch(() => '');
  if (text) {
    try {
      const body = JSON.parse(text) as { error?: unknown; limit?: unknown };
      if (typeof body.error === 'string') message = body.error;
      if (typeof body.limit === 'string') limit = body.limit;
    } catch {
      message = text;
    }
  }
  return new ChatApiError(res.status, message, retryAfter, limit);
}

export async function parseJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw await toError(res);
  return (await res.json()) as T;
}
