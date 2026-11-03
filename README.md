# @fastcom/chat

JavaScript and TypeScript SDK for the Mobile Chat API.
It has no runtime dependencies and works in browsers, React Native and Node 18+.

```bash
npm install @fastcom/chat
```

The package is ES modules; CommonJS `require()` works on Node 20.19+ and 22.12+.

## In the app: `ChatClient`

```ts
import { ChatClient } from '@fastcom/chat';

const chat = new ChatClient({
  baseUrl: 'https://your-domain.com/app',
  // Your backend mints the token with the secret key (see ChatServer below).
  tokenProvider: () => fetch('/my-backend/chat-token').then((r) => r.json()),
});

const stream = chat.connect({
  onMessage: (m) => {
    if (m.interaction?.type === 'rating_card') showRatingCard(m);
    else showBubble(m.content, m.messageType);
  },
  onRating: (e) => markCardAnswered(e.messageId, e.answer),
  onStateChange: (state) => setBanner(state), // connecting | open | reconnecting | closed
  onError: (err) => console.warn(err),
});

await chat.sendMessage('Where is my order?');
await chat.sendMedia(file); // a File/Blob, or { uri, name, type } on React Native

const pending = await chat.getPendingRating();
if (pending) showRatingCard(pending);
// When the user taps a score:
await chat.submitRating({ messageId: pending!.messageId, score: 5, comment: 'Great' });

stream.close();
```

`tokenProvider` may return the `/token` response as-is (`{ token, expiresIn }`), which lets the SDK refresh before expiry, or a bare token string, which is refreshed after a `401`.

Without a backend, use the publishable key instead of `tokenProvider`.
This must be enabled on the app card, the end user id is self-declared, and these sessions cannot upload:

```ts
const chat = new ChatClient({
  baseUrl: 'https://your-domain.com/app',
  publishableKey: 'pk_live_...',
  endUserId: deviceId,
  endUserName: 'Jane',
});
```

### React Native

React Native's `fetch` cannot read a response as it streams, so the SDK reads `/stream` with `XMLHttpRequest` there.
It detects React Native by itself; pass `streamTransport: xhrTransport` (or `fetchTransport(fetch)`) to override.

## On your backend: `ChatServer`

```ts
import { ChatServer } from '@fastcom/chat';

const server = new ChatServer({ baseUrl: 'https://your-domain.com/app', secretKey: process.env.CHAT_SECRET_KEY! });

// Your token endpoint, after you have authenticated the user:
app.post('/my-backend/chat-token', async (req, res) => {
  res.json(await server.mintToken({ endUserId: req.user.id, endUserName: req.user.name }));
});

// Agent API
await server.reply({ endUserId: 'user-42', content: 'Your order ships today.' });
const page = await server.getMessages({ endUserId: 'user-42', limit: 50 });
await server.setBotEnabled('user-42', false); // a human takes over
```

`ChatServer` holds the secret key, so it only runs on a server runtime (Node, Deno, Bun, Vercel/Next.js Edge, Cloudflare Workers).
It throws in a browser or a React Native app.
`ChatClient` likewise refuses a secret key passed as `publishableKey`.

## Errors

Every non-2xx response throws a `ChatApiError` with `status`, `message`, `retryAfter` (seconds, on a `429`) and `limit` (set when an app-wide cap was hit).

## Development

```bash
npm install
npm test         # vitest
npm run typecheck
npm run build    # emits ESM and .d.ts to dist/
```

`npm publish` runs the typecheck, the tests and the build first (`prepublishOnly`).

## License

MIT, see [LICENSE](LICENSE).
