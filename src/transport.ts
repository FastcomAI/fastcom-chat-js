import { parseRetryAfter, type FetchLike } from './http.js';

export interface StreamRequest {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal;
}

/**
 * Opens a streaming GET. Calls `onText` with each decoded chunk and resolves
 * once the body ends. A non-2xx response resolves right away with its status,
 * body and `Retry-After` (seconds), without calling `onText`. Rejects on
 * network errors and abort.
 */
export type StreamTransport = (
  req: StreamRequest,
  onText: (chunk: string) => void,
) => Promise<{ status: number; body?: string; retryAfter?: number | null }>;

export function fetchTransport(fetchFn: FetchLike): StreamTransport {
  return async (req, onText) => {
    const res = await fetchFn(req.url, {
      method: 'GET',
      headers: req.headers,
      signal: req.signal,
      cache: 'no-store',
    });
    if (!res.ok || !res.body) {
      return {
        status: res.status,
        body: await res.text().catch(() => ''),
        retryAfter: parseRetryAfter(res.headers.get('retry-after')),
      };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onText(decoder.decode(value, { stream: true }));
    }
    return { status: res.status };
  };
}

/**
 * React Native's `fetch` buffers the whole body, so it can never deliver an
 * open SSE stream. Its XMLHttpRequest does expose `responseText` as it grows.
 */
export const xhrTransport: StreamTransport = (req, onText) =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let seen = 0;
    let failed = false;
    const flush = () => {
      const text = xhr.responseText ?? '';
      if (text.length > seen) {
        onText(text.slice(seen));
        seen = text.length;
      }
    };
    xhr.open('GET', req.url, true);
    for (const [k, v] of Object.entries(req.headers)) xhr.setRequestHeader(k, v);
    xhr.onprogress = () => {
      if (xhr.status >= 200 && xhr.status < 300) flush();
    };
    xhr.onreadystatechange = () => {
      if (xhr.readyState !== 4 || failed) return;
      if (xhr.status === 0) return; // network error or abort; handled below
      if (xhr.status >= 200 && xhr.status < 300) {
        flush();
        resolve({ status: xhr.status });
      } else {
        resolve({
          status: xhr.status,
          body: xhr.responseText,
          retryAfter: parseRetryAfter(xhr.getResponseHeader('Retry-After')),
        });
      }
    };
    const fail = (err: Error) => {
      if (failed) return;
      failed = true;
      reject(err);
    };
    xhr.onerror = () => fail(new Error('Stream network error'));
    xhr.onabort = () => fail(new DOMExceptionLike('Aborted', 'AbortError'));
    req.signal.addEventListener('abort', () => xhr.abort());
    xhr.send();
  });

class DOMExceptionLike extends Error {
  constructor(message: string, name: string) {
    super(message);
    this.name = name;
  }
}

export function isReactNative(): boolean {
  return typeof navigator !== 'undefined' && (navigator as { product?: string }).product === 'ReactNative';
}
