import { ChatApiError, chatUrl, parseJson, resolveFetch, toError, type FetchLike } from './http.js';
import { ChatStream, type StreamHandlers, type StreamOptions } from './stream.js';
import { TokenCache, type TokenProvider } from './token.js';
import { fetchTransport, isReactNative, xhrTransport, type StreamTransport } from './transport.js';
import type {
  AppConfig,
  PendingRatingCard,
  SendableMessageType,
  SendMessageResult,
  SessionToken,
  SubmitRatingResult,
  UploadResult,
} from './types.js';

export interface ChatClientOptions {
  /** Your deployment's base URL, e.g. `https://your-domain.com/app`. */
  baseUrl: string;
  /**
   * Recommended: fetches a session token from your backend, which mints it
   * with the secret key for the signed-in user.
   */
  tokenProvider?: TokenProvider;
  /**
   * Low-trust alternative to `tokenProvider`, for apps with no backend: mints
   * tokens with the publishable key. Must be enabled on the app card, and
   * these sessions cannot upload media.
   */
  publishableKey?: string;
  /** Required with `publishableKey`: your stable id for this end user. */
  endUserId?: string;
  /** Optional with `publishableKey`: the name shown in the inbox. */
  endUserName?: string;
  /** Custom fetch, e.g. for tests or a proxy. Defaults to the global one. */
  fetch?: FetchLike;
  /**
   * How `/stream` is read. Defaults to XMLHttpRequest on React Native (whose
   * fetch cannot stream) and fetch everywhere else.
   */
  streamTransport?: StreamTransport;
}

/** A file to upload: a Blob/File, or React Native's `{ uri, name, type }`. */
export type UploadFile = Blob | { uri: string; name: string; type: string };

/** The end-user side of the Mobile Chat API: send messages, receive replies. */
export class ChatClient {
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly tokens: TokenCache;
  private readonly transport: StreamTransport;

  constructor(options: ChatClientOptions) {
    if (!options.baseUrl) throw new Error('baseUrl is required');
    this.baseUrl = options.baseUrl;
    this.fetchFn = resolveFetch(options.fetch);
    this.transport =
      options.streamTransport ?? (isReactNative() ? xhrTransport : fetchTransport(this.fetchFn));

    if (options.tokenProvider) {
      this.tokens = new TokenCache(options.tokenProvider);
    } else if (options.publishableKey) {
      const { publishableKey, endUserId, endUserName } = options;
      assertPublishableKey(publishableKey);
      if (!endUserId) throw new Error('endUserId is required with publishableKey');
      this.tokens = new TokenCache(() => this.mintWithPublishableKey(publishableKey, endUserId, endUserName));
    } else {
      throw new Error('Pass either tokenProvider or publishableKey');
    }
  }

  /** Sends a text message, or a media URL returned by `upload()`. */
  async sendMessage(content: string, messageType: SendableMessageType = 'TEXT'): Promise<SendMessageResult> {
    const res = await this.authed('/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, messageType }),
    });
    return parseJson<SendMessageResult>(res);
  }

  /** Uploads an image, audio clip or PDF. Requires a server-minted token. */
  async upload(file: UploadFile, filename?: string): Promise<UploadResult> {
    const form = new FormData();
    if (filename !== undefined && file instanceof Blob) form.append('file', file, filename);
    else form.append('file', file as Blob);
    const res = await this.authed('/upload', { method: 'POST', body: form });
    return parseJson<UploadResult>(res);
  }

  /** Uploads a file and sends it as a message in one call. */
  async sendMedia(file: UploadFile, filename?: string): Promise<SendMessageResult> {
    const uploaded = await this.upload(file, filename);
    return this.sendMessage(uploaded.url, uploaded.messageType);
  }

  async getConfig(): Promise<AppConfig> {
    return parseJson<AppConfig>(await this.authed('/config', { method: 'GET' }));
  }

  /** The newest unanswered rating card, for showing one the stream delivered while the app was closed. */
  async getPendingRating(): Promise<PendingRatingCard | null> {
    const body = await parseJson<{ pending: PendingRatingCard | null }>(
      await this.authed('/rating', { method: 'GET' }),
    );
    return body.pending;
  }

  async submitRating(input: { messageId: string; score: number; comment?: string }): Promise<SubmitRatingResult> {
    const res = await this.authed('/rating', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    return parseJson<SubmitRatingResult>(res);
  }

  /**
   * Opens the reply stream. It reconnects on its own, with a fresh token when
   * needed, until you call `close()` on the returned stream.
   */
  connect(handlers: StreamHandlers, options: StreamOptions = {}): ChatStream {
    return new ChatStream(
      {
        url: chatUrl(this.baseUrl, '/stream'),
        getToken: (force) => this.tokens.get(force),
        transport: this.transport,
      },
      handlers,
      options,
    );
  }

  /** Drops the cached token, e.g. when the user signs out. */
  clearSession(): void {
    this.tokens.clear();
  }

  /** Sends with the session token; on 401 refreshes it once and retries. */
  private async authed(path: string, init: RequestInit): Promise<Response> {
    const send = async (force: boolean) => {
      const token = await this.tokens.get(force);
      return this.fetchFn(chatUrl(this.baseUrl, path), {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` },
      });
    };
    const res = await send(false);
    if (res.status !== 401) return res;
    return send(true);
  }

  private async mintWithPublishableKey(key: string, endUserId: string, endUserName?: string): Promise<SessionToken> {
    const res = await this.fetchFn(chatUrl(this.baseUrl, '/token'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ endUserId, endUserName }),
    });
    if (!res.ok) throw await toError(res);
    return (await res.json()) as SessionToken;
  }
}

/**
 * The server would happily mint a full-trust token from a secret key, so this
 * mistake would work and ship the secret key inside the app. Refuse it here.
 * The message never echoes the key.
 */
function assertPublishableKey(key: string): void {
  if (key.startsWith('pk_')) return;
  if (key.startsWith('sk_')) {
    throw new Error(
      'publishableKey is a secret key (sk_...). Never put a secret key in an app: mint tokens on your backend and pass tokenProvider instead.',
    );
  }
  throw new Error('publishableKey must start with pk_');
}

export { ChatApiError };
