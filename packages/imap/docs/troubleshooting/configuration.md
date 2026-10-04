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
`loginTimeout`, `handshakeTimeout` and `hookTimeout` are whole numbers
above 0. Seconds for the
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

## `ImapError: createImapServer(): proxyProtocol.trusted must list the addresses or CIDRs of the proxies, at least one`

`proxyProtocol` was given without `trusted`, with an empty list, or with
something other than an array. A list that trusts nobody would read no
header at all. Name the proxies' own addresses, or leave `proxyProtocol`
out to serve every peer directly:

```ts
proxyProtocol: { trusted: ['10.0.0.5'] },
```

## `ImapError: createImapServer(): proxyProtocol.trusted: "…" is neither an IP address nor a CIDR`

An entry of `trusted` is an IPv4 or IPv6 address (`10.0.0.5`,
`2001:db8::5`) or a CIDR (`10.0.0.0/24`, `2001:db8::/64`). A host name
such as `proxy.internal`, a trailing slash (`10.0.0.0/`) or two prefixes
(`10.0.0.0/8/8`) is refused, and so is an address with a zone
(`fe80::1%eth0`: a zone names an interface of this host, never a client): the list is compared with the peer's TCP
address, and no name is looked up. Write the address the server sees the
proxy connect from:

```ts
proxyProtocol: { trusted: ['10.0.0.5', '2001:db8::5'] },
```

## `ImapError: createImapServer(): proxyProtocol.trusted: "…" has a prefix length out of range`

A prefix is 0 to 32 for IPv4 and 0 to 128 for IPv6. An IPv4-mapped
network counts the 96 bits of its `::ffff:` part: `::ffff:10.0.0.0/8` is
refused, `::ffff:10.0.0.0/104` is `10.0.0.0/8`. Write the IPv4 form, which
an IPv4-mapped peer also matches:

```ts
proxyProtocol: { trusted: ['10.0.0.0/8'] },
```

## `ImapError: createImapServer(): proxyProtocol.trusted: "…" has a prefix length of 0, which trusts every peer`

`0.0.0.0/0`, `::/0` and `::ffff:0.0.0.0/96` match every peer, so any client
could send a PROXY header and claim any address. List the proxy's own
address, or the smallest network it is in:

```ts
proxyProtocol: { trusted: ['10.0.0.5'] }, // not '0.0.0.0/0'
```

## `ImapError: createImapServer(): proxyProtocol.trusted: … is not a string`

Every entry of `trusted` is a string. A number, or a list nested in the
list, is refused:

```ts
proxyProtocol: { trusted: ['10.0.0.5'] }, // not [10] nor [['10.0.0.5']]
```

## `ImapError: listen(): the server is already listening on …`

A server listens once. For 143 and 993, create two servers from the same
options, the second with `implicitTls: true`.

## `ImapError: listen(): the server is already starting to listen`

A second `listen` on the same server while the first has not resolved
yet: with `implicitTls`, `listen` reads the key and certificate before it
binds. Its `code` is `ALREADY_LISTENING`; the first call binds, this one
binds nothing. Await `listen` once per server.

## `ImapError: listen(): stop() was called before the server bound its port`

`stop()` ran before `listen` resolved: on an `implicitTls` server while it
reads the TLS key and certificate, on any other at once, since `listen`
resolves a tick after it binds. `listen` rejects with `code: 'STOPPED'` and
leaves nothing listening; a later `listen` binds as usual.
Nothing is wrong if the stop was meant.

## `ImapError: listen(): tls: { key, cert } cannot be used: …`

`listen` on an `implicitTls` server whose `tls.key` or `tls.cert` cannot
be read — a `Bun.file` that does not exist — or is not a PEM key or
certificate. The same error, word for word, with `proxyProtocol` or
without; its `code` is `INVALID_OPTION`, and the rest of the message, and
its `cause`, are the reason from the file system or `node:tls`. Nothing is
bound. Pass the PEM text, or a `Bun.file` of a path that exists:

```ts
const tls = {
	key: Bun.file('/etc/bumail/tls/privkey.pem'),
	cert: Bun.file('/etc/bumail/tls/fullchain.pem'),
};
await createImapServer({ ...options, tls, implicitTls: true }).listen({ port: 993 });
```

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
