# Troubleshooting: configuration and onError

What `jmap()` throws, what `notify` throws, and the errors `onError`
receives. The [index](../troubleshooting.md) lists every entry of every
page.

## `JmapError: jmap(): the options must be an object`

`jmap()` was called with nothing, or with something that is not an object.

```ts
jmap({ store, origin: 'https://mail.example.com', authenticate });
```

## `JmapError: jmap(): store must be a MailStore, such as new MemoryMailStore()`

`store` is where the mail is: an object with the `MailStore` methods of
`@bumail/store`. Pass the store itself, not a promise of it, nor its class.

```ts
import { MemoryMailStore } from '@bumail/store';
import { SqliteMailStore } from '@bumail/store/sqlite';

jmap({ store: new MemoryMailStore(), … });
jmap({ store: SqliteMailStore.open({ directory: '/var/lib/bumail' }), … });
```

## `JmapError: jmap(): authenticate must be a function: it is how clients log in`

Without `authenticate` no request could be served. It answers the account
id to serve, or `null`:

```ts
authenticate: async (credentials) =>
	credentials.scheme === 'bearer' ? await accountOfToken(credentials.token) : null,
```

## `JmapError: jmap(): … must be a function`

`secure` or `onError` was given, but not as a function.

```ts
jmap({ …, onError: (error, { method }) => console.error(method, error) });
```

## `JmapError: jmap(): origin must be an http: or https: origin, such as https://mail.example.com, not "…"`

`origin` is the public origin the session's URLs start with: a scheme, a
host and maybe a port — no path, no trailing text. A path belongs in
`basePath`.

```ts
jmap({ …, origin: 'https://mail.example.com', basePath: '/mail/jmap' });
```

## `JmapError: jmap(): basePath must be a path such as /jmap, with no trailing slash, not "…"`

`basePath` starts with `/`, has no trailing `/`, and its segments are
letters, digits, `.`, `_`, `~` and `-`.

## `JmapError: jmap(): limits must be an object`

`limits` holds the limits by name: `{ maxCallsInRequest: 32 }`.

## `JmapError: jmap(): limits.… is not a limit`

A key of `limits` that names no limit — often a typo, or a session
property that is not settable (`collationAlgorithms`). The limits are in
the [guide](../guide.md#limits).

## `JmapError: jmap(): … must be a positive integer, not …`

A limit or `hookTimeout` is 0, negative, fractional or not a number. Leave
it out for its default.

## `JmapError: jmap(): … must be at most …, not …`

A limit past its ceiling. `uploadTtl` and `hookTimeout` are at most
2 147 483 seconds, what `setTimeout` can wait; the other ceilings keep a
mistyped value from turning a limit off.

## `TypeError: notify(accountId): accountId is a string`

`notify` was given something other than an account id.

```ts
server.notify(message.accountId);
```

## `JmapError: authenticate did not settle within hookTimeout (… s)`

`onError` gets this when `authenticate` neither resolved nor rejected in
`hookTimeout` seconds (30 by default). The client got a 503
`Temporary authentication failure`. Make the lookup faster, give it a
timeout of its own, or raise `hookTimeout`.

## `Error: authenticate answered the account "…", which the store does not have`

`onError` gets this when `authenticate` answered an id that
`store.getAccount` does not know: an id from another store, a login
instead of an id, an account deleted since. The client got a 503.

```ts
const account = await store.findAccount(username);
return account?.id ?? null;
```

## `TypeError: authenticate must answer an account id, or null`

`onError` gets this when `authenticate` answered something other than a
non-empty string, `null` or `undefined` — an account object, a boolean.
The client got a 503. Answer `account.id`.

## `Error: The store has no content for the email "…"`

`onError` gets this, with the `method`, when `Email/get` needed an
email's content and `store.readContent` had none: the store lost a blob,
or a custom store does not answer `readContent` for the account that
holds the message. The client got `serverFail` for that call.
