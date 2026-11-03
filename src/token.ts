export type TokenProviderResult = string | { token: string; expiresIn?: number };

/**
 * Returns a fresh session token. Usually calls your backend, which mints one
 * with the secret key. Returning `{ token, expiresIn }` (the `/token` response
 * as-is) lets the SDK refresh before expiry; a bare string is refreshed on 401.
 */
export type TokenProvider = () => Promise<TokenProviderResult>;

/** Caches the session token and makes concurrent callers share one refresh. */
export class TokenCache {
  private token: string | null = null;
  /** Epoch ms after which the token is treated as stale; null = unknown. */
  private refreshAt: number | null = null;
  private inflight: Promise<string> | null = null;

  constructor(
    private readonly provider: TokenProvider,
    private readonly now: () => number = Date.now,
  ) {}

  get(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.token && (this.refreshAt === null || this.now() < this.refreshAt)) {
      return Promise.resolve(this.token);
    }
    if (!this.inflight) {
      this.inflight = this.provider()
        .then((result) => {
          const token = typeof result === 'string' ? result : result.token;
          if (!token) throw new Error('Token provider returned an empty token');
          const expiresIn = typeof result === 'string' ? undefined : result.expiresIn;
          this.token = token;
          // Refresh a minute early (or halfway, for very short tokens) so a
          // request never leaves with a token that expires in flight.
          this.refreshAt = expiresIn
            ? this.now() + expiresIn * 1000 - Math.min(60_000, (expiresIn * 1000) / 2)
            : null;
          return token;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }

  clear(): void {
    this.token = null;
    this.refreshAt = null;
  }
}
