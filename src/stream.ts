import { ChatApiError } from './http.js';
import { SseParser } from './sse.js';
import type { StreamTransport } from './transport.js';
import type { ConnectedEvent, MessageEvent, RatingEvent, StreamEvent } from './types.js';

export type StreamState = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface StreamHandlers {
  /** Every event, including types this SDK version does not know yet. */
  onEvent?(event: StreamEvent): void;
  onConnected?(event: ConnectedEvent): void;
  /** A reply from the business, bot or human. */
  onMessage?(event: MessageEvent): void;
  /** A rating card was answered; close it on this device too. */
  onRating?(event: RatingEvent): void;
  onStateChange?(state: StreamState): void;
  /** A connection attempt failed. The stream keeps retrying unless the state becomes `closed`. */
  onError?(error: Error): void;
}

export interface StreamOptions {
  /**
   * Reconnect when nothing (not even the 15 s heartbeat) arrives for this long.
   * Catches connections a mobile network dropped without closing. Default 45 s.
   */
  idleTimeoutMs?: number;
  /** Longest wait between reconnect attempts. Default 30 s. */
  maxBackoffMs?: number;
}

interface StreamDeps {
  url: string;
  getToken(forceRefresh: boolean): Promise<string>;
  transport: StreamTransport;
}

/**
 * A self-healing subscription to `/stream`. Starts connecting immediately.
 * Your handlers are never called after `close()`, and a handler that throws
 * is reported to `onError` without stopping the stream.
 */
export class ChatStream {
  private closed = false;
  private abort: AbortController | null = null;
  private wake: (() => void) | null = null;
  private stateValue: StreamState = 'connecting';
  private readonly idleTimeoutMs: number;
  private readonly maxBackoffMs: number;

  constructor(
    private readonly deps: StreamDeps,
    private readonly handlers: StreamHandlers,
    options: StreamOptions,
  ) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? 45_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.run().catch((err) => this.reportError(err));
  }

  get state(): StreamState {
    return this.stateValue;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abort?.abort();
    this.wake?.();
    this.stateValue = 'closed';
    this.callHandler(() => this.handlers.onStateChange?.('closed'));
  }

  private setState(state: StreamState): void {
    if (this.closed || this.stateValue === state) return;
    this.stateValue = state;
    this.callHandler(() => this.handlers.onStateChange?.(state));
  }

  private callHandler(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.reportError(err);
    }
  }

  private reportError(err: unknown): void {
    if (this.closed) return;
    try {
      this.handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
    } catch {
      // A throwing onError must not kill the stream either.
    }
  }

  private async run(): Promise<void> {
    let attempt = 0;
    let forceRefresh = false;
    this.callHandler(() => this.handlers.onStateChange?.('connecting'));

    while (!this.closed) {
      if (attempt > 0) this.setState('reconnecting');
      let minDelayMs = 0;
      try {
        const token = await this.deps.getToken(forceRefresh);
        forceRefresh = false;
        if (this.closed) return;
        const result = await this.openOnce(token, () => {
          attempt = 0;
        });
        if (this.closed) return;
        if (result.status === 404) {
          // The app was deactivated or deleted; retrying cannot help.
          this.reportError(new ChatApiError(404, result.body || 'App not found'));
          this.close();
          return;
        }
        if (result.status === 401) forceRefresh = true;
        if (result.status < 200 || result.status >= 300) {
          throw new ChatApiError(result.status, result.body || `HTTP ${result.status}`, result.retryAfter ?? null);
        }
        // A clean end: the server closes streams on deploy. Reconnect promptly.
      } catch (err) {
        if (this.closed) return;
        // A rate limit (on the stream or on minting its token) says how long to wait.
        if (err instanceof ChatApiError && err.retryAfter) minDelayMs = err.retryAfter * 1000;
        this.reportError(err);
      }
      if (this.closed) return;
      this.setState('reconnecting');
      await this.sleep(Math.max(this.backoff(attempt), minDelayMs));
      attempt += 1;
    }
  }

  private async openOnce(
    token: string,
    onConnected: () => void,
  ): Promise<{ status: number; body?: string; retryAfter?: number | null }> {
    const abort = new AbortController();
    this.abort = abort;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let idledOut = false;
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idledOut = true;
        abort.abort();
      }, this.idleTimeoutMs);
    };

    const parser = new SseParser((data) => {
      if (this.closed) return;
      let event: StreamEvent;
      try {
        event = JSON.parse(data) as StreamEvent;
      } catch {
        return;
      }
      if (event.type === 'connected') {
        onConnected();
        this.setState('open');
      }
      this.dispatch(event);
    });

    resetIdle();
    try {
      return await this.deps.transport(
        {
          url: this.deps.url,
          headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
          signal: abort.signal,
        },
        (chunk) => {
          resetIdle();
          parser.push(chunk);
        },
      );
    } catch (err) {
      if (idledOut) throw new Error(`No data on the stream for ${this.idleTimeoutMs} ms`);
      throw err;
    } finally {
      clearTimeout(idleTimer);
      if (this.abort === abort) this.abort = null;
    }
  }

  private dispatch(event: StreamEvent): void {
    if (this.closed) return;
    this.callHandler(() => this.handlers.onEvent?.(event));
    // onEvent may have called close().
    if (this.closed) return;
    switch (event.type) {
      case 'connected':
        this.callHandler(() => this.handlers.onConnected?.(event));
        break;
      case 'message':
        this.callHandler(() => this.handlers.onMessage?.(event));
        break;
      case 'rating':
        this.callHandler(() => this.handlers.onRating?.(event));
        break;
    }
  }

  /** Exponential backoff from 1 s, capped, with jitter so devices do not reconnect in lockstep. */
  private backoff(attempt: number): number {
    const ceiling = Math.min(this.maxBackoffMs, 1000 * 2 ** attempt);
    return ceiling / 2 + Math.random() * (ceiling / 2);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wake = done;
    }).then(() => {
      this.wake = null;
    });
  }
}
