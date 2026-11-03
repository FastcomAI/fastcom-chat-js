export type TokenProviderResult = string | { token: string; expiresIn?: number };

/**
 * Returns a fresh session token. Usually calls your backend, which mints one
 * with the secret key. Returning `{ token, expiresIn }` (the `/token` response
 * as-is) lets the SDK refresh before expiry; a bare string is refreshed on 401.
 */
export type TokenProvider = () => Promise<TokenProviderResult>;

/**
 * Caches the session token and makes concurrent callers share one refresh.
 * Fields are `#private` so the token never shows up in `console.log` or
 * `JSON.stringify` of an SDK object.
 */
export class TokenCache {
  readonly #provider: TokenProvider;
  readonly #now: () => number;
  #token: string | null = null;
  /** Epoch ms after which the token is treated as stale; null = unknown. */
  #refreshAt: number | null = null;
  #inflight: Promise<string> | null = null;
  /** Bumped by clear(), so a refresh that started before it is thrown away. */
  #generation = 0;

  constructor(provider: TokenProvider, now: () => number = Date.now) {
    this.#provider = provider;
    this.#now = now;
  }

  get(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.#token && (this.#refreshAt === null || this.#now() < this.#refreshAt)) {
      return Promise.resolve(this.#token);
    }
    if (this.#inflight) return this.#inflight;

    const generation = this.#generation;
    const inflight: Promise<string> = this.#provider()
      .then((result) => {
        // clear() ran while this was in flight (a sign-out): the result may
        // belong to the previous user, so fetch again instead of keeping it.
        if (generation !== this.#generation) return this.get();
        const token = typeof result === 'string' ? result : result.token;
        if (!token) throw new Error('Token provider returned an empty token');
        const expiresIn = typeof result === 'string' ? undefined : result.expiresIn;
        this.#token = token;
        // Refresh a minute early (or halfway, for very short tokens) so a
        // request never leaves with a token that expires in flight.
        this.#refreshAt = expiresIn
          ? this.#now() + expiresIn * 1000 - Math.min(60_000, (expiresIn * 1000) / 2)
          : null;
        return token;
      })
      .finally(() => {
        if (this.#inflight === inflight) this.#inflight = null;
      });
    this.#inflight = inflight;
    return inflight;
  }

  clear(): void {
    this.#generation += 1;
    this.#token = null;
    this.#refreshAt = null;
    this.#inflight = null;
  }
}
