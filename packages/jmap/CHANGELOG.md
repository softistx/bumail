# @bumail/jmap

## 0.4.0

### Minor Changes

- [#85](https://github.com/softistx/bumail/pull/85) [`6e68ec8`](https://github.com/softistx/bumail/commit/6e68ec8667c88eca458de679fa8157c744bd84d9) Thanks [@SteveGT96](https://github.com/SteveGT96)! - The `@alxia/core` peer moves on to `^0.10.0`, which a `^0.9.0` does not accept: upgrade `@alxia/core` and every other `@alxia/*` package your app uses with it. `authenticate(credentials, request, client)` and `secure(request, client)` get a last argument, and `onError`'s context a `client`: `{ ip, url }`, the host app's `ctx.ip` and `originalUrl(ctx)`, exported as `JmapClient`. Behind `alxia({ proxy: trustProxy(…) })` they are what the trusted proxies said — the forwarded client's address, one text per address, and the scheme the outermost proxy wrote — so `secure: (_request, client) => client.url.protocol === 'https:'` replaces reading `X-Forwarded-Proto` yourself. Hooks written for the old arguments keep working, and every answer is unchanged; code that calls the hooks itself through `JmapOptions`, or builds an `ErrorContext`, now passes the `client` too.

- [#83](https://github.com/softistx/bumail/pull/83) [`7f72784`](https://github.com/softistx/bumail/commit/7f727841f34553a595c47b37e3cf27a767eb070d) Thanks [@SteveGT96](https://github.com/SteveGT96)! - The `@alxia/core` peer moves from `^0.3.1` to `^0.7.0`, which drops 0.3: an app on `@alxia/core` 0.3 upgrades it, with every other `@alxia/*` package it uses, to take this release, and mounts the server with `app.plugin(jmap(…))` where it wrote `app.use(jmap(…))`, since `use` takes middlewares alone from `@alxia/core` 0.5 on. The routes' refusals are answered by a middleware of each route instead of the `onRefusal` hooks 0.5 removed; the server's routes, statuses, headers and bodies are unchanged. The OpenAPI spec checks the routes with `@alxia/openapi`'s `matchesSpec` under `strict: true`, both ways as before.

- [#84](https://github.com/softistx/bumail/pull/84) [`d218b39`](https://github.com/softistx/bumail/commit/d218b391f62bd3dc605c66bd1d6c8eac23ce5333) Thanks [@SteveGT96](https://github.com/SteveGT96)! - The `@alxia/core` peer moves on to `^0.9.0`, which a `^0.7.0` does not accept: upgrade `@alxia/core` and every other `@alxia/*` package your app uses with it. A request with the wrong method and no credentials, or wrong ones, is now a 401 with both challenges where it was a 405: alxia 0.9 runs the jmap group's authentication before it answers a 405, so its `Allow` names a route's methods to an authenticated client alone. With credentials, the 405 and its `Allow` are unchanged, as is every other answer.

## 0.3.2

### Patch Changes

- [#53](https://github.com/softistx/bumail/pull/53) [`1eb3835`](https://github.com/softistx/bumail/commit/1eb3835346331cd8e89a026e95c301818910d471) Thanks [@SteveGT96](https://github.com/SteveGT96)! - The `@alxia/core` peer range moves from `^0.3.0` to `^0.3.1`, whose `parseRange` answers a range of an empty file as RFC 9110 does, and the download no longer works around it. Downloads answer as before: a suffix range of an empty blob (`bytes=-5`) serves it whole as a 200, and `bytes=0-` or `bytes=-0` is a 416 with `Content-Range: bytes */0`. An app on `@alxia/core` 0.3.0 upgrades it to 0.3.1.

## 0.3.1

### Patch Changes

- Updated dependencies [[`4c22182`](https://github.com/softistx/bumail/commit/4c22182470c9fd13d1f78a5a3d14785667745c52)]:
  - @bumail/store@0.4.0

## 0.3.0

### Minor Changes

- [#44](https://github.com/softistx/bumail/pull/44) [`5ad9eac`](https://github.com/softistx/bumail/commit/5ad9eac0469840b988e4c39341d4bfd811399edc) Thanks [@SteveGT96](https://github.com/SteveGT96)! - The package ships an OpenAPI 3.1 document of its routes, `openapi/jmap.json`, exported as `@bumail/jmap/openapi.json`: the session and its Session object, `POST {basePath}/api` with the Request and Response envelopes (Invocations as `prefixItems` tuples, arguments described generically with `#` back-references, method errors inside the 200), the RFC 8620 problems as `application/problem+json` with their statuses, the download with its URI template parameters, `Range`, 206 and 416, the upload, and the Basic and Bearer schemes, Basic refused on a clear request. The API, download and upload sit under a server whose `basePath` variable defaults to `/jmap`. Its `info.version` is the document's own. It is documentation and a contract, not a validator: the server does not read it, and a spec checks it against the routes both ways with `@alxia/openapi-routes`, a devDependency only, and checks real answers' headers and bodies against it.
  
  Two answers change on the wire. A query, a text search or a `Thread/get` past `maxQueryScan` now answers the method error `requestTooLarge` instead of `tooLarge`, which RFC 8620 defines only as a SetError: a client that matched `tooLarge` matches `requestTooLarge`. A download's 416 is now `Cache-Control: no-store` and carries only `Content-Range` and `Accept-Ranges`, with no body and no `Content-Type`, no longer the blob's `immutable` caching and headers. A suffix range of an empty blob (`bytes=-5`) is ignored and the blob served whole as a 200, as RFC 9110 §14.2 allows (§14.1.1 makes it satisfiable, so not a 416), instead of a 206 with a malformed `Content-Range`.

## 0.2.0

### Minor Changes

- [#42](https://github.com/softistx/bumail/pull/42) [`0f49971`](https://github.com/softistx/bumail/commit/0f499710528a2d331236941f141a60f0845f7be9) Thanks [@SteveGT96](https://github.com/SteveGT96)! - The `@alxia/core` peer moves from `^0.2.1` to `^0.3.0`, which drops 0.2: an app on `@alxia/core` 0.2 upgrades it, with every other `@alxia/*` package it uses, to take this release. The server's routes, refusals and answers are unchanged.

### Patch Changes

- [#39](https://github.com/softistx/bumail/pull/39) [`7f9d036`](https://github.com/softistx/bumail/commit/7f9d036df3dc488d0d18718bd88c6815f1530a0f) Thanks [@SteveGT96](https://github.com/SteveGT96)! - A mailbox's `unreadEmails` and `unreadThreads` follow RFC 8621 §2: an email with `$seen` is read however the store keeps it — `\Seen`, or a `$Seen` keyword in any case — and an email with `$draft` (`\Draft` or a `$Draft` keyword) is never unread. They no longer come from the store's IMAP `unseen` count, which looks for `\Seen` alone; they are counted in the same pass over the mailbox as the thread counts, within `maxQueryScan`; past `maxQueryScan`, the store's `unseen` still stands in.

## 0.1.0

### Minor Changes

- [#32](https://github.com/softistx/bumail/pull/32) [`e35fae7`](https://github.com/softistx/bumail/commit/e35fae7e7c623fa0af0ea84f5d69c99b307d5a51) Thanks [@SteveGT96](https://github.com/SteveGT96)! - A new package: a JMAP server (RFC 8620 core, RFC 8621 mail) as an alxia app, peering on `@alxia/core` ^0.2.1 from npm (it needs 0.2.0's `bodyLimit`, `onRefusal` and `problem()`, and 0.2.1's exported refusal types, so its declarations name every type through `@alxia/core`), `@bumail/store` and `@bumail/mime`. `jmap({ store, origin, authenticate })` returns an app to `use` in a host alxia app: the session at `/.well-known/jmap`, and under `basePath` (`/jmap`) the API, blob download (with `Range`) and upload. Its routes authenticate first, through `authenticate`, which gets Basic or Bearer credentials and runs under `hookTimeout`; Basic is refused unread on a clear request unless `allowInsecureBasic` is set, and `secure` says what is clear behind a proxy. The API answers request-level errors as RFC 7807 problems (`notJSON`, `notRequest`, `unknownCapability`, `limit`) and method-level errors per call, resolves back-references (`#name` with `resultOf`, `name` and a JSON Pointer `path` with `*`) and `#creationId`s, and serves `Core/echo`, `Mailbox/get`, `/changes`, `/query` and `/set` (with `onDestroyRemoveEmails`), `Email/get` (the convenience headers, every `header:` form, `bodyStructure`, `textBody`, `htmlBody`, `attachments`, `bodyValues`, `preview`), `Email/query` (in memory, bounded by `maxQueryScan`: mailbox, keyword, date, size and text conditions with AND, OR and NOT; five sorts; paging by position or anchor), `Email/changes`, `Email/set` (keywords and mailboxIds, whole or patched; destroy; create from an uploaded blob), `Email/import` and `Thread/get`. Keywords compare without case: they are returned lowercased, two flags that differ only by case are one keyword, `hasKeyword` and `notKeyword` match a stored `$Forwarded` as `$forwarded`, and `Email/set` adds and removes a keyword whatever case the store kept it in, without duplicates. Uploads are held in memory with a TTL and a per-account quota. Every limit has a validated default, is announced in the session where RFC 8620 names it, and is enforced: the API and upload bodies are held to `maxSizeRequest` and `maxSizeUpload` as alxia `bodyLimit`s, a `Content-Length` past the limit refused unread and a chunked body cut at the first chunk past it, a path parameter that is not an id answered with the route's 404 problem through `onRefusal`, its JSON depth and token count are checked before parsing, calls, ids, set objects, back-reference expansion, uploads and requests in flight per account are capped, ids, `update` keys, `destroy` items and `#creationId`s are checked against RFC 8620's alphabet, every back-reference is charged to a per-request `maxReferenceBytes` budget and the whole response to `maxSizeResponse`, so chained references cannot amplify a request, `Email/import` checks every entry before importing any, and every mailbox of an email before storing it, downloads carry `nosniff` and a sandboxing CSP and are `inline` only for types that run nothing, an account never reaches another's data, and client text in an error is cut. `notify(accountId)` is reserved for push, which comes with queryChanges in the next slice.

### Patch Changes

- Updated dependencies [[`e5f50d4`](https://github.com/softistx/bumail/commit/e5f50d46a2c14aa2a9fec2f1574e66a90086a0c0), [`6960313`](https://github.com/softistx/bumail/commit/69603137a0dc546ef49a10ba5e171057d08b141a)]:
  - @bumail/mime@0.1.2
  - @bumail/store@0.3.0
