# Troubleshooting: requests, uploads and downloads

The problems a whole request is refused with (RFC 8620 §3.6.1), as RFC
7807 bodies: `{ "type": …, "status": …, "detail": …, "limit"?: … }` with
`Content-Type: application/problem+json`. No method call ran. Each entry
is headed by the `type` and the `detail`; for a `limit`, the `limit`
property names the limit. The [index](../troubleshooting.md) lists every
entry of every page.

## `urn:ietf:params:jmap:error:notJSON` — `The request body is not UTF-8`

The API body has bytes that are not UTF-8 (RFC 8259 §8.1). Send the JSON
encoded as UTF-8.

## `urn:ietf:params:jmap:error:notJSON` — `The request body is not JSON`

The body is UTF-8 but not JSON: cut short, a trailing comma, single
quotes, an empty body. Send `JSON.stringify` of the request.

## `urn:ietf:params:jmap:error:notRequest` — `The request is not a JSON object`

The JSON is an array, a string or a number. A request is an object with
`using` and `methodCalls`.

## `urn:ietf:params:jmap:error:notRequest` — `using is not an array of capability names`

`using` is missing, not an array, holds something other than a non-empty
string of at most 255 characters, or holds more than 64 names.

```json
{ "using": ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"], "methodCalls": [] }
```

## `urn:ietf:params:jmap:error:notRequest` — `methodCalls is not an array`

`methodCalls` is missing or not an array.

## `urn:ietf:params:jmap:error:notRequest` — `methodCalls[…] is not an array of a name, arguments and a call id`

Each call is a three-item array: `["Mailbox/get", { "accountId": "…" }, "c1"]`.

## `urn:ietf:params:jmap:error:notRequest` — `methodCalls[…] has no method name of 1 to 255 characters`

The first item of a call is empty, not a string, or longer than 255
characters.

## `urn:ietf:params:jmap:error:notRequest` — `methodCalls[…]'s arguments are not an object`

The second item of a call is an array, `null` or a scalar. A call with no
arguments has `{}`.

## `urn:ietf:params:jmap:error:notRequest` — `methodCalls[…] has no call id of at most 255 characters`

The third item of a call is not a string, or is longer than 255
characters: the response repeats it, so it is bounded.

## `urn:ietf:params:jmap:error:notRequest` — `createdIds is not an object`

`createdIds`, when given, maps creation ids to ids: `{ "k1": "id1" }`.

## `urn:ietf:params:jmap:error:notRequest` — `createdIds holds more than … ids`

`createdIds` holds more entries than `maxObjectsInSet`. Send only the
creation ids the request refers to.

## `urn:ietf:params:jmap:error:notRequest` — `createdIds["…"] is not a creation id and an id`

A key or a value of `createdIds` is not a string of 1 to 255 characters.

## `urn:ietf:params:jmap:error:unknownCapability` — `The server does not support the capability "…"`

A name in `using` is not `urn:ietf:params:jmap:core` or
`urn:ietf:params:jmap:mail`, the two this server knows. Read the session's
`capabilities` and send only those.

## `urn:ietf:params:jmap:error:limit` — `The request is larger than … bytes`

`limit: "maxSizeRequest"`, with a 413. The body is past the session's
`maxSizeRequest`; it was refused as soon as its `Content-Length` said so,
or cut while streaming past it. Split the request, or raise
`limits.maxSizeRequest`.

## `urn:ietf:params:jmap:error:limit` — `The JSON nests deeper than … levels`

`limit: "maxJsonDepth"`, with a 400. Objects and arrays nest past
`maxJsonDepth` (64): no JMAP request needs that, so the body is refused
before it is parsed.

## `urn:ietf:params:jmap:error:limit` — `The JSON holds more than … tokens`

`limit: "maxJsonTokens"`, with a 400. The body holds more keys, values and
brackets than `maxJsonTokens` (100 000), counted before it is parsed.
Split the request, or raise the limit.

## `urn:ietf:params:jmap:error:limit` — `The request makes more than … method calls`

`limit: "maxCallsInRequest"`, with a 400. Send at most the session's
`maxCallsInRequest` calls in one request.

## `urn:ietf:params:jmap:error:limit` — `The account has … requests in flight already`

`limit: "maxConcurrentRequests"`, with a 429. The account already has the
session's `maxConcurrentRequests` API requests running. Wait for one to
answer, then retry.

## `urn:ietf:params:jmap:error:limit` — `The upload is larger than … bytes`

`limit: "maxSizeUpload"`, with a 413. One upload is past the session's
`maxSizeUpload`.

## `urn:ietf:params:jmap:error:limit` — `The account has … uploads in flight already`

`limit: "maxConcurrentUpload"`, with a 429. Wait for an upload to finish.

## `urn:ietf:params:jmap:error:limit` — `The account holds … bytes of uploads already: use them or wait for them to expire`

`limit: "uploadQuota"`, with a 413. Uploads are held in memory until
`uploadTtl` passes; the account's together would go past `uploadQuota`.
Import what you uploaded, wait, or raise `limits.uploadQuota`.

## `404 No blob has this id`

A download named a blob the account does not have — never uploaded, an
upload past `uploadTtl`, an email destroyed since, another account's — or
an `accountId` other than the authenticated account's, or a `blobId`
that is not an id. The answer is the same for each, so it says nothing of
another account's mail.

## `404 No account has this id`

An upload named an `accountId` other than the authenticated account's.
Use the session's `primaryAccounts["urn:ietf:params:jmap:mail"]`.

## `404 {"error":"not_found"}`

alxia's answer for a path no route serves: the API is at `{basePath}/api`
(`/jmap/api` by default), and the session at `/.well-known/jmap` of the
app `jmap()` is mounted on, unprefixed. Read the URLs from the session.

The session's `eventSourceUrl` answers this too: RFC 8620 requires the
property, but push is a later slice and nothing serves it yet. Poll with
`/changes` until then.

## `405 {"error":"method_not_allowed"}`

alxia's answer for a route asked with the wrong method: the API and
uploads are `POST`, the session and downloads `GET` (and `HEAD`).
