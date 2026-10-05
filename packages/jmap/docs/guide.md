# Guide

The long version of the [README](../README.md): how `@bumail/jmap` is
mounted, how it authenticates, what the session says, what each method
does with the store, how blobs travel, the limits, its OpenAPI document,
and the RFCs it follows.

- [Mounting the server](#mounting-the-server)
- [Authenticating](#authenticating)
- [The session](#the-session)
- [A request](#a-request)
- [Mailboxes](#mailboxes)
- [Emails](#emails)
- [Threads](#threads)
- [Blobs](#blobs)
- [States and changes](#states-and-changes)
- [Limits](#limits)
- [onError](#onerror)
- [The OpenAPI document](#the-openapi-document)
- [RFCs followed, and what is not](#rfcs-followed-and-what-is-not)

## Mounting the server

`jmap(options)` returns an alxia app with four routes:

| route | |
| --- | --- |
| `GET /.well-known/jmap` | the session (RFC 8620 §2) |
| `POST {basePath}/api` | the API (RFC 8620 §3) |
| `GET {basePath}/download/:accountId/:blobId/:name` | a blob (RFC 8620 §6.2) |
| `POST {basePath}/upload/:accountId` | an upload (RFC 8620 §6.1) |

`basePath` is `/jmap` unless you give another: `/mail/jmap`, with no
trailing slash. The session stays at `/.well-known/jmap`, where RFC 8620
§2.2 says a client looks for it.

```ts
import { alxia } from '@alxia/core';
import { jmap } from '@bumail/jmap';

const server = jmap({ store, origin: 'https://mail.example.com', basePath: '/mail/jmap', authenticate });

const app = alxia()
	.get('/health', ({ reply }) => reply(200, 'ok'))
	.plugin(server)
	.get('/admin', adminPage); // after plugin: still not authenticated by jmap
```

The authentication is a `derive` inside a group of the jmap app, so it
applies to the jmap routes only: a route you declare before or after
`plugin(server)` never sees it. `plugin` mounts the routes under the host's
prefix, so `alxia({ prefix: '/api' }).plugin(server)` would serve the session
at `/api/.well-known/jmap`, where no client looks: mount it on an app
without a prefix.

`origin` is the public origin the session's URLs start with — what a
client reaches, not what the process binds: `https://mail.example.com`,
with no path. Behind a proxy, it is the proxy's.

`jmap()` returns the app with one more method, `notify(accountId)`. It is
reserved for push (RFC 8620 §7), which lands in a later slice: today it
does nothing. Call it after a delivery already, and new mail will reach
push clients once push is there.

## Authenticating

Every route asks `authenticate` first, with the credentials of the
`Authorization` header:

| header | `authenticate` gets |
| --- | --- |
| `Basic base64(user:password)` (RFC 7617) | `{ scheme: 'basic', username, password }`, the password everything after the first `:` |
| `Bearer token` (RFC 6750) | `{ scheme: 'bearer', token }` |

It answers the account id to serve, or `null` (or `undefined`) to refuse.
The account must exist in the store: the server reads it once per
request, for its name, which the session calls `username`.

| what happens | the client gets |
| --- | --- |
| no `Authorization`, another scheme, a header past 8 KiB, Basic that is not base64 of UTF-8 `user:password` | 401 `Authentication required` |
| `authenticate` answers `null` | 401 `Authentication failed` |
| Basic on a clear request | 403 `Basic authentication is refused on a clear connection: use HTTPS`, `authenticate` not called |
| `authenticate` throws, does not settle within `hookTimeout`, answers something other than an account id or `null`, or names an account the store does not have; or the store's `getAccount` throws | 503 `Temporary authentication failure`, with `Retry-After: 5`; `onError` is told |

Every 401 carries both challenges, `Basic realm="JMAP", charset="UTF-8"`
and `Bearer realm="JMAP"`. Every refusal is an RFC 7807 problem
(`application/problem+json`) of type `about:blank`.

A request is clear unless its URL is `https:`. Behind a proxy that ends
TLS, `secure(request)` decides instead — trust a header only when your
proxy sets it and strips the client's:

```ts
jmap({ …, secure: (request) => request.headers.get('x-forwarded-proto') === 'https' });
```

`allowInsecureBasic: true` takes Basic over `http:`. It exists for local
tests and examples; a server on the Internet never sets it.

## The session

```json
{
  "capabilities": {
    "urn:ietf:params:jmap:core": {
      "maxSizeUpload": 26214400, "maxConcurrentUpload": 4,
      "maxSizeRequest": 10000000, "maxConcurrentRequests": 4,
      "maxCallsInRequest": 16, "maxObjectsInGet": 500, "maxObjectsInSet": 500,
      "collationAlgorithms": ["i;unicode-casemap"]
    },
    "urn:ietf:params:jmap:mail": {}
  },
  "accounts": {
    "<accountId>": {
      "name": "alice@example.com", "isPersonal": true, "isReadOnly": false,
      "accountCapabilities": {
        "urn:ietf:params:jmap:mail": {
          "maxMailboxesPerEmail": null, "maxMailboxDepth": null,
          "maxSizeMailboxName": 255, "maxSizeAttachmentsPerEmail": 26214400,
          "emailQuerySortOptions": ["receivedAt", "size", "from", "to", "subject"],
          "mayCreateTopLevelMailbox": true
        }
      }
    }
  },
  "primaryAccounts": { "urn:ietf:params:jmap:mail": "<accountId>" },
  "username": "alice@example.com",
  "apiUrl": "https://mail.example.com/jmap/api",
  "downloadUrl": "https://mail.example.com/jmap/download/{accountId}/{blobId}/{name}?accept={type}",
  "uploadUrl": "https://mail.example.com/jmap/upload/{accountId}",
  "eventSourceUrl": "https://mail.example.com/jmap/eventsource?types={types}&closeafter={closeafter}&ping={ping}",
  "state": "9f86d081884c7d65"
}
```

One account: the one `authenticate` answered. The `state` is a hash of
the rest, so it changes only when the limits, the URLs or the account's
name do; every API response carries it as `sessionState`. The
`eventSourceUrl` is required by RFC 8620 and answers 404 until push lands.

## A request

```json
{
  "using": ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
  "methodCalls": [
    ["Email/query", { "accountId": "A", "filter": { "inMailbox": "INBOX-ID" }, "limit": 10 }, "q"],
    ["Email/get", { "accountId": "A", "#ids": { "resultOf": "q", "name": "Email/query", "path": "/ids" }, "properties": ["subject", "from"] }, "g"]
  ]
}
```

The body is held to `maxSizeRequest` as the route's alxia `bodyLimit`: a
`Content-Length` past it is refused without reading a byte, and a body
without one — chunked — or with a false one is counted as it arrives and
refused at the first chunk past it, never read whole. Before it is parsed
it must be UTF-8 and nest at most `maxJsonDepth` levels with at most
`maxJsonTokens` tokens. Then it must be a Request object: `using` an array
of names, `methodCalls` an array of `[name, arguments, callId]` with a
name and a call id of at most 255 characters, at most `maxCallsInRequest`
of them, and `createdIds`, if given, an object of at most
`maxObjectsInSet` ids. Each name in `using` must be
`urn:ietf:params:jmap:core` or `urn:ietf:params:jmap:mail`. A request that
fails any of these is answered with one problem and no call runs (RFC 8620
§3.6.1).

Then each call runs in order, each seeing the responses before it:

1. A method this server does not have, or whose capability is not in
   `using`, is `unknownMethod`.
2. Its `#name` arguments are resolved from an earlier response: the first
   with the call id `resultOf`, which must be named `name`, read at
   `path` — RFC 6901 JSON Pointer, where `*` on an array maps the rest of
   the path over its items and flattens one level of arrays (RFC 8620
   §3.7). A reference expands to at most `maxReferenceItems` values, and
   all the references of one request together resolve to at most
   `maxReferenceBytes` bytes of JSON — a path of `''` or to an object
   counts whole — so chained `Core/echo` calls cannot double a response
   at each step. Past either, the call is `invalidResultReference`.
   Giving both `ids` and `#ids` is `invalidArguments`.
3. The method checks its arguments: an unknown one is `invalidArguments`.
   `accountId` must be the authenticated account; any other is
   `accountNotFound`.
4. What a method throws is an `error` response for that call; the rest of
   the request goes on. An error that is not the client's — the store
   failing — is `serverFail`, and `onError` gets the error.

The response is `{ methodResponses, sessionState }`, and `createdIds`
when the request gave it: the ids it gave, and every creation id the
request created. A response that grows past `maxSizeResponse` bytes of
JSON stops the request: no further call runs, and the whole request is a
400 `urn:ietf:params:jmap:error:limit` problem naming `maxSizeResponse`.

A `#creationId` stands for an id created earlier in the request, in an
argument that takes an id: `ids` of a `/get`, the keys of `update`,
`destroy`, `parentId`, `mailboxIds`, `inMailbox`. The creation id after
`#` has an id's syntax, `[A-Za-z0-9_-]{1,255}`; a key of `update` or an
item of `destroy` that is neither is `invalidArguments`.

## Mailboxes

A store mailbox is a JMAP Mailbox. `name` is the store's name of one
level, `parentId` its parent, `role` its role (`inbox`, `archive`,
`drafts`, `sent`, `trash`, `junk`, `all`, `flagged`, `important`),
`isSubscribed` its subscription. `totalEmails` is the store's count.
The three other counts follow RFC 8621 §2:

- **`unreadEmails`** counts the mailbox's emails that have neither
  `$seen` nor `$draft`, however the store keeps them: the IMAP flag
  (`\Seen`, `\Draft`) or a keyword an IMAP client stored beside it
  (`$Seen`, `$SEEN`, `$Draft`), in any case. It is not the store's
  `unseen`, which is IMAP's UNSEEN and looks for `\Seen` alone.
- **`totalThreads`** counts the threads with at least one email in the
  mailbox.
- **`unreadThreads`** counts the threads with at least one email in the
  mailbox that is unread, by the rule above — the RFC's simplest
  definition: an unread email of the thread in another mailbox does not
  make it unread here, and a thread whose only unread email is a draft is
  not unread.

They are counted in one pass over the mailbox's messages, only when one
of them is asked — `properties` left out (null) asks for them all — and
at most `maxQueryScan` emails for one call, all its mailboxes together.
Past it, a mailbox's counts are the store's: `unreadEmails` is its
`unseen`, and `totalThreads` and `unreadThreads` are its `totalEmails`
and `unseen`, exact while threads are single emails and no email is a
draft or keeps `$seen` only as a keyword.
`sortOrder` is always 0, and
`myRights` grants everything but `maySubmit`.

`Mailbox/set`:

- **create** takes `name` (required), `parentId` (an id, a
  `#creationId` of a mailbox created before it in the same call, or
  `null`), `role` and `isSubscribed`. `sortOrder` may only be 0. The
  answer holds the id and the server-set properties.
- **update** takes `name`, `parentId` and `isSubscribed`. `sortOrder` 0
  and `role` unchanged are accepted and do nothing; any other property is
  `invalidProperties`. A rename or a move keeps the mailbox's id and its
  messages.
- **destroy** refuses a mailbox with children (`mailboxHasChild`), and
  one holding emails unless `onDestroyRemoveEmails` is true
  (`mailboxHasEmail`); with it, the emails leave the mailbox, and one left
  in no mailbox is destroyed.

Creates run first, then updates, then destroys, each on its own: one that
fails does not stop the others.

`Mailbox/query` filters by `parentId` (`null` for the top), `role`,
`name` (contained, case folded), `hasAnyRole` and `isSubscribed`, with
`AND`, `OR` and `NOT`, and sorts by `sortOrder` then `name`, case folded,
then by id. `sortAsTree` and `filterAsTree` are not supported yet.

## Emails

A store message is a JMAP Email: one id for its life, in one mailbox or
several (`mailboxIds`), its flags as `keywords`. `\Seen`, `\Answered`,
`\Flagged` and `\Draft` are `$seen`, `$answered`, `$flagged` and
`$draft`; `\Deleted` is not shown (RFC 8621 §4.1.1) and survives a
change of keywords.

Keywords compare without case (RFC 8621 §4.1.1), and the server returns
them lowercased: a store that keeps a keyword as it was first written —
`$Forwarded`, `$MDNSent`, written over IMAP — shows it as `$forwarded`
and `$mdnsent`, and two flags that differ only by case are one keyword.
`hasKeyword` and `notKeyword` match a stored keyword in any case. In
`Email/set`, a keyword the email already has, in any case, is not added
again, removing `$forwarded` removes a stored `$Forwarded`, and a whole
`keywords` keeps the spelling a keyword was stored with. A keyword the
server stores itself, from `Email/set` or `Email/import`, is lowercased.
An IMAP client may also store `$Seen` (or `$Answered`, `$Flagged`,
`$Draft`) as an ordinary keyword beside the system flag: it shows as
`$seen` like `\Seen`, `hasKeyword: '$seen'` matches either, and removing
`$seen` removes both. Adding `$seen`, alone or in a whole `keywords`,
always stores `\Seen`, so an IMAP client sees the message as read: beside
a stored `$Seen` on add, in its place on a whole set.

### Email/get

What each property costs:

| properties | read |
| --- | --- |
| `id`, `blobId`, `threadId`, `mailboxIds`, `keywords`, `size`, `receivedAt` | the store's record only |
| `headers`, `messageId`, `inReplyTo`, `references`, `sender`, `from`, `to`, `cc`, `bcc`, `replyTo`, `subject`, `sentAt`, `header:…` | the message's header, and no further |
| `bodyStructure`, `textBody`, `htmlBody`, `attachments`, `hasAttachment`, `preview`, `bodyValues` | the whole message, once, streaming |

A `header:` property is `header:{name}`, `header:{name}:{form}` or either
with `:all`; the forms are `asRaw` (the default), `asText`,
`asAddresses`, `asGroupedAddresses`, `asMessageIds`, `asDate` and
`asURLs` (RFC 8621 §4.1.2). Without `:all` it is the last field of that
name, or `null`; with it, every one, in order. Dates are given in UTC.

`textBody`, `htmlBody` and `attachments` follow RFC 8621 §4.1.4's
algorithm. Each part has a `partId` — IMAP's section number, `1` for a
message that is not multipart — and a `blobId` you can download. Its
`size` is its size once its transfer encoding is decoded.

`bodyValues` holds the parts `fetchTextBodyValues`, `fetchHTMLBodyValues`
and `fetchAllBodyValues` ask for, decoded to text, each cut at
`maxBodyValueBytes` bytes of UTF-8 — the client's, or the server's limit
when the client asks for more or for none — on a character boundary;
`isTruncated` says so. All the values of one request together are cut at
`maxBodyValuesTotal`. A charset the text does not decode in is
`isEncodingProblem: true`, with what it decodes to.

`preview` is the first 256 characters of the first text body, white space
collapsed, HTML tags dropped.

With `ids: null`, the account's emails are returned when there are at most
`maxObjectsInGet`; past that it is `requestTooLarge`.

### Email/query

Conditions: `inMailbox`, `inMailboxOtherThan`, `before` and `after`
(on `receivedAt`), `minSize` and `maxSize`, `hasKeyword` and
`notKeyword` (without case), and text: `from`, `to`, `cc`, `bcc` and `subject` match the
decoded header, `body` the text parts (the first MiB of each, HTML tags
dropped), `text` all of those. Matching is a case-folded substring. `AND`,
`OR` and `NOT` nest 16 deep, 256 conditions at most. Any other condition —
`header`, `hasAttachment`, the thread keywords — is `unsupportedFilter`.

Sorts: `receivedAt`, `size`, `from` and `to` (the first address's name,
else its address), `subject` (without `Re:`, `Fwd:` and the like), then
by id. Without `sort`, newest `receivedAt` first. `collapseThreads` keeps
the first email of each thread.

The store has no index, so the query runs here: it reads the candidates —
the mailbox's messages when the filter names `inMailbox` at its top or
under an `AND`, else the account's — at most `maxQueryScan` of them, and
reads an email's header or text only when a condition or a sort needs it.
Past `maxQueryScan` it is `requestTooLarge`. `limit` is capped at
`maxObjectsInGet`, and the answer says `limit` when it was.
`canCalculateChanges` is false: there is no `Email/queryChanges` yet.

### Email/set

- **update** changes `keywords` and `mailboxIds`, whole
  (`"keywords": { "$seen": true }`) or one key at a time
  (`"keywords/$seen": true`, `"mailboxIds/<id>": null`), not both for one
  property. A mailbox change links the email into its new mailboxes, then
  takes it out of the old ones, keeping its id: a move. An email in no
  mailbox is `invalidProperties`.
- **destroy** removes the email from every mailbox.
- **create** takes `blobId`, `mailboxIds`, `keywords` and `receivedAt`,
  as `Email/import` does. Building an email from `from`, `subject` and
  `bodyStructure` is not supported yet.

### Email/import

`emails` maps creation ids to `{ blobId, mailboxIds, keywords?,
receivedAt? }`. The blob is an upload, or any blob of the account. Every
entry is checked before any is imported: a creation id that is not an
id, or an entry that is not an object, refuses the whole call with
`invalidArguments`, and nothing is created. Every mailbox an entry names
must be one of the account's, or that entry is `invalidProperties` on
`mailboxIds` and nothing of it is stored; the same holds for a create of
`Email/set`. The email is added to its first mailbox, then linked into
the others; the answer holds `id`, `blobId`, `threadId` and `size`.

## Threads

`Thread/get` answers each thread's `emailIds`, oldest `receivedAt`
first. The store gives each message a `threadId` but no way to list a
thread, so the account's emails are read, at most `maxQueryScan`. A
message is its own thread unless the code that adds it passes a
`threadId`: nothing groups replies by `In-Reply-To` yet.

## Blobs

`POST {basePath}/upload/{accountId}` reads the body — at most
`maxSizeUpload` bytes, the route's `bodyLimit`, held as the API's is — and
answers `201 { accountId, blobId,
type, size }`. The type is the `Content-Type` without its parameters, or
`application/octet-stream`. The `blobId` is the SHA-256 of the bytes, as
the store names a message's content, so the same bytes uploaded twice are
one upload, and an email imported from them has that `blobId`. An upload
is kept in memory for `uploadTtl` seconds; an account holds at most
`uploadQuota` bytes of them at once.

`GET {basePath}/download/{accountId}/{blobId}/{name}?accept={type}`
serves:

- an upload of the account;
- a message's content, by the email's `blobId`;
- one part of a message, by the part's `blobId`: the email's, `_`, and
  the `partId` with `-` for `.` — `…_1-2` for part `1.2` — decoded from
  its transfer encoding.

`accept`, when it is a media type, is the `Content-Type`; else the part's
or the upload's type, else `application/octet-stream`. `name`, cut to
255 code points, is the file name in `Content-Disposition`: `inline` for
`image/png`, `image/jpeg`, `image/gif`, `image/webp` and `text/plain`,
`attachment` for every other type, HTML and SVG included. Every download
carries `X-Content-Type-Options: nosniff` and `Content-Security-Policy:
default-src 'none'; sandbox`, so a blob never runs as a page of the
server's origin.

A `multipart/*` part with no `boundary` parameter cannot be split (RFC
2046 §5.1.1 requires it): it is one opaque part, with a `partId` and a
`blobId`, listed in `attachments`, and its body is its content.

One `Range: bytes=` range is served as a 206. A range that starts at or
past the end, ends before it starts, or is `bytes=-0` is a 416 with
`Content-Range: bytes */size`, `Cache-Control: no-store`, no body, and
none of the blob's headers. Several ranges, or a header that is not one,
are ignored and the blob served whole as a 200; so is a suffix range of
an empty blob, such as `bytes=-5` (satisfiable by RFC 9110 §14.1.1, so
not a 416, and ignored as §14.2 allows). An `accountId` other than the
authenticated one, or a blob the account does not have, is a 404.

## States and changes

The store has one modseq per account, which moves with every change; it
is the state of Mailbox, Email and Thread alike, as a string. The store
has no call for it alone, so it is read from the mailbox changes since 0.
`/changes` passes `sinceState` to the store: one it never gave, or has
forgotten, is `cannotCalculateChanges`, and the client starts again from
`/get`. `maxChanges` pages the answer. `Mailbox/changes` says
`updatedProperties: null`: the store does not say which changed.

`ifInState` on a `/set` or `Email/import` is compared with the state when
the call starts: a mismatch is `stateMismatch`. A change made by another
writer between that check and the call's own changes is not caught.

## Limits

| limit | default | broken by | answer |
| --- | --- | --- | --- |
| `maxSizeRequest` | 10 000 000 | an API body | 413 problem `limit` |
| `maxJsonDepth` | 64 | nesting | 400 problem `limit` |
| `maxJsonTokens` | 100 000 | keys, values and brackets | 400 problem `limit` |
| `maxCallsInRequest` | 16 | method calls | 400 problem `limit` |
| `maxConcurrentRequests` | 4 | API requests of one account in flight | 429 problem `limit` |
| `maxObjectsInGet` | 500 | ids of a `/get`; a query's page | `requestTooLarge`; `limit` capped |
| `maxObjectsInSet` | 500 | creates, updates and destroys of a `/set`; emails of an import; `createdIds` | `requestTooLarge`; 400 problem `notRequest` |
| `maxReferenceItems` | 5000 | values of one back-reference | `invalidResultReference` |
| `maxReferenceBytes` | 4 MiB | bytes of JSON all the back-references of a request resolve to | `invalidResultReference` |
| `maxSizeResponse` | 64 MiB | bytes of JSON of one API response | 400 problem `limit` |
| `maxQueryScan` | 10 000 | emails a query, a thread lookup, a search or a `Mailbox/get` count reads | `requestTooLarge`; the store's counts |
| `maxBodyValueBytes` | 1 MiB | one body value | cut, `isTruncated` |
| `maxBodyValuesTotal` | 16 MiB | body values of one request | cut, `isTruncated` |
| `maxSizeUpload` | 25 MiB | one upload | 413 problem `limit` |
| `maxConcurrentUpload` | 4 | uploads of one account in flight | 429 problem `limit` |
| `uploadQuota` | 100 MiB | uploads one account holds | 413 problem `limit` |
| `uploadTtl` | 3600 s | — | the upload is forgotten |

Each is a positive integer; `jmap()` refuses another value, and one past
its ceiling. `hookTimeout` (30 s) is at most 2 147 483 seconds, what
`setTimeout` can wait.

Fixed bounds: a method name, a call id and a capability name are at most
255 characters, `using` at most 64 names; a `path` is at most 1024
characters and 32 segments; `properties` at most 256 names; `sort` at
most 16 comparators; a text condition at most 1024 characters; an
`Authorization` header at most 8 KiB. Ids are `[A-Za-z0-9_-]{1,255}`
(RFC 8620 §1.2); anything else is `invalidArguments`, or a 404 in a URL.
Client text repeated in an error — a name, an argument, a property — is
cut after 100 characters, its control characters left out; a store's
message after 200.

## onError

`onError(error, { request, accountId?, method? })` is told of what went
wrong outside the client's control:

| error | when | the client gets |
| --- | --- | --- |
| `JmapError` `HOOK_TIMEOUT` | `authenticate` did not settle within `hookTimeout` | 503 |
| what `authenticate` threw | | 503 |
| `TypeError: authenticate must answer an account id, or null` | it answered something else | 503 |
| `Error: authenticate answered the account "…", which the store does not have` | | 503 |
| what `secure` threw | | the request is taken as clear |
| what a store call threw, with `method` | during a method | `serverFail` for that call |

A client that hangs up while sending an API or upload body is not an
error: `onError` is not told, alxia logs nothing, and the host app's
`onResponse` sees a 499 with no body.

## The OpenAPI document

`openapi/jmap.json`, exported as `@bumail/jmap/openapi.json`, is an
OpenAPI 3.1 document of the four routes `jmap()` adds. It is written by
hand, as documentation and a contract: the server never reads it, and
validates nothing against it. Its `info.version` is the version of the document, not
of the package.

```ts
import document from '@bumail/jmap/openapi.json' with { type: 'json' };

// Serve it beside the server, for a viewer or a client generator:
app.get('/openapi.json', ({ reply }) => reply(200, document));
```

| operation | path | what it describes |
| --- | --- | --- |
| `getSession` | `GET /.well-known/jmap` | the Session object: the core capability with its limits, the account and its mail capability, the URLs |
| `api` | `POST /api` | the Request and Response envelopes; the 400 problems `notJSON`, `notRequest`, `unknownCapability` and `limit`; the 413 and 429 `limit` problems |
| `download` | `GET /download/{accountId}/{blobId}/{name}` | `accept`, `Range`, the 200 and 206 with their headers, the 404 and the 416 |
| `upload` | `POST /upload/{accountId}` | the 201 `{ accountId, blobId, type, size }`, the 404, the 413 `maxSizeUpload` and `uploadQuota` problems, the 429 |

Every operation also answers the 401, 403 and 503 of
[Authenticating](#authenticating), under the `basic` and `bearer`
security schemes; `basic` says that a clear request is refused.

**`basePath`.** The session is at the root of the document's server,
`{origin}`. The other three paths have their own server,
`{origin}{basePath}`, whose `basePath` variable defaults to `/jmap`: a
server mounted with `basePath: '/mail/v1'` is described by the same
document with that variable set. The limits it states are the defaults;
the session announces the ones in effect.

**Why the method calls are generic.** An Invocation is a `prefixItems`
tuple, `[name, arguments, callId]`, and the arguments are an object whose
`#`-prefixed keys are ResultReferences. A per-method schema would be
wrong twice: an argument may be a back-reference, so it is only known once
the calls before it ran (RFC 8620 §3.7), and a method that fails answers
`["error", { type }, callId]` inside the 200 (RFC 8620 §3.6.2), which the
document describes as `ErrorResponse`, with every `type` the server sends.
RFC 8620 and RFC 8621 define each method's arguments.

**Kept in step.** `src/server/openapi.spec.ts` turns the document into the
operations `@alxia/openapi` reads — method, full path, and
`schema.detail.operationId` — and runs its `matchesSpec`, with `strict: true`, against a real
`jmap()` mounted in a host app, with the default `basePath` and another:
a route added without a document entry fails it, and so does an entry
with no route. It also checks that the document is OpenAPI 3.1 and that
every `$ref` resolves, that its schemas use only the keywords the spec's
checker reads, and that a real session, an API response with an `error`,
an upload, four problems and a download's 200, 206 and 416 fit the
document: each header it declares for that status is sent, with its
value where the document fixes one, and each JSON body fits its schema.

## RFCs followed, and what is not

- **RFC 8620** — the session (§2), the request and response (§3.3,
  §3.4), back-references (§3.7), request-level errors as RFC 7807
  problems (§3.6.1), method-level errors (§3.6.2), `Core/echo` (§4),
  `/get`, `/changes`, `/set` and `/query` (§5.1–§5.3, §5.5), upload and
  download (§6.1, §6.2). Not yet: `/copy`, `/queryChanges`, `Blob/copy`,
  push (§7).
- **RFC 8621** — Mailbox (§2), Thread/get (§3.1), Email/get, /changes,
  /query, /set and /import (§4.2–§4.4, §4.6, §4.8), with §4.1.4's body
  algorithm. Not yet: `Thread/changes`, `Email/queryChanges`,
  `Email/copy`, `Email/parse`, `SearchSnippet`, `Identity`,
  `EmailSubmission`, `VacationResponse`.

The specs beside the code are built on the RFCs' own examples, each named
by its section: RFC 8620 §3.3.1's three calls, §3.7's query, threads and
emails in one request, §4.1's `Core/echo`, §3.6.1's problems, RFC 8621
§2.6's `mailboxHasEmail`. They run on the memory store and on
`@bumail/store/sqlite`, through the host app's `fetch`, and against
[jmap-jam](https://www.npmjs.com/package/jmap-jam), a JMAP client on npm,
over a socket.
