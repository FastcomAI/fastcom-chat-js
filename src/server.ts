import { chatUrl, parseJson, resolveFetch, type FetchLike } from './http.js';
import { isReactNative } from './transport.js';
import type {
  BotState,
  SendableMessageType,
  SendMessageResult,
  SessionToken,
  ThreadPage,
} from './types.js';

export interface ChatServerOptions {
  /** Your deployment's base URL, e.g. `https://your-domain.com/app`. */
  baseUrl: string;
  /** The app's `sk_live_…` key. Server-side only. */
  secretKey: string;
  fetch?: FetchLike;
  /**
   * Skip the server-runtime check. Only for a trusted environment the check
   * does not recognise, such as an internal admin tool or an unusual edge runtime.
   */
  dangerouslyAllowBrowser?: boolean;
}

/**
 * Node, Deno, Bun, Vercel/Next.js Edge and Cloudflare Workers. Anything with
 * a `document`, and React Native, is a client however it looks otherwise.
 */
function isServerRuntime(): boolean {
  if (typeof document !== 'undefined' || isReactNative()) return false;
  const g = globalThis as {
    process?: { versions?: { node?: string } };
    Deno?: unknown;
    Bun?: unknown;
    EdgeRuntime?: unknown;
    navigator?: { userAgent?: string };
  };
  return Boolean(
    g.process?.versions?.node ||
      g.Deno ||
      g.Bun ||
      typeof g.EdgeRuntime === 'string' ||
      g.navigator?.userAgent === 'Cloudflare-Workers',
  );
}

/**
 * The secret-key side of the Mobile Chat API, for your backend: mint session
 * tokens for signed-in users, and read or reply to threads (the Agent API).
 *
 * Fields are `#private` so the secret key never shows up in `console.log` or
 * `JSON.stringify` of this object.
 */
export class ChatServer {
  readonly #baseUrl: string;
  readonly #secretKey: string;
  readonly #fetchFn: FetchLike;

  constructor(options: ChatServerOptions) {
    if (!options.baseUrl) throw new Error('baseUrl is required');
    if (!options.secretKey) throw new Error('secretKey is required');
    if (!options.dangerouslyAllowBrowser && !isServerRuntime()) {
      throw new Error(
        'ChatServer holds your secret key and only runs on a server. In a browser or app, use ChatClient with a tokenProvider.',
      );
    }
    this.#baseUrl = options.baseUrl;
    this.#secretKey = options.secretKey;
    this.#fetchFn = resolveFetch(options.fetch);
  }

  /**
   * Mints a 30-minute session token for one end user. Return the result as-is
   * from your endpoint; the app's `tokenProvider` accepts it directly.
   */
  mintToken(input: { endUserId: string; endUserName?: string }): Promise<SessionToken> {
    return this.#post<SessionToken>('/token', input);
  }

  /** Replies to an end user as the business. They must have written first (404 otherwise). */
  reply(input: { endUserId: string; content: string; messageType?: SendableMessageType }): Promise<SendMessageResult> {
    return this.#post<SendMessageResult>('/agent/reply', input);
  }

  /**
   * One page of thread history, newest first. To page back, pass the oldest
   * `createdAt` you have as `before`.
   */
  getMessages(input: { endUserId: string; limit?: number; before?: string | Date }): Promise<ThreadPage> {
    const params = new URLSearchParams({ endUserId: input.endUserId });
    if (input.limit !== undefined) params.set('limit', String(input.limit));
    if (input.before !== undefined) {
      params.set('before', input.before instanceof Date ? input.before.toISOString() : input.before);
    }
    return this.#get<ThreadPage>(`/agent/messages?${params}`);
  }

  /** Whether the AI agent answers this end user's conversation. */
  getBotEnabled(endUserId: string): Promise<BotState> {
    return this.#get<BotState>(`/agent/bot?${new URLSearchParams({ endUserId })}`);
  }

  /** Mutes (`false`) or restores (`true`) the AI agent for one conversation, e.g. on a human takeover. */
  setBotEnabled(endUserId: string, enabled: boolean): Promise<BotState> {
    return this.#post<BotState>('/agent/bot', { endUserId, enabled });
  }

  async #get<T>(path: string): Promise<T> {
    const res = await this.#fetchFn(chatUrl(this.#baseUrl, path), {
      headers: { Authorization: `Bearer ${this.#secretKey}` },
    });
    return parseJson<T>(res);
  }

  async #post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.#fetchFn(chatUrl(this.#baseUrl, path), {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.#secretKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return parseJson<T>(res);
  }
}
