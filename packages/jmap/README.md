# @bumail/jmap

A JMAP server for Bun: the JMAP core (RFC 8620) and JMAP for Mail
(RFC 8621), as an [alxia](https://www.npmjs.com/package/@alxia/core) app
you mount in your own. It serves the mail of any
[`@bumail/store`](https://github.com/softistx/bumail/blob/develop/packages/store) `MailStore` — the same store
[`@bumail/imap`](https://github.com/softistx/bumail/blob/develop/packages/imap) serves — and reads messages with
[`@bumail/mime`](https://github.com/softistx/bumail/blob/develop/packages/mime): the session, the API with
back-references, Mailbox, Email and Thread, and blob download and upload.

```sh
bun add @bumail/jmap @alxia/core @bumail/store @bumail/mime
```

`@alxia/core` (0.2.1 or later), `@bumail/store` and `@bumail/mime` are
peers: install the versions your app uses. `typescript` is an optional
peer, for the types.

## Mounting it in an alxia app

`jmap(options)` returns an alxia app. `use` it in yours: it adds
`GET /.well-known/jmap` (the session) and, under `basePath` (`/jmap` by
default), `POST /jmap/api`, `GET /jmap/download/:accountId/:blobId/:name`
and `POST /jmap/upload/:accountId`. Each of its routes authenticates the
request first; your own routes are left alone.

```ts
import { alxia } from '@alxia/core';
import { jmap } from '@bumail/jmap';
import { MemoryMailStore } from '@bumail/store';

const store = new MemoryMailStore();
const alice = await store.createAccount('alice@example.com');
await store.createMailbox(alice.id, { name: 'INBOX', role: 'inbox' });

const tokens = new Map([['alice-secret-token', alice.id]]);
const passwords = new Map([['alice', await Bun.password.hash('correct horse')]]);

const server = jmap({
	store,
	origin: 'https://mail.example.com', // the public URL the session's URLs start with
	async authenticate(credentials) {
		if (credentials.scheme === 'bearer') return tokens.get(credentials.token) ?? null;
		const hash = passwords.get(credentials.username);
		if (!hash || !(await Bun.password.verify(credentials.password, hash))) return null;
		return alice.id;
	},
});

const app = alxia()
	.get('/health', ({ reply }) => reply(200, 'ok')) // not authenticated
	.use(server);

app.listen(8080);
```

[`examples/serve.ts`](https://github.com/softistx/bumail/blob/develop/packages/jmap/examples/serve.ts) is
this example, runnable from a clone: `bun install && bun run build`, then
`bun packages/jmap/examples/serve.ts`, then
`curl -H 'Authorization: Bearer alice-secret-token' http://localhost:8080/.well-known/jmap`.

## Authentication

`authenticate` gets `{ scheme: 'basic', username, password }` or
`{ scheme: 'bearer', token }`, and the `Request`. It answers the id of the
store account to serve, or `null` to refuse (a 401 with both challenges).
It runs under `hookTimeout` (30 s): one that throws, hangs or names an
account the store does not have is a 503, and `onError` is told.

**Basic is taken only over HTTPS.** On a clear request it is refused with a
403 before `authenticate` is called, as `@bumail/imap` and `@bumail/smtp`
refuse a login before TLS. Behind a proxy that ends TLS, say how to tell:

```ts
jmap({
	…,
	secure: (request) => request.headers.get('x-forwarded-proto') === 'https', // only if your proxy sets it
});
```

`allowInsecureBasic: true` lifts the refusal, for local tests only. Bearer
tokens are taken on any request.

## What it answers

| method | |
| --- | --- |
| `Core/echo` | its arguments |
| `Mailbox/get`, `Mailbox/changes` | every property; `myRights` grants all but `maySubmit` |
| `Mailbox/query` | filter by `parentId`, `role`, `name`, `hasAnyRole`, `isSubscribed`; sort by `sortOrder` and `name` |
| `Mailbox/set` | create, update `name`, `parentId` and `isSubscribed`, destroy with `onDestroyRemoveEmails` |
| `Email/get` | the metadata, `headers`, every `header:` form, the convenience headers, `bodyStructure`, `textBody`, `htmlBody`, `attachments`, `bodyValues`, `preview`, `hasAttachment` |
| `Email/query` | filter by `inMailbox`, `inMailboxOtherThan`, `before`, `after`, `minSize`, `maxSize`, `hasKeyword`, `notKeyword`, `text`, `from`, `to`, `cc`, `bcc`, `subject`, `body`, with AND, OR and NOT; sort by `receivedAt`, `size`, `from`, `to`, `subject`; `collapseThreads`, `position`, `anchor`, `limit`, `calculateTotal` |
| `Email/changes` | created, updated and destroyed since a state |
| `Email/set` | update `keywords` and `mailboxIds`, whole or patched; destroy; create from an uploaded `blobId` |
| `Email/import` | emails from uploaded blobs |
| `Thread/get` | the emails of a thread, oldest first |

Back-references (`#ids` with `resultOf`, `name` and a `path` with `*`)
and `#creationId`s work across calls of one request.

## Uploading and downloading

```ts
// accountId and inboxId come from the session and Mailbox/get; rawMessage is RFC 5322 bytes
const authorization = 'Bearer alice-secret-token';
const upload = await fetch(`https://mail.example.com/jmap/upload/${accountId}`, {
	method: 'POST',
	headers: { authorization, 'content-type': 'message/rfc822' },
	body: rawMessage,
}).then((response) => response.json()); // { accountId, blobId, type, size }

// then: ["Email/import", { accountId, emails: { a: { blobId: upload.blobId, mailboxIds: { [inboxId]: true } } } }, "0"]
```

A download serves an email's bytes, one of its parts (each part's
`blobId` in `Email/get`), or an upload, with `Range` support:
`GET /jmap/download/{accountId}/{blobId}/{name}?accept={type}`.

## Limits

| limit | default | |
| --- | --- | --- |
| `maxSizeRequest` | 10 MB | the API body: a `Content-Length` past it refused unread, a chunked body cut once past it |
| `maxCallsInRequest` | 16 | method calls in one request |
| `maxConcurrentRequests` | 4 | API requests in flight, per account |
| `maxObjectsInGet`, `maxObjectsInSet` | 500 | ids in a `/get`; creates, updates and destroys in a `/set`; and the page of a query |
| `maxSizeUpload` | 25 MiB | one upload, held like `maxSizeRequest` |
| `maxConcurrentUpload` | 4 | uploads in flight, per account |
| `uploadQuota` | 100 MiB | bytes of uploads held per account |
| `uploadTtl` | 3600 s | how long an upload is kept |
| `maxJsonDepth`, `maxJsonTokens` | 64, 100 000 | checked before the body is parsed |
| `maxReferenceItems` | 5000 | values one back-reference expands to |
| `maxReferenceBytes` | 4 MiB | bytes of JSON all the back-references of one request resolve to |
| `maxSizeResponse` | 64 MiB | bytes of JSON of one API response |
| `maxQueryScan` | 10 000 | emails a query, a thread lookup, a text search or a `Mailbox/get` count reads (past it, the store's counts) |
| `maxBodyValueBytes` | 1 MiB | one body value, whatever the client asks |
| `maxBodyValuesTotal` | 16 MiB | body values in one request |

Set them under `limits`. `maxSizeRequest`, `maxCallsInRequest`,
`maxConcurrentRequests`, `maxObjectsInGet`, `maxObjectsInSet`,
`maxSizeUpload` and `maxConcurrentUpload` are announced in the session's
`urn:ietf:params:jmap:core` capability. A limit broken by the request is a
`urn:ietf:params:jmap:error:limit` problem naming it (413 for a size it
sent, 429 for a concurrency, 400 for the rest, `maxSizeResponse` included); one broken by a call is a method
error. Ids are `[A-Za-z0-9_-]{1,255}`; an account never reaches another
account's data, whatever id it names; client text repeated in an error is
cut after 100 characters.

## Traps

- **Queries run in memory.** The store has no index yet: `Email/query`
  and `Thread/get` read at most `maxQueryScan` emails (one mailbox's when
  the filter names `inMailbox`), and answer `tooLarge` past it.
  `Mailbox/get` counts `unreadEmails`, `totalThreads` and
  `unreadThreads` as RFC 8621 §2 asks (`$seen` in any spelling is read,
  `$draft` is never unread) within the same budget, all its mailboxes
  together (`properties` left out, null, asks for them): past it, a
  mailbox's counts are the store's IMAP counts, `unseen` for both unread
  counts and `messages` for `totalThreads`.
- **Uploads live in memory** for `uploadTtl`, in the process that took
  them: a restart forgets them, and two processes do not share them.
- **Threads are single emails** unless your delivery code passes a
  `threadId` to `store.addMessage`; nothing groups replies yet.
- **`sortOrder` is always 0**, and a mailbox's `role` cannot change: the
  store keeps neither.
- **`ifInState` is checked, then the call runs**: another writer between
  the two is not caught.
- **No push yet.** The session announces an `eventSourceUrl`, which
  answers 404 until push lands; `notify(accountId)` does nothing yet.
- **The session is at `/.well-known/jmap` of the app that mounts it**:
  mount `jmap()` on an app with no prefix, or that path moves too.
- **`asRaw` header values are unfolded** and lose their leading space.

## API

| export | |
| --- | --- |
| `jmap(options)` | the server: an alxia app to `use`, with `notify(accountId)`; throws a `JmapError` (`INVALID_OPTION`) on a bad option |
| `JmapServer` | `notify(accountId)`: reserved for push, a no-op today |
| `JmapOptions` | `store`, `authenticate`, `origin`, `basePath`, `limits`, `hookTimeout`, `allowInsecureBasic`, `secure`, `onError` |
| `JmapLimits` | the limits above |
| `JmapCredentials` | what `authenticate` gets: `{ scheme: 'basic', username, password }` or `{ scheme: 'bearer', token }` |
| `AuthResult` | what `authenticate` answers: an account id, or `null` / `undefined` |
| `ErrorContext` | what `onError` gets beside the error: `request`, `accountId`, `method` |
| `JmapError`, `JmapErrorCode` | `code`: `INVALID_OPTION`, and `HOOK_TIMEOUT`, which `onError` gets |

## Documentation

- [Index](https://github.com/softistx/bumail/blob/develop/packages/jmap/docs/README.md): the pages, and when to read each.
- [Guide](https://github.com/softistx/bumail/blob/develop/packages/jmap/docs/guide.md): mounting, authenticating, the session, every method and how the store maps to it, blobs, limits, and the RFCs followed.
- [Troubleshooting](https://github.com/softistx/bumail/blob/develop/packages/jmap/docs/troubleshooting.md): every error, problem and method error, by its exact text.
- [Roadmap](https://github.com/softistx/bumail/blob/develop/packages/jmap/docs/roadmap.md): what is coming — queryChanges, push, Identity, EmailSubmission, SearchSnippet, VacationResponse — and the store gaps.

## License

MIT
