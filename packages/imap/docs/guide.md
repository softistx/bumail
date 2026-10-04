# Guide

- [Running the server](#running-the-server)
- [Logging in](#logging-in)
- [The session](#the-session)
- [Commands](#commands)
- [How the store appears over IMAP](#how-the-store-appears-over-imap)
- [Mailbox names and modified UTF-7](#mailbox-names-and-modified-utf-7)
- [New mail: IDLE and notify](#new-mail-idle-and-notify)
- [Limits and slow clients](#limits-and-slow-clients)
- [Running behind a TCP proxy](#running-behind-a-tcp-proxy)
- [Errors and onError](#errors-and-onerror)
- [Standards](#standards)

## Running the server

`createImapServer(options)` checks the options and returns a server;
`listen({ port, hostname? })` opens it, and resolves to the `{ port,
hostname }` it is bound to once the socket is open. `hostname` defaults
to `0.0.0.0`; port `0` asks the system for a free port, which the result
then names. One server listens once; run two for 143 and 993.

```ts
import { createImapServer } from '@bumail/imap';

const server = createImapServer({
	hostname: 'imap.example.com',
	store,                       // any @bumail/store MailStore
	tls: { key, cert },          // required
	authenticate: ({ username, password }) => checkPassword(username, password),
});
await server.listen({ port: 143 });

const implicit = createImapServer({ ...sameOptions, implicitTls: true });
await implicit.listen({ port: 993 });

// A free port, for a test:
const { port } = await createImapServer(sameOptions).listen({ port: 0 });

// Later:
server.connections; // the connections open now
server.stop();      // stop accepting; open sessions finish
server.stop(true);  // and close them
```

`tls` is required: LOGIN is refused on a clear connection, so a server
without TLS could log no one in. `implicitTls` is `false` by default: the
server starts in clear and offers `STARTTLS`, as on 143. With
`implicitTls: true` TLS starts with the first byte (RFC 8314), as on 993.

On implicit TLS the server counts a socket from the TCP connection on, not
from the end of its handshake: a socket that has not finished its
handshake holds a place under `maxConnections`, and is closed, without a
reply, `handshakeTimeout` seconds (default 10) after it connected, so
clients that open TCP connections and never send a ClientHello cannot fill
the server. The greeting, and the `BYE` of a server already full, wait for
the handshake, so the client reads them over TLS; `loginTimeout` starts
with the greeting. A handshake that fails — a clear client on 993 — is
closed at once and counted out. A STARTTLS handshake that stalls is
bounded by `loginTimeout` plus the 5-second close grace, the connection
already counted: at `loginTimeout` the server hangs up, and a hang-up
the client never completes is reset when the grace is over.

```ts
const implicit = createImapServer({
	...sameOptions,
	implicitTls: true,
	handshakeTimeout: 10, // seconds from the TCP connection to the end of the TLS handshake
});
```

Bun 1.4.2 calls a TLS listener's `open` only once the handshake completed
unless the listener has a `handshake` handler; with one, `open` comes at
the TCP connection and the socket's timer runs during the handshake. The
server sets one for that reason. That timer ticks in steps of about 4
seconds, so a stuck handshake is closed up to that much after
`handshakeTimeout`.

`server.connections` is the number of connections open at this moment,
logged in or not; `maxConnections` caps it.

## Logging in

`authenticate(credentials, session)` is asked for LOGIN and for
AUTHENTICATE PLAIN, only once TLS is on. It answers the id of the account
in the store to serve, or `null` (or `undefined`) to refuse.

```ts
async authenticate({ mechanism, username, password }, session) {
	const user = await users.find(username);
	if (!user || !(await Bun.password.verify(password, user.hash))) return null;
	session.data.plan = user.plan; // your own state, for onError and later hooks
	return user.accountId;
}
```

- `mechanism` is `LOGIN` or `PLAIN`. A PLAIN authorization identity other
  than the username is refused before the hook is asked.
- A refusal answers `NO [AUTHENTICATIONFAILED] Authentication failed`. The
  third failure on a connection closes it.
- A hook that throws, or does not settle within `hookTimeout` seconds, or
  names an account the store does not have, answers
  `NO [UNAVAILABLE] Temporary authentication failure` and goes to
  `onError`.
- On a clear connection the capabilities say `STARTTLS LOGINDISABLED`,
  with no `AUTH=`; LOGIN and AUTHENTICATE answer
  `NO [PRIVACYREQUIRED] Log in only once TLS is on: STARTTLS first`
  before reading a password. Once encrypted, `AUTH=PLAIN SASL-IR` is
  offered.

## The session

Each connection is a session, which `authenticate` and `onError` receive
as an `ImapSession`:

| field | |
| --- | --- |
| `id` | a random id of 16 hex characters, drawn for each connection: tie your logs to it |
| `remoteAddress` | the client's IP address; behind a trusted proxy, the one its PROXY header names (see [Running behind a TCP proxy](#running-behind-a-tcp-proxy)) |
| `secure` | `true` once TLS is on: from the first byte with `implicitTls`, or after STARTTLS |
| `user` | the username the client logged in with; absent before the login |
| `accountId` | the account `authenticate` answered; absent before the login |
| `data` | an object for your own state; it lasts the whole connection, STARTTLS included |

The fields are read-only: the server sets them, and a hook reads a
snapshot of them. Only `data` is yours to write into.

```ts
authenticate: async ({ username, password }, session) => {
	session.data.since = Date.now();
	return (await check(username, password)) ? accountIdOf(username) : null;
},
onError: (error, session) => {
	logger.error({ error, session: session.id, user: session.user, since: session.data.since });
},
```

A connection goes through the states of RFC 9051 §3: *not authenticated*,
*authenticated* after a login, *selected* after SELECT or EXAMINE, and
*logout*. A command sent in a state it does not belong to is
`BAD NAME is not valid in the <state> state`.

Both IMAP4rev1 and IMAP4rev2 are advertised. A session speaks IMAP4rev1
until the client sends `ENABLE IMAP4rev2`, which changes what it gets:

| | IMAP4rev1 | after `ENABLE IMAP4rev2` |
| --- | --- | --- |
| mailbox names that are not ASCII | modified UTF-7 (`&ZeVnLIqe-`) | UTF-8 |
| SEARCH without RETURN | `* SEARCH 1 2` | `* ESEARCH (TAG "a") ALL 1:2` |
| SELECT | `* 0 RECENT`, and `* OK [UNSEEN n]` naming the first unseen message when there is one (RFC 3501 §6.3.1) | `* LIST () "/" INBOX`, and `* OK [CLOSED]` when another mailbox was selected |
| LSUB and CHECK | answered | answered, though rev2 dropped them |

`ENABLE` names other than `IMAP4rev2` are left off: `ENABLE CONDSTORE`
answers `* ENABLED` without it.

## Commands

| state | commands |
| --- | --- |
| any | CAPABILITY, NOOP, LOGOUT |
| not authenticated | STARTTLS, LOGIN, AUTHENTICATE PLAIN (with an initial response, RFC 4959) |
| authenticated and selected | ENABLE, SELECT, EXAMINE, CREATE, DELETE, RENAME, SUBSCRIBE, UNSUBSCRIBE, LIST, LSUB, STATUS, NAMESPACE, APPEND, IDLE |
| selected | CLOSE, UNSELECT, EXPUNGE, UID EXPUNGE, FETCH, STORE, COPY, MOVE, SEARCH, CHECK, and the UID forms of FETCH, STORE, COPY, MOVE and SEARCH |

What each one takes:

- **LIST** — patterns with `*` and `%`, several in parentheses; the
  selection options `SUBSCRIBED`, `REMOTE`, `RECURSIVEMATCH` and
  `SPECIAL-USE`; `RETURN (SUBSCRIBED CHILDREN SPECIAL-USE STATUS (…))`
  (RFC 5258, 6154, 5819). Every mailbox says `\HasChildren` or
  `\HasNoChildren`, and its special-use attribute. INBOX comes first.
- **STATUS** — `MESSAGES`, `UIDNEXT`, `UIDVALIDITY`, `UNSEEN`, `SIZE`,
  `DELETED`, and `RECENT`, always 0.
- **FETCH** — `FLAGS`, `UID`, `INTERNALDATE`, `RFC822.SIZE`, `ENVELOPE`,
  `BODY`, `BODYSTRUCTURE`, `BODY[section]<partial>` and `BODY.PEEK[…]`,
  the IMAP4rev1 names `RFC822`, `RFC822.HEADER`, `RFC822.TEXT`, and the
  macros `ALL`, `FAST`, `FULL`. A section is a part number (`1.2`),
  `HEADER`, `HEADER.FIELDS (…)`, `HEADER.FIELDS.NOT (…)`, `TEXT` or
  `MIME`. A section the message does not have is `NIL`. `BODY[…]`
  without `.PEEK` sets `\Seen`, and the response then carries `FLAGS`.
- **STORE** — `FLAGS`, `+FLAGS`, `-FLAGS`, each with `.SILENT`.
- **SEARCH** — `ALL`, the flag keys (`SEEN`, `UNSEEN`, `FLAGGED`,
  `KEYWORD`…), `FROM`, `TO`, `CC`, `BCC`, `SUBJECT`, `HEADER`, `BODY`,
  `TEXT`, `BEFORE`, `ON`, `SINCE`, `SENTBEFORE`, `SENTON`, `SENTSINCE`,
  `LARGER`, `SMALLER`, `UID`, a sequence set, `NOT`, `OR` and
  parentheses; `CHARSET UTF-8` or `US-ASCII`; `RETURN (MIN MAX ALL
  COUNT)` (RFC 4731). `BODY` and `TEXT` stream the stored message, without
  case, and do not decode base64 or quoted-printable.
- **APPEND** — one message, with flags and a date, streamed into the
  store as it arrives: `{n}` gets `+ Ready for literal data`, `{n+}` is
  read at once (RFC 7888).
- **MOVE** (RFC 6851) — the messages leave the selected mailbox with an
  `EXPUNGE` each, keeping their ids in the store. A MOVE into the selected
  mailbox itself answers OK and changes nothing: the messages are already
  where they were asked to be, with the same UIDs, and nothing is
  expunged.
- **CLOSE** expunges the `\Deleted` messages without saying so;
  **UNSELECT** (RFC 3691) does not expunge.

A sequence number past the last message is `BAD No such message`
(§6.4.4); a UID set that names nothing answers OK with no data.

## How the store appears over IMAP

| IMAP | `@bumail/store` |
| --- | --- |
| mailbox `Work/2026` | a mailbox named `2026` whose parent is `Work`; the delimiter is `/` |
| `\Sent`, `\Archive`, `\Trash`… | the mailbox `role` |
| UIDVALIDITY, UIDNEXT, UIDs | the mailbox's `uidValidity`, `uidNext`, and each entry's `uid` |
| flags and keywords | the message's `flags`: a keyword in the case it was first set, `$Forwarded` as a client set it; STORE, `KEYWORD` and `UNKEYWORD` compare keywords without case, and FLAGS and PERMANENTFLAGS list each once |
| INTERNALDATE | `receivedAt` |
| the message | the stored blob, read as it streams |
| SUBSCRIBE | `isSubscribed` |

CREATE makes the parents a name needs. DELETE refuses INBOX, a mailbox
that has children, and the selected mailbox. RENAME moves the children with
it; INBOX cannot be renamed.

The selected mailbox is followed through the store's `highestModseq` and
its changes: a message added elsewhere is `* n EXISTS`, one removed is
`* n EXPUNGE`, a flag changed is `* n FETCH (UID u FLAGS (…))`. They are
told at the next command that allows it (NOOP, IDLE, FETCH, STORE,
SEARCH…). If the selected mailbox is deleted, the session is closed with
`* BYE The selected mailbox was deleted, closing`.

## Mailbox names and modified UTF-7

A session speaks IMAP4rev1 until the client sends `ENABLE IMAP4rev2`, and
IMAP4rev1 writes a mailbox name that is not ASCII in modified UTF-7 (RFC
3501 §5.1.3): `Entwürfe` is `Entw&APw-rfe`, and `&` itself is `&-`. The
server decodes what such a client sends and encodes what it answers; the
store always holds the UTF-8 name. A name that does not decode is
`BAD "…" is not a valid modified UTF-7 mailbox name`.

The two functions it uses are exported, for logs, tests or an admin tool
that speaks to the store in the names a client shows:

```ts
import { decodeUtf7, encodeUtf7 } from '@bumail/imap';

encodeUtf7('Entwürfe');     // 'Entw&APw-rfe'
encodeUtf7('R&D');          // 'R&-D'
decodeUtf7('Entw&APw-rfe'); // 'Entwürfe'
decodeUtf7('&Jjo');         // undefined: not modified UTF-7
```

`decodeUtf7` answers `undefined`, never throws, for a name that is not
valid modified UTF-7.

## New mail: IDLE and notify

During IDLE the server looks at the store every `idleInterval` seconds (10
by default). Where the mail is delivered in the same process, wake the
account's sessions at once:

```ts
await store.addMessage(accountId, inboxId, { content });
server.notify(accountId);
```

## Limits and slow clients

| option | default | |
| --- | --- | --- |
| `maxConnections` | 1000 | connections open at once, logged in or not; one more is greeted with `* BYE [UNAVAILABLE] Too many connections, try later` and closed |
| `maxMessageSize` | 25 MiB | APPEND; at most 4 294 967 295 |
| `maxLiteralSize` | 64 KiB | any other literal |
| `timeout` | 1800 s | idle time before a hang-up; at least 1800 (§5.4) |
| `loginTimeout` | 60 s | a deadline from the greeting to logged in |
| `handshakeTimeout` | 10 s | on implicit TLS, a deadline from the TCP connection to the end of the TLS handshake; past it the socket is closed without a reply. See [Running the server](#running-the-server). With `proxyProtocol`, also a deadline from the TCP connection to the end of a trusted proxy's header, exact to the millisecond; on implicit TLS the handshake behind the header has as long again. See [Running behind a TCP proxy](#running-behind-a-tcp-proxy) |
| `idleInterval` | 10 s | seconds between two looks at the store during IDLE; a fraction such as `0.5` is allowed, 0 is not |
| `hookTimeout` | 60 s | seconds `authenticate` has to settle; past it the login answers `NO [UNAVAILABLE] Temporary authentication failure` and `onError` gets an `ImapError` with code `HOOK_TIMEOUT` |

The sizes are bytes, the timers seconds. `maxConnections`, the sizes,
`timeout`, `loginTimeout`, `handshakeTimeout` and `hookTimeout` are whole numbers above 0;
every timer is at most 2 147 483 seconds, what `setTimeout` can wait.

```ts
createImapServer({
	...options,
	maxConnections: 5000,          // a busy server
	idleInterval: 30,              // look less often, and call notify on delivery
	hookTimeout: 10,               // a password check that should never take long
	maxMessageSize: 50 * 1024 * 1024,
});
```

Some limits are fixed, so that no single command — and nothing a client
that has not logged in sends — costs the server more than a bounded
amount:

| limit | value | past it |
| --- | --- | --- |
| a command line | 64 KiB | `BAD Command line too long`; the rest of the line is skipped |
| literals in one command | 32 | `BAD More than 32 literals in one command` |
| before login: literals in one command | 2 | `BAD More than 2 literals before login` |
| before login: one literal | 1 KiB, as LITERAL- (RFC 7888) | `BAD [TOOBIG] Literal over 1024 bytes before login` |
| lists and search keys nested | 32 deep | `BAD Lists nest too deep`, `BAD Search keys nest too deep` |
| a mailbox name, CREATE and RENAME | 32 levels, 1024 characters | `NO [LIMIT] A mailbox name has at most 32 levels`, `NO [LIMIT] A mailbox name is at most 1024 characters` |
| one level of a mailbox name, CREATE and RENAME | 255 characters, what a store keeps; checked before any parent is created | `NO [LIMIT] A level of a mailbox name is at most 255 characters` |
| one level of a mailbox name, CREATE and RENAME | what a store keeps: no white space at either end, no control character; checked before any parent is created | `NO [CANNOT] A level of a mailbox name cannot begin or end with white space`, `NO [CANNOT] A mailbox name cannot hold a control character` |
| a LIST pattern, reference included | 1024 characters | `BAD The pattern is too long` |
| patterns in one LIST | 16 | `BAD More than 16 patterns in one LIST` |
| TEXT and BODY keys in one SEARCH | 32 | `BAD More than 32 TEXT or BODY keys in one SEARCH` |
| client text repeated in a response | 100 characters, no control character | cut, `...` marking the cut |

A literal too large is refused before its bytes: `{n}` gets a `BAD` (or
`NO` for APPEND) and no continuation; `{n+}`, whose bytes follow at once,
gets a `BYE`. LIST patterns are matched in one greedy scan, consecutive
wildcards merged, so a pattern of 1024 wildcards costs no more than a
plain name.

A client that stops reading is not written to without end: the server
waits for the socket to drain past 64 KiB of output, and stops reading
commands meanwhile; a message is read and written 64 KiB at a time, so
what waits for such a client is a slice, never the whole message. Nor
does it hold the server for good: when `loginTimeout` or `timeout` comes
and output is still queued for it, the server drops that output and cuts
the connection at once. Every other hang-up — a timeout with nothing
queued, LOGOUT, a `BYE` — sends its last words, then half-closes the
socket: the server never waits for the client to answer, on TLS as on a
clear socket, so the connection leaves `connections` at once, and a
client that paused still reads that `BYE`, then a clean end, whenever it
reads again. When the server had stopped reading the client, which sent
more than it could take, it reads again first, dropping whatever comes,
and half-closes once the client's input stops for 20 ms: a half-close
does not complete over input left unread, and on Linux a close over
unread input is a reset that loses the `BYE`. A client whose input went
quiet for 20 ms within 500 ms of the hang-up still reads the `BYE` and
the end. It waits 500 ms at most: input not quiet for 20 ms by then, a
client still sending or one that stopped in the last 20 ms, is reset,
so the connection leaves
`connections` within 500 ms all the same. What is
still queued when a hang-up starts may wait 5 seconds at most for the
client to take it; past that the connection is reset. On TLS, once such
output has left, the server closes when the client answers, within the
same 5 seconds. A client that connects and never logs in is cut at
`loginTimeout`, however slowly it trickles bytes, and whether it reads or
not; its place under `maxConnections` is free again.

`server.stop(true)` hangs up on every open connection, those moved to TLS
by STARTTLS included, as a timeout does; a socket still in its implicit
TLS handshake is reset, having no TLS to say `BYE` on. So is a socket
still awaiting a trusted proxy's header: nothing is written to it and
`onError` is not called.

## Running behind a TCP proxy

`proxyProtocol` lets the server sit behind a TCP proxy and still see each
client's address, read from the PROXY protocol header the proxy sends
first.

```ts
import { createImapServer } from '@bumail/imap';

const proxyProtocol = { trusted: ['10.0.0.5'] }; // the proxy's own address

await createImapServer({ ...options, proxyProtocol }).listen({ port: 143 });
await createImapServer({ ...options, implicitTls: true, proxyProtocol }).listen({ port: 993 });
```

A TCP proxy opens its own connection to the server, so without this
option `session.remoteAddress` is the proxy's address for every client.
The PROXY protocol (HAProxy's `proxy-protocol.txt`) has the proxy write
the client's address in a header before the client's first byte; the
server reads version 1, a text line, and version 2, binary.

```ts
interface ProxyProtocolOptions {
	/** The proxies' addresses or CIDRs, IPv4 or IPv6: ['10.0.0.5', '172.16.0.0/12']. */
	readonly trusted: readonly string[];
}

interface ImapServerOptions {
	// …
	readonly handshakeTimeout?: number;
	readonly proxyProtocol?: ProxyProtocolOptions;
}
```

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `proxyProtocol` | `ProxyProtocolOptions` | absent: off | read a PROXY header from the peers in `trusted`; every other peer is served as without it |
| `proxyProtocol.trusted` | `readonly string[]` | required, at least one | IPv4 and IPv6 addresses (`10.0.0.5`, `2001:db8::5`) and CIDRs (`10.0.0.0/24`, `2001:db8::/64`) of the proxies |
| `handshakeTimeout` | `number` | 10 | seconds a trusted proxy has, from the TCP connection, to send its whole header; on implicit TLS, as long again for the TLS handshake behind it |

**List only the proxies' own addresses.** A peer in `trusted` can claim
any client address, and that address is what `authenticate` and `onError`
see, and what a limiter of failed logins per address counts. Never list a
range clients connect from, nor `0.0.0.0/0` on a public port. A CIDR is
for a pool of proxies, and only when nothing else connects from it.

### A trusted proxy

A peer is trusted when its TCP address is in `trusted`. An IPv4-mapped
peer, such as `::ffff:10.0.0.5` on a dual-stack listener, matches as its
IPv4 address, `10.0.0.5`; a zone suffix (`%eth0`) is ignored. An entry
may be IPv4-mapped too: `::ffff:10.0.0.0/104` is `10.0.0.0/8`.

From a trusted peer the header is required, first, and in time:

- It must be complete within `handshakeTimeout` seconds of the TCP
  connection. The deadline is a timer of its own, exact, not Bun's socket
  timer, and a header that trickles in a byte at a time does not extend
  it.
- A version 1 line is at most 107 bytes, CRLF included, as the
  specification says. Version 2 TLVs are at most 2048 bytes; a header
  whose length field announces more is refused from its first 16 bytes,
  before the rest arrives. A malformed TLV is refused; the others are
  skipped, never read.
- A header missing, malformed, too long or too late resets the socket:
  no `BYE`, nothing passed to `onError`, and the proxy's address is never
  used as a client's.

What the header says decides the address:

| header | `session.remoteAddress` |
| --- | --- |
| v1 `TCP4` or `TCP6` | the source address |
| v2 `PROXY` over `STREAM`, `AF_INET` or `AF_INET6` | the source address |
| v2 `LOCAL`: the proxy's own connection, a health check | the proxy's |
| v2 `UNSPEC`, `AF_UNIX`, or over `DGRAM`; v1 `UNKNOWN` | the proxy's |

An IPv6 source is written as RFC 5952 has it (`2001:db8::7`), and an
IPv4-mapped source as plain IPv4.

Once the header is read, the connection goes on as a direct one:

- A socket awaiting its header holds no place under `maxConnections`. It
  is counted once the header is read, as the client the header names; a
  full server then answers it `* BYE [UNAVAILABLE] Too many connections,
  try later`.
- Commands the client sent behind the header, in the same segment, are
  answered after the greeting, as on a direct connection.
- `loginTimeout` starts at the greeting, not at the TCP connection.
- On 143, the header comes before the greeting; STARTTLS then upgrades
  the connection as usual, and the address carries over.

### A peer not trusted

A peer whose address is not in `trusted` is served exactly as without
`proxyProtocol`. A PROXY header it sends never sets its address. On 143
it is bad input: a version 1 line is answered as an unknown command,
`PROXY BAD Unknown command TCP4`, and a version 2 header with lines such
as `* BAD Missing or invalid tag`. On 993 it is not a ClientHello: the TLS
handshake fails and the socket closes.

### Implicit TLS behind the proxy

On 993 the proxy passes TLS through, untouched: the header comes first,
then the client's ClientHello, and the server holds the certificate.
`Bun.listen({ tls })` would take the header for a broken ClientHello, and
`socket.upgradeTLS` reads only what arrives after it is called, while a
proxy often sends the ClientHello in the same TCP segment as the header
(on Bun 1.4.2 the handshake then never completes). So with
`proxyProtocol` on an `implicitTls` server, the port listens in clear,
and every connection's TLS runs through `node:tls` over the raw socket:
after the header from a trusted proxy, from the first byte from anyone
else.

- `tls.key` and `tls.cert` may still be strings, bytes or a `BunFile`;
  they are read when `listen()` is called.
- The TLS handshake behind the header has a `handshakeTimeout` of its
  own, on Bun's socket timer, so a stuck one is closed up to about 4
  seconds after it.
- A client that reads a large FETCH slowly holds the server back, as on
  a direct connection; its output is not buffered without end.

### With Traefik

A Traefik v3 TCP router in front of the server, its service sending
PROXY protocol version 2. In the static configuration, two entry points:

```yaml
entryPoints:
  imap:
    address: ':143'
  imaps:
    address: ':993'
```

In the dynamic configuration, a router and a service for each port.
``HostSNI(`*`)`` with no `tls` section on the router: Traefik neither
terminates nor reads the TLS of 993, it passes the bytes through.

```yaml
tcp:
  routers:
    imap:
      entryPoints: [imap]
      rule: HostSNI(`*`)
      service: imap
    imaps:
      entryPoints: [imaps]
      rule: HostSNI(`*`)
      service: imaps
  services:
    imap:
      loadBalancer:
        proxyProtocol:
          version: 2
        servers:
          - address: '10.0.0.20:143'
    imaps:
      loadBalancer:
        proxyProtocol:
          version: 2
        servers:
          - address: '10.0.0.20:993'
```

The server, at `10.0.0.20`, trusts Traefik's address as it sees it,
`10.0.0.5` here, and nothing else:

```ts
import { createImapServer } from '@bumail/imap';
import type { ImapServerOptions } from '@bumail/imap';

const behindTraefik: ImapServerOptions = {
	...options,
	proxyProtocol: { trusted: ['10.0.0.5'] },
};

await createImapServer(behindTraefik).listen({ port: 143, hostname: '10.0.0.20' });
await createImapServer({ ...behindTraefik, implicitTls: true }).listen({ port: 993, hostname: '10.0.0.20' });
```

Clients connect to Traefik on 143 with STARTTLS and on 993 with SSL/TLS,
as they would to the server itself.

### Counting failed logins per client

Behind a trusted proxy, `session.remoteAddress` is the client's, so a
limiter keyed on it counts each client, not the proxy:

```ts
import { createImapServer } from '@bumail/imap';

const failures = new Map<string, number>();

const server = createImapServer({
	...options,
	proxyProtocol: { trusted: ['10.0.0.5'] },
	async authenticate({ username, password }, session) {
		const address = session.remoteAddress; // the client, not 10.0.0.5
		if ((failures.get(address) ?? 0) >= 10) return null;
		const accountId = await check(username, password);
		if (!accountId) failures.set(address, (failures.get(address) ?? 0) + 1);
		return accountId;
	},
});
```

A header the proxy gets wrong, a server that does not trust the proxy, or
an address that stays the proxy's: see [Troubleshooting: logging in,
connections and IDLE](troubleshooting/connections.md). An entry of
`trusted` that is refused: see [Troubleshooting: configuration and
onError](troubleshooting/configuration.md).

## Errors and onError

Nothing a client sends throws out of the server. A command that breaks the
grammar is `BAD`; one the store refuses is `NO`, with a response code:

| store error | response |
| --- | --- |
| `NOT_FOUND` | `NO [NONEXISTENT] …` |
| `ALREADY_EXISTS` | `NO [ALREADYEXISTS] …` |
| `INVALID` | `NO [CANNOT] …` |
| anything else | `NO [SERVERBUG] Internal error`, and `onError` |

`onError(error, session)` is told of what went wrong in your code or the
store: an `authenticate` that threw or timed out (an `ImapError` with code
`HOOK_TIMEOUT`), an account it named that the store does not have
(`Error: authenticate answered the account "…", which the store does not
have`), a store call that failed, during a command or a look of IDLE. The
client sees only `NO [UNAVAILABLE]` or `NO [SERVERBUG]`, so `onError` is
where you learn why. It is called synchronously and should not throw; if
it does, the error is dropped.

```ts
import { createImapServer, ImapError } from '@bumail/imap';

createImapServer({
	...options,
	onError(error, session) {
		if (error instanceof ImapError && error.code === 'HOOK_TIMEOUT') {
			metrics.increment('imap.auth.timeout');
		}
		console.error(`imap ${session.id} ${session.remoteAddress} ${session.user ?? '-'}`, error);
	},
});
```

Without `onError` these errors are not logged anywhere.

[Troubleshooting](troubleshooting.md) has an entry for each error and
each response, headed by its exact text.

## Standards

| | |
| --- | --- |
| RFC 9051 | IMAP4rev2 |
| RFC 3501 | IMAP4rev1, for clients that do not enable rev2 |
| RFC 2177 | IDLE |
| RFC 2342 | NAMESPACE |
| RFC 3691 | UNSELECT |
| RFC 4315 §2.1 | UID EXPUNGE (UIDPLUS's other parts are not implemented) |
| RFC 4616, 4959 | SASL PLAIN, SASL-IR |
| RFC 4731 | ESEARCH |
| RFC 5161 | ENABLE |
| RFC 5258, 5819 | LIST-EXTENDED, LIST-STATUS |
| RFC 6154 | SPECIAL-USE |
| RFC 6851 | MOVE |
| RFC 7888 | LITERAL+ |
| RFC 7889 | APPENDLIMIT |
| RFC 8314 | implicit TLS |

Not implemented: CONDSTORE and QRESYNC (RFC 7162), UIDPLUS's APPENDUID and
COPYUID, BINARY (RFC 3516), MULTIAPPEND (RFC 3502), SEARCHRES (RFC 5182),
COMPRESS, QUOTA, METADATA, NOTIFY, and `\Recent` (always 0).
