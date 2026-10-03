# Troubleshooting: configuration and onError

What `createImapServer` and `listen` throw, and the errors `onError`
receives. The [index](../troubleshooting.md) lists every entry of every
page.

## `ImapError: createImapServer(): "…" is not a host name`

`hostname` is the name the greeting announces: letters, digits, dots and
dashes, such as `imap.example.com`. An address, a URL or a name with a
space is refused.

```ts
createImapServer({ hostname: 'imap.example.com', … });
```

## `ImapError: createImapServer(): store must be a MailStore, such as new MemoryMailStore()`

`store` is where the mail is: an object with the `MailStore` methods of
`@bumail/store`. Pass the store itself, not a promise of it.

```ts
import { MemoryMailStore } from '@bumail/store';
createImapServer({ store: new MemoryMailStore(), … });
```

## `ImapError: createImapServer(): authenticate must be a function: it is how users log in`

Without `authenticate` no one could log in. It answers the account id to
serve, or `null`:

```ts
authenticate: async ({ username, password }) =>
	(await check(username, password)) ? accountIdOf(username) : null,
```

## `ImapError: createImapServer(): tls: { key, cert } is required, since LOGIN is offered only once encrypted`

LOGIN and AUTHENTICATE are refused on a clear connection, so a server
without TLS would log no one in. Give it a key and a certificate, both
non-empty:

```ts
tls: {
	key: await Bun.file('/etc/ssl/imap.example.com.key').text(),
	cert: await Bun.file('/etc/ssl/imap.example.com.crt').text(),
},
```

For a local try, a self-signed certificate for `localhost` does; the
client asks you to accept it.

## `ImapError: createImapServer(): … must be a positive integer, not …`

`maxConnections`, `maxMessageSize`, `maxLiteralSize`, `timeout`,
`loginTimeout` and `hookTimeout` are whole numbers above 0. Seconds for the
timers, bytes for the sizes.

## `ImapError: createImapServer(): … must be at most …, not …`

A timer is at most 2 147 483 seconds: past 2^31 − 1 milliseconds,
`setTimeout` fires after one millisecond, and every client would be cut at
once. `maxMessageSize` is at most 4 294 967 295, the largest literal IMAP
can announce.

## `ImapError: createImapServer(): timeout must be at least 1800 seconds (RFC 9051 §5.4), not …`

RFC 9051 §5.4 says a server's inactivity timer is at least 30 minutes:
clients count on it between two NOOPs. Use 1800 or more; to cut clients
that never log in, set `loginTimeout` instead.

## `ImapError: createImapServer(): idleInterval must be a number of seconds, more than 0 and at most 2147483, not …`

`idleInterval` is how often an IDLE session looks at the store. It may be
a fraction (`0.5`), but not 0. To have new mail arrive at once, call
`server.notify(accountId)` rather than polling faster.

## `ImapError: listen(): the server is already listening on …`

A server listens once. For 143 and 993, create two servers from the same
options, the second with `implicitTls: true`.

## `ImapError: authenticate did not settle within hookTimeout (… s)`

`onError` gets this when `authenticate` neither resolved nor rejected in
`hookTimeout` seconds (60 by default); the client got
`NO [UNAVAILABLE] Temporary authentication failure`. Look for a lookup
with no timeout of its own, or raise `hookTimeout`.

## `Error: authenticate answered the account "…", which the store does not have`

`onError` gets this when `authenticate` answered a string that is not the
id of an account in `store`; the client got
`NO [UNAVAILABLE] Temporary authentication failure`, and the login does
not count as a failed one. The usual cause is answering the address, or
your own user id, instead of the store's account id:

```ts
const account = await store.createAccount('alice@example.com');
accounts.set('alice', account.id); // the id, not 'alice@example.com'

authenticate: async ({ username, password }) =>
	(await check(username, password)) ? (accounts.get(username) ?? null) : null,
```

A store the hook was not written for — a test's `MemoryMailStore` while
the hook reads production ids — does the same.
