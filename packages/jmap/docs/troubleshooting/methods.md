# Troubleshooting: method errors

What one method call answers when it fails: `["error", { "type": …,
"description"?: … }, "<callId>"]` (RFC 8620 §3.6.2). The other calls of
the request still run; a call that refers to a failed one gets
`invalidResultReference`. Each entry is headed by the `type`, and the
`description` where there is one. The [index](../troubleshooting.md)
lists every entry of every page.

## `unknownMethod`

The method is not one this server answers, or its capability is not in
`using`: `Mailbox/…`, `Email/…` and `Thread/…` need
`urn:ietf:params:jmap:mail`, `Core/echo` needs
`urn:ietf:params:jmap:core`. The methods are listed in the
[README](../README.md#what-it-answers); `Email/queryChanges`, `Thread/changes`,
`Identity/…`, `EmailSubmission/…`, `SearchSnippet/get` and
`VacationResponse/…` are later slices.

## `accountNotFound`

`accountId` is not the authenticated account's. A request reaches only
the account `authenticate` answered, whatever id it names, so another
account's id is not found, even when it exists.

## `invalidArguments` — `accountId is required`

Every method but `Core/echo` takes the account: use the session's
`primaryAccounts["urn:ietf:params:jmap:mail"]`.

## `invalidArguments` — `Unknown argument "…"`

The method does not take that argument: a typo, or one this server does
not support yet (`Mailbox/query`'s are listed in the guide).

## `invalidArguments` — `… must be an array of ids`

`ids` is neither an array nor `null` (`null` asks for every object, where
the method allows it). Send `["id1", "id2"]`.

## `invalidArguments` — `… holds "…", which is not an id`

An id is not `[A-Za-z0-9_-]{1,255}` (RFC 8620 §1.2) nor `#` and a
creation id of that syntax. Ids come from the server: send them back as
they came.

## `invalidArguments` — `… must be an array of at most 256 property names`

`properties` or `bodyProperties` is not an array, or is longer than 256.

## `invalidArguments` — `… names "…", which is not a property`

A property this object does not have. For an Email, a `header:` property
must be `header:{name}[:{form}][:all]` with a field name of printable
ASCII and one of the forms `asRaw`, `asText`, `asAddresses`,
`asGroupedAddresses`, `asMessageIds`, `asDate`, `asURLs`.

## `invalidArguments` — `… must be a boolean`

`fetchTextBodyValues`, `fetchHTMLBodyValues`, `fetchAllBodyValues`,
`onDestroyRemoveEmails` or `collapseThreads` is not `true` or `false`.

## `invalidArguments` — `… must be an unsigned integer`

`maxChanges`, `limit` or `maxBodyValueBytes` is negative, fractional or
not a number.

## `invalidArguments` — `… must be an integer`

`position` or `anchorOffset` is fractional or not a number.

## `invalidArguments` — `… must be a string`

`anchor` is not a string.

## `invalidArguments` — `… must be an object`

`create`, `update`, one of their entries, or `emails` is not an object.

## `invalidArguments` — `create has "…", which is not a creation id`

A creation id is not `[A-Za-z0-9_-]{1,255}`.

## `invalidArguments` — `destroy must be an array of ids`

`destroy` is not an array of strings.

## `invalidArguments` — `update has "…", which is not an id`

A key of `update` is neither an id, `[A-Za-z0-9_-]{1,255}` (RFC 8620
§1.2), nor `#` and a creation id of that syntax. Send the ids the server
gave, as they came:

```json
["Email/set", { "accountId": "…", "update": { "M1a2b3": { "keywords/$seen": true } } }, "c1"]
```

## `invalidArguments` — `destroy holds "…", which is not an id`

An item of `destroy` is neither an id nor `#` and a creation id. The
id is repeated cut after 100 characters: an id is at most 255
characters of `[A-Za-z0-9_-]`, so a longer one is never one the server
gave.

## `invalidArguments` — `emails["…"] is not an EmailImport`

An `Email/import` entry is not an object, or its creation id is not an
id. Every entry is checked before any is imported, so nothing of the
call was created: fix the entry and send the whole call again.

## `invalidArguments` — `Both "…" and "#…" are given`

A call gave an argument and a back-reference for it. Give one.

## `invalidArguments` — `maxChanges must be more than 0`

Leave `maxChanges` out for no limit.

## `invalidArguments` — `sort must be an array of at most 16 comparators`

`sort` is not an array, or holds more than 16 comparators: no query
needs more. Send `[{ "property": "receivedAt", "isAscending": false }]`.

## `invalidArguments` — `A comparator is an object with a property`

Each comparator is `{ "property": "receivedAt", "isAscending": false }`.

## `invalidArguments` — `isAscending must be a boolean`

A comparator's `isAscending` is `"true"` or `1`: send `true` or `false`,
or leave it out for ascending.

## `invalidArguments` — `A filter is an object`

`filter`, or a condition inside an operator, is not an object.

## `invalidArguments` — `A FilterOperator has an operator and conditions only`

An operator is `{ "operator": "AND", "conditions": [ … ] }`, nothing
more: a condition beside `operator` is not read, so it is refused.

## `invalidArguments` — `sortAsTree and filterAsTree are not supported yet`

`Mailbox/query` with either set to `true`. Sort the tree on the client
from `parentId`.

## `invalidResultReference` — `No earlier call has the id "…"`

`resultOf` names a call id that no call before this one has.

## `invalidResultReference` — `The call "…" answered "…", not "…"`

The call `resultOf` names answered another method than `name` — often
`error`, when that call failed: look at its response first.

## `invalidResultReference` — `A ResultReference is an object of resultOf, name and path`

A `#argument` is not `{ "resultOf": …, "name": …, "path": … }` with
three strings.

## `invalidResultReference` — `The path "…" does not start with "/"`

A `path` is a JSON Pointer: `/ids`, `/list/*/threadId`.

## `invalidResultReference` — `The path "…" names nothing in the result`

The pointer reached a key the result does not have, an index past an
array's end, an index written with a leading zero, or `*` on something
that is not an array.

## `invalidResultReference` — `The path is longer than 1024 characters`

A back-reference's `path` is past 1024 characters. Real paths are short:
`/ids`, `/list/*/threadId`.

## `invalidResultReference` — `The path has more than 32 segments`

A back-reference's `path` has more than 32 `/`-separated segments; no
JMAP response nests that deep.

## `invalidResultReference` — `The reference expands to more than … values`

The pointer, `*`s expanded, gives more values than `maxReferenceItems`.
Page the earlier call with `limit`.

## `invalidResultReference` — `The references of this request resolve to more than … bytes`

Everything the back-references of one request resolved to, counted as
JSON, went past `maxReferenceBytes` (4 MiB by default). A path of `''`,
or to an object, counts whole: chaining `Core/echo` calls on each other
cannot double the response at each step. Point the reference at what the
call needs (`/ids`, `/list/*/id`) rather than at a whole response, page
the earlier call with `limit`, or raise `limits.maxReferenceBytes`:

```ts
jmap({ store, origin, authenticate, limits: { maxReferenceBytes: 16 * 1024 * 1024 } });
```

## `requestTooLarge` — `… holds more than … ids`

More ids than the session's `maxObjectsInGet` in one `/get`. Split it.

## `requestTooLarge` — `The account has more than … mailboxes: ask for ids`

`Mailbox/get` with `ids: null` on an account with more mailboxes than
`maxObjectsInGet`. Query, then get by ids.

## `requestTooLarge` — `The account has more than … emails: ask for ids`

`Email/get` with `ids: null` on an account with more emails than
`maxObjectsInGet`. Use `Email/query`.

## `requestTooLarge` — `Thread/get needs ids`

`Thread/get` with `ids: null`: there is no listing of every thread.

## `requestTooLarge` — `The call creates, updates and destroys more than … objects`

A `/set` past `maxObjectsInSet`. Split it.

## `requestTooLarge` — `emails holds more than … emails`

An `Email/import` past `maxObjectsInSet`. Split it.

## `cannotCalculateChanges` — `The state is not one this server gave`

`sinceState` is not a state this server answered — not a number, or one
ahead of the account. Start again from `/get`.

## `cannotCalculateChanges`

Without a description: the store no longer remembers the changes since
that state (a store created with `maxTombstones`). Start again from
`/get`, whose `state` is the next `sinceState`.

## `stateMismatch` — `The account has changed since ifInState`

The account's state is not the `ifInState` given: something changed it
since the client read that state. Fetch the changes, then decide again.

## `anchorNotFound`

The `anchor` of a query is not among its results. Query from `position`
instead, or with an anchor still in the results.

## `unsupportedSort` — `Sorting by "…" is not supported`

`Mailbox/query` sorts by `sortOrder` and `name`; `Email/query` by
`receivedAt`, `size`, `from`, `to` and `subject` (the session's
`emailQuerySortOptions`).

## `unsupportedSort` — `Only the i;unicode-casemap collation is supported`

Leave `collation` out, or give the one the session's
`collationAlgorithms` lists.

## `unsupportedFilter` — `The filter "…" is not supported`

A condition this server does not evaluate, or one with a value of the
wrong type: `header`, `hasAttachment`, `allInThreadHaveKeyword`,
`someInThreadHaveKeyword`, `noneInThreadHaveKeyword` for emails; a
`before` that is not a date, a `text` longer than 1024 characters, a
keyword that is not one.

## `unsupportedFilter` — `operator is AND, OR or NOT`

A FilterOperator's `operator` is another string, or lower case. Send
`"AND"`, `"OR"` or `"NOT"`.

## `unsupportedFilter` — `Operators nest deeper than 16`

FilterOperators inside FilterOperators past 16 levels. Flatten the
filter: `AND` inside `AND` is one `AND`.

## `unsupportedFilter` — `The filter holds more than 256 conditions`

The filter, every operator and condition counted, has more than 256
nodes. Split the query, or use `inMailbox` and fewer conditions.

## `tooLarge` — `The query would read more than … emails: the store has no index yet`

The mailbox (or the account, without `inMailbox`) holds more emails than
`maxQueryScan`: queries run in memory until the store has an index. Put
`inMailbox` at the top of the filter, or raise `limits.maxQueryScan`.

## `tooLarge` — `The query reads more than … emails`

The query's conditions or sort read more emails' content than
`maxQueryScan`.

## `tooLarge` — `The account has more than … emails: the store has no thread index yet`

`Thread/get` reads the account's emails to find a thread's: past
`maxQueryScan`, it refuses.

## `tooLarge` — `Counting threads would read more than … emails: leave totalThreads and unreadThreads out`

`Mailbox/get` counts a mailbox's threads by listing its emails, since
the store keeps no thread counts. The mailboxes asked for hold more
emails, together, than `maxQueryScan`. Ask for the properties you need
without `totalThreads` and `unreadThreads`, ask for fewer mailboxes, or
raise `limits.maxQueryScan`:

```json
["Mailbox/get", { "accountId": "…", "properties": ["name", "role", "totalEmails", "unreadEmails"] }, "c1"]
```

## `serverFail`

Something failed that is not the client's doing: the store threw, or a
blob was missing. `onError` has the error, with the method's name; the
client may retry.
