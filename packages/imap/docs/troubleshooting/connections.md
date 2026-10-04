# Troubleshooting: logging in, connections and IDLE

The responses to LOGIN, AUTHENTICATE and STARTTLS, the `BYE`s that end a
connection, a TCP proxy's PROXY header, and the end of IDLE. The [index](../troubleshooting.md) lists
every entry of every page. A tagged response starts with the client's tag
(`a1 NO …`); it is left out here.

## `NO [PRIVACYREQUIRED] Log in only once TLS is on: STARTTLS first`

The client sent LOGIN or AUTHENTICATE on a clear connection. The server
advertises `LOGINDISABLED` there, and does not read the password. Set the
client to *STARTTLS* on 143, or *SSL/TLS* on 993.

## `NO [AUTHENTICATIONFAILED] Authentication failed`

`authenticate` answered `null` or `undefined`, or AUTHENTICATE PLAIN
carried an authorization identity other than the username. Check what the
hook received: `username` is what the client typed, often the whole
address.

## `NO [UNAVAILABLE] Temporary authentication failure`

`authenticate` threw, timed out, or answered an account id the store does
not have. `onError` has the error. Make sure the hook returns the store's
account `id`, not the address.

## `* BYE Too many failed logins, closing`

Three failed logins on one connection close it. The client reconnects and
tries again; a wrong saved password does this at every start.

## `* BYE Too slow to log in, closing`

The client did not log in within `loginTimeout` seconds (60) of the
greeting. It is a deadline, not an idle timer: bytes sent meanwhile do
not extend it. Its place under `maxConnections` is free at once, whether
the client reads or not. A client that paused with nothing queued for it
still reads this BYE, then a clean end, when it reads again; one with
output still queued — responses it never read — does not see it: the
server drops that output and resets the connection.

## `NO [CANNOT] … is not supported: use PLAIN`

Only AUTHENTICATE PLAIN is offered (`AUTH=PLAIN`). Set the client to
*Normal password*.

## `BAD Cannot decode the PLAIN response`

The PLAIN response was not base64 of `authzid NUL username NUL password`.

## `BAD Authentication cancelled`

The client answered the server's `+` continuation of AUTHENTICATE PLAIN
with `*`, which cancels the exchange (RFC 9051 §6.2.2). It is not a failed
login, and does not count toward the three. A client does this when it has
no password to give: check the account's saved credentials, or that it is
set to *Normal password*.

## `BAD TLS is already on`

STARTTLS on a connection that is already encrypted: implicit TLS on 993,
or a second STARTTLS.

## `* BYE [UNAVAILABLE] Too many connections, try later`

`maxConnections` (1000) are open. Raise it, or look for a client that
opens a connection per folder without closing them. On implicit TLS,
sockets still in their handshake count too, for `handshakeTimeout`
seconds at most.
Behind a trusted proxy, a socket awaiting its PROXY header does not
count; it is counted once the header is read.

## On implicit TLS, the connection closes before any greeting

**When**: a client on an `implicitTls` port (993) gets no `* OK` greeting
and the connection closes, with no response, about `handshakeTimeout`
seconds (10 by default, up to 4 s later as Bun's timer ticks) after it
connected; or at once, when what it sent is not TLS.

**Why**: it did not complete its TLS handshake in time — it speaks clear
IMAP to a TLS port, waits for a greeting before its ClientHello, or never
sends one. A socket in its handshake holds a place under
`maxConnections`, so the server bounds it. There is no TLS yet to write a
`BYE` on.

**Fix**, as a client: set *SSL/TLS* on 993, or *STARTTLS* on 143. As the
operator, for clients on slow links, raise the bound:

```ts
import { createImapServer } from '@bumail/imap';
import { MemoryMailStore } from '@bumail/store';

const server = createImapServer({
	hostname: 'imap.example.com',
	store: new MemoryMailStore(),
	implicitTls: true,
	tls: {
		key: await Bun.file('/etc/ssl/imap.example.com.key').text(),
		cert: await Bun.file('/etc/ssl/imap.example.com.crt').text(),
	},
	authenticate: ({ username, password }) =>
		username === 'alice' && password === Bun.env['ALICE_PASSWORD'] ? 'alice-account-id' : null,
	handshakeTimeout: 30, // default 10
});
await server.listen({ port: 993 });
```

## Connections through the proxy close at once, with no greeting

**When**: `proxyProtocol` is set, and a client that goes through the
proxy gets no `* OK` greeting: the connection closes, with no response,
at once or `handshakeTimeout` seconds (10 by default) after it connected.
Nothing reaches `onError`.

**Why**: the proxy is in `trusted`, so the server waits for its PROXY
header first, and did not get a valid one in time. The proxy sends none
(its PROXY protocol is off), sends something else first (a ClientHello
on 993 with no header before it), or sends one that is malformed or too
long: a version 1 line over 107 bytes, version 2 TLVs over 2048 bytes. A
trusted peer's socket is reset rather than served, so the proxy's own
address is never taken for a client's.

**Fix**: turn the PROXY protocol on in the proxy, for every port the
server listens on with `proxyProtocol`. With Traefik, a TCP
`serversTransport` the service names:

```yaml
tcp:
  serversTransports:
    proxy-v2:
      proxyProtocol:
        version: 2
  services:
    imap:
      loadBalancer:
        serversTransport: proxy-v2
        servers:
          - address: '10.0.0.20:143'
```

A peer that must reach the server directly, with no header, is not
listed in `trusted`.

## A `PROXY BAD` answer, or a failed handshake on 993

**When**: through the proxy, a client on 143 gets
`PROXY BAD Unknown command TCP4` (or `TCP6`, `UNKNOWN`) after the
greeting, or lines such as `* BAD Missing or invalid tag` for a
version 2 header; on 993 the TLS handshake fails and the connection closes. Every
client shows the proxy's address.

**Why**: the proxy sends a PROXY header, but the server does not trust
it: `proxyProtocol` is not set, or the proxy's address is not in
`trusted`. A peer not trusted is served as a direct client, so its
header is bad input on 143, and no ClientHello on 993. It never sets the
address.

**Fix**: list the proxy's own address, the one the server sees it
connect from:

```ts
createImapServer({ ...options, proxyProtocol: { trusted: ['10.0.0.5'] } });
```

Behind a dual-stack listener, the proxy may connect as
`::ffff:10.0.0.5`; it matches `10.0.0.5`.

## Every client shows the proxy's address

**When**: `session.remoteAddress`, in `authenticate` and `onError`, is
the proxy's for every client, and a limiter of failed logins per address
locks everyone out at once.

**Why**: the server reads no PROXY header from the proxy:
`proxyProtocol` is not set, or the proxy's address is not in `trusted`.
A header the proxy sends is then answered as in the entry above; with
no header, every client looks like the proxy.

**Fix**: both at once — the proxy sends the header, and the server
trusts the proxy. Trusting a proxy that sends no header closes every
connection instead, as in the first of these entries.

```ts
createImapServer({ ...options, proxyProtocol: { trusted: ['10.0.0.5'] } });
```

List only the proxies' own addresses: a peer in `trusted` can claim any
client address. Never a range clients connect from, nor `0.0.0.0/0` on a
public port.

## Health checks from the proxy show its own address

**When**: a few sessions, opened by the proxy itself, show the proxy's
address in `session.remoteAddress`, while clients show their own.

**Why**: by design. A proxy checking the server's health sends a
version 2 `LOCAL` header: the connection is its own, with no client
behind it, so the server keeps the peer's address. A version 2 `UNSPEC`,
a UNIX or datagram source, and a version 1 `UNKNOWN` do the same.

**Fix**: none needed. To leave them out of logs or a limiter, compare
`session.remoteAddress` with the proxy's address.

## `* BYE Idle for too long, closing`

Nothing came from the client for `timeout` seconds (1800). Clients send
NOOP or restart IDLE before that. As with `Too slow to log in`, a client
that does not read is hung up on without waiting for it: with nothing
queued, it reads this BYE and a clean end later; with output queued, the
connection is reset without it.

Any other hang-up — LOGOUT, a BYE for a protocol error — sends its last
words. With nothing else queued it half-closes the socket at once. With
output still queued it waits at most 5 seconds for the client to read it,
then the connection is reset; on TLS, once that output has left, the
server closes when the client answers, within the same 5 seconds.

## `* BYE The selected mailbox was deleted, closing`

Another session, or your app, deleted the mailbox this session had
selected. The client reconnects and lists the mailboxes again.

## `* BYE Internal error, closing`

Something failed in the server itself while it read the client's input,
outside any one command: a command that fails is answered `NO` or `BAD`
and the connection goes on, so this is a bug in `@bumail/imap`, not in
your hook or your store. `onError` has the error and the session; please
report it with the client's last commands. The client reconnects.

## `BAD Expected DONE`

During IDLE the only line a client may send is `DONE` (RFC 2177); the
server got another one. IDLE ends there, with this `BAD` in place of
`OK IDLE terminated`, and the line is not run as a command. A client that
pipelines its next command without waiting to send `DONE` does this; so
does a hand-typed session that sends `a2 DONE`. Send `DONE` alone, any
case, then the next command.
