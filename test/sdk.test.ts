import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatApiError, ChatClient, ChatServer, type ChatStream, type StreamEvent, type StreamTransport } from '../src/index.js';
import { SseParser } from '../src/sse.js';
import { TokenCache } from '../src/token.js';

const BASE = 'https://example.com/app';

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - start > ms) return reject(new Error('waitFor timed out'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe('SseParser', () => {
  it('handles split chunks, CRLF, comments and multi-line data', () => {
    const out: string[] = [];
    const p = new SseParser((d) => out.push(d));
    p.push('data: {"a"');
    p.push(':1}\n\n: heartbeat\n\n');
    p.push('data: one\r\ndata: two\r\n\r');
    p.push('\nevent: x\nid: 3\ndata:no-space\n\n');
    expect(out).toEqual(['{"a":1}', 'one\ntwo', 'no-space']);
  });
});

describe('TokenCache', () => {
  it('reuses a token until a minute before expiry and shares one refresh', async () => {
    let now = 0;
    const provider = vi.fn(async () => ({ token: `t${provider.mock.calls.length}`, expiresIn: 1800 }));
    const cache = new TokenCache(provider, () => now);
    const [a, b] = await Promise.all([cache.get(), cache.get()]);
    expect([a, b]).toEqual(['t1', 't1']);
    now = 1739_000;
    expect(await cache.get()).toBe('t1');
    now = 1741_000;
    expect(await cache.get()).toBe('t2');
    expect(await cache.get(true)).toBe('t3');
  });

  it('keeps a bare string token until forced', async () => {
    const provider = vi.fn(async () => 'plain');
    const cache = new TokenCache(provider, () => 1e12);
    await cache.get();
    await cache.get();
    expect(provider).toHaveBeenCalledTimes(1);
  });
});

describe('ChatClient', () => {
  it('mints with the publishable key and sends a message', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/token')) {
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer pk_live_x');
        expect(JSON.parse(init.body as string)).toEqual({ endUserId: 'u1', endUserName: 'Jane' });
        return json({ token: 'session', expiresIn: 1800, tokenType: 'Bearer' });
      }
      expect(url).toBe(`${BASE}/api/v1/chat/message`);
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer session');
      expect(JSON.parse(init.body as string)).toEqual({ content: 'hi', messageType: 'TEXT' });
      return json({ messageId: 'm1', conversationWithId: 'c1' }, 201);
    });
    const client = new ChatClient({
      baseUrl: `${BASE}/`,
      publishableKey: 'pk_live_x',
      endUserId: 'u1',
      endUserName: 'Jane',
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(await client.sendMessage('hi')).toEqual({ messageId: 'm1', conversationWithId: 'c1' });
  });

  it('refreshes the token once on 401 and retries', async () => {
    let tokenN = 0;
    const seen: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).Authorization;
      seen.push(auth);
      return auth === 'Bearer t1' ? json({ error: 'Invalid or expired session token' }, 401) : json({ appId: 'a', name: 'n', botConnected: true, botActive: true });
    });
    const client = new ChatClient({
      baseUrl: BASE,
      tokenProvider: async () => `t${++tokenN}`,
      fetch: fetchMock as unknown as typeof fetch,
    });
    const config = await client.getConfig();
    expect(config.botActive).toBe(true);
    expect(seen).toEqual(['Bearer t1', 'Bearer t2']);
  });

  it('turns an app-wide 429 into a ChatApiError with retryAfter and limit', async () => {
    const client = new ChatClient({
      baseUrl: BASE,
      tokenProvider: async () => 't',
      fetch: (async () => json({ error: 'App usage limit reached', limit: 'messagesPerHour' }, 429, { 'Retry-After': '120' })) as unknown as typeof fetch,
    });
    const err = await client.sendMessage('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChatApiError);
    expect(err).toMatchObject({ status: 429, retryAfter: 120, limit: 'messagesPerHour', message: 'App usage limit reached' });
  });

  it('uploads then sends the media URL with its type', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      calls.push(url.split('/chat')[1]!);
      if (url.endsWith('/upload')) {
        const file = (init.body as FormData).get('file') as File;
        expect(file.name).toBe('photo.png');
        return json({ url: 'https://storage/x.png', messageType: 'IMAGE' }, 201);
      }
      expect(JSON.parse(init.body as string)).toEqual({ content: 'https://storage/x.png', messageType: 'IMAGE' });
      return json({ messageId: 'm', conversationWithId: 'c' }, 201);
    });
    const client = new ChatClient({ baseUrl: BASE, tokenProvider: async () => 't', fetch: fetchMock as unknown as typeof fetch });
    await client.sendMedia(new Blob([new Uint8Array([1, 2])], { type: 'image/png' }), 'photo.png');
    expect(calls).toEqual(['/upload', '/message']);
  });

  it('reads the pending rating card and submits one', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
      init.method === 'GET'
        ? json({ pending: null })
        : json({ status: 'recorded', answer: { score: 4, comment: null, at: 'now' } }),
    );
    const client = new ChatClient({ baseUrl: BASE, tokenProvider: async () => 't', fetch: fetchMock as unknown as typeof fetch });
    expect(await client.getPendingRating()).toBeNull();
    expect((await client.submitRating({ messageId: 'm', score: 4 })).status).toBe('recorded');
  });

  it('requires a token source', () => {
    expect(() => new ChatClient({ baseUrl: BASE, fetch: vi.fn() as unknown as typeof fetch })).toThrow();
    expect(() => new ChatClient({ baseUrl: BASE, publishableKey: 'pk_live_x', fetch: vi.fn() as unknown as typeof fetch })).toThrow(/endUserId/);
  });
});

describe('ChatStream', () => {
  it('dispatches events, reconnects after the server ends the stream, and refreshes on 401', async () => {
    const tokens: string[] = [];
    let opened = 0;
    const transport: StreamTransport = async (req, onText) => {
      opened += 1;
      tokens.push(req.headers.Authorization!);
      if (opened === 1) {
        onText('data: {"type":"connected","appId":"a","endUserId":"u"}\n\n');
        onText('data: {"type":"message","messageId":"m1","content":"hello","messageType":"TEXT","isFromPage":true,"platformMessageId":"p","timestamp":"t"}\n\n');
        return { status: 200 }; // server closed, e.g. a deploy
      }
      if (opened === 2) return { status: 401, body: 'Invalid or expired session token' };
      onText('data: {"type":"rating","messageId":"m1","answer":{"score":5,"comment":null,"at":"t"}}\n\n');
      await new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(new Error('aborted'))));
      return { status: 200 };
    };
    let n = 0;
    const client = new ChatClient({ baseUrl: BASE, tokenProvider: async () => `t${++n}`, streamTransport: transport, fetch: vi.fn() as unknown as typeof fetch });
    const events: StreamEvent[] = [];
    const messages: string[] = [];
    const states: string[] = [];
    const stream = client.connect(
      { onEvent: (e) => events.push(e), onMessage: (m) => messages.push(m.content), onStateChange: (s) => states.push(s) },
      { maxBackoffMs: 20 },
    );
    await waitFor(() => events.some((e) => e.type === 'rating'));
    stream.close();
    expect(messages).toEqual(['hello']);
    expect(tokens).toEqual(['Bearer t1', 'Bearer t1', 'Bearer t2']);
    expect(states[0]).toBe('connecting');
    expect(states).toContain('open');
    expect(states).toContain('reconnecting');
    expect(states.at(-1)).toBe('closed');
    expect(stream.state).toBe('closed');
  });

  it('stops for good on 404', async () => {
    const transport = vi.fn<StreamTransport>(async () => ({ status: 404, body: 'App not found' }));
    const client = new ChatClient({ baseUrl: BASE, tokenProvider: async () => 't', streamTransport: transport, fetch: vi.fn() as unknown as typeof fetch });
    const errors: Error[] = [];
    const stream = client.connect({ onError: (e) => errors.push(e) }, { maxBackoffMs: 5 });
    await waitFor(() => stream.state === 'closed');
    await new Promise((r) => setTimeout(r, 30));
    expect(transport).toHaveBeenCalledTimes(1);
    expect(errors[0]).toMatchObject({ status: 404, message: 'App not found' });
  });

  it('reconnects when the connection goes silent', async () => {
    let opened = 0;
    const transport: StreamTransport = (req) => {
      opened += 1;
      return new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    };
    const client = new ChatClient({ baseUrl: BASE, tokenProvider: async () => 't', streamTransport: transport, fetch: vi.fn() as unknown as typeof fetch });
    const errors: string[] = [];
    const stream = client.connect({ onError: (e) => errors.push(e.message) }, { idleTimeoutMs: 20, maxBackoffMs: 5 });
    await waitFor(() => opened >= 2);
    stream.close();
    expect(errors[0]).toMatch(/No data on the stream/);
  });
});

describe('fetch stream transport against a real HTTP server', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  it('reads SSE over a live socket', async () => {
    server = createServer((req, res) => {
      expect(req.url).toBe('/app/api/v1/chat/stream');
      expect(req.headers.authorization).toBe('Bearer live');
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"type":"connected","appId":"a","endUserId":"u"}\n\n');
      setTimeout(() => res.write(': heartbeat\n\n'), 5);
      setTimeout(() => res.write('data: {"type":"message","messageId":"m","content":"live","messageType":"TEXT","isFromPage":true,"platformMessageId":"p","timestamp":"t"}\n\n'), 10);
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as AddressInfo;
    const client = new ChatClient({ baseUrl: `http://127.0.0.1:${port}/app`, tokenProvider: async () => 'live' });
    const got: string[] = [];
    const stream = client.connect({ onMessage: (m) => got.push(m.content) });
    await waitFor(() => got.length === 1);
    stream.close();
    server.closeAllConnections();
    expect(got).toEqual(['live']);
  });
});

describe('ChatServer', () => {
  it('calls the Agent API with the secret key', async () => {
    const seen: Array<{ url: string; method: string; body?: unknown }> = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk_live_x');
      seen.push({ url: url.split('/chat')[1]!, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body as string) : undefined });
      return json({});
    });
    const server = new ChatServer({ baseUrl: BASE, secretKey: 'sk_live_x', fetch: fetchMock as unknown as typeof fetch });
    await server.mintToken({ endUserId: 'u' });
    await server.reply({ endUserId: 'u', content: 'Ships today' });
    await server.getMessages({ endUserId: 'u 1', limit: 10, before: new Date('2026-01-01T00:00:00Z') });
    await server.getBotEnabled('u');
    await server.setBotEnabled('u', false);
    expect(seen).toEqual([
      { url: '/token', method: 'POST', body: { endUserId: 'u' } },
      { url: '/agent/reply', method: 'POST', body: { endUserId: 'u', content: 'Ships today' } },
      { url: '/agent/messages?endUserId=u+1&limit=10&before=2026-01-01T00%3A00%3A00.000Z', method: 'GET', body: undefined },
      { url: '/agent/bot?endUserId=u', method: 'GET', body: undefined },
      { url: '/agent/bot', method: 'POST', body: { endUserId: 'u', enabled: false } },
    ]);
  });

  it('refuses to run in a browser', () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {});
    try {
      expect(() => new ChatServer({ baseUrl: BASE, secretKey: 'sk' })).toThrow(/browser/);
      expect(() => new ChatServer({ baseUrl: BASE, secretKey: 'sk', dangerouslyAllowBrowser: true })).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('review fixes', () => {
  it('drops a refresh that was in flight when clearSession() ran, and fetches for the new user', async () => {
    let user = 'user-A';
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const cache = new TokenCache(async () => {
      calls += 1;
      const forUser = user;
      if (calls === 1) await gate; // the first refresh is slow
      return { token: forUser, expiresIn: 1800 };
    });
    const pending = cache.get();
    cache.clear(); // user A signs out mid-refresh
    user = 'user-B';
    release();
    expect(await pending).toBe('user-B');
    expect(await cache.get()).toBe('user-B');
    expect(calls).toBe(2);
  });

  it('refuses a secret key passed as publishableKey, without echoing it', () => {
    let message = '';
    try {
      new ChatClient({ baseUrl: BASE, publishableKey: 'sk_live_supersecret', endUserId: 'u', fetch: vi.fn() as unknown as typeof fetch });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/secret key/);
    expect(message).not.toContain('supersecret');
    expect(() => new ChatClient({ baseUrl: BASE, publishableKey: 'nope', endUserId: 'u', fetch: vi.fn() as unknown as typeof fetch })).toThrow(/pk_/);
  });

  it('never prints the secret key or the session token', async () => {
    const { inspect } = await import('node:util');
    const server = new ChatServer({ baseUrl: BASE, secretKey: 'sk_live_supersecret', fetch: vi.fn() as unknown as typeof fetch });
    expect(inspect(server, { depth: 10, showHidden: true })).not.toContain('supersecret');
    expect(JSON.stringify(server)).not.toContain('supersecret');

    // A plain function, not vi.fn(): a mock records its calls, Authorization header included.
    const plainFetch = async () => json({ appId: 'a', name: 'n', botConnected: true, botActive: true });
    const client = new ChatClient({ baseUrl: BASE, tokenProvider: async () => 'jwt-session-token', fetch: plainFetch as unknown as typeof fetch });
    await client.getConfig();
    expect(inspect(client, { depth: 10, showHidden: true })).not.toContain('jwt-session-token');
    expect(JSON.stringify(client)).not.toContain('jwt-session-token');
  });

  it('refuses ChatServer in React Native and in a browser', () => {
    vi.stubGlobal('navigator', { product: 'ReactNative' });
    try {
      expect(() => new ChatServer({ baseUrl: BASE, secretKey: 'sk' })).toThrow(/server/);
    } finally {
      vi.unstubAllGlobals();
    }
    vi.stubGlobal('document', {});
    try {
      expect(() => new ChatServer({ baseUrl: BASE, secretKey: 'sk' })).toThrow(/server/);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(() => new ChatServer({ baseUrl: BASE, secretKey: 'sk' })).not.toThrow(); // plain Node
  });

  it('keeps reconnecting when handlers throw, with no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      let opened = 0;
      const transport: StreamTransport = async () => {
        opened += 1;
        return { status: 500, body: 'boom' };
      };
      const client = new ChatClient({ baseUrl: BASE, tokenProvider: async () => 't', streamTransport: transport, fetch: vi.fn() as unknown as typeof fetch });
      const stream = client.connect(
        {
          onError: () => { throw new Error('bad onError'); },
          onStateChange: () => { throw new Error('bad onStateChange'); },
        },
        { maxBackoffMs: 5 },
      );
      await waitFor(() => opened >= 3);
      stream.close();
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
      expect(stream.state).toBe('closed');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('calls no handler after close(), even for the rest of the same chunk', async () => {
    const transport: StreamTransport = async (req, onText) => {
      onText(
        'data: {"type":"connected","appId":"a","endUserId":"u"}\n\n' +
          'data: {"type":"message","messageId":"m1","content":"first","messageType":"TEXT","isFromPage":true,"platformMessageId":"p","timestamp":"t"}\n\n' +
          'data: {"type":"message","messageId":"m2","content":"second","messageType":"TEXT","isFromPage":true,"platformMessageId":"p","timestamp":"t"}\n\n',
      );
      await new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(new Error('aborted'))));
      return { status: 200 };
    };
    const client = new ChatClient({ baseUrl: BASE, tokenProvider: async () => 't', streamTransport: transport, fetch: vi.fn() as unknown as typeof fetch });
    const got: string[] = [];
    const states: string[] = [];
    const stream: ChatStream = client.connect({
      onMessage: (m) => {
        got.push(m.content);
        stream.close();
      },
      onStateChange: (s) => states.push(s),
    });
    await waitFor(() => got.length > 0);
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toEqual(['first']);
    expect(states.at(-1)).toBe('closed');
    expect(stream.state).toBe('closed');
  });

  it('waits at least Retry-After before reconnecting', async () => {
    const at: number[] = [];
    const transport: StreamTransport = async () => {
      at.push(Date.now());
      return { status: 429, body: 'Rate limit exceeded', retryAfter: 0.3 };
    };
    const client = new ChatClient({ baseUrl: BASE, tokenProvider: async () => 't', streamTransport: transport, fetch: vi.fn() as unknown as typeof fetch });
    const errors: unknown[] = [];
    const stream = client.connect({ onError: (e) => errors.push(e) }, { maxBackoffMs: 5 });
    await waitFor(() => at.length >= 2, 3000);
    stream.close();
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(290);
    expect(errors[0]).toMatchObject({ status: 429, retryAfter: 0.3 });
  });
});
