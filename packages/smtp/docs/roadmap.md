# Roadmap

What `@bumail/smtp` gives a mail server, and what is coming. This page is a
direction, not a commitment: the version something shipped in is the only
number on it.

## Now

Nothing in progress.

## Next

- **Connection reuse in the client** — several messages to one
  destination over one session (`RSET` between them), for a queue that
  delivers in batches. Today each `sendMail` opens its own connection.
- **DSN** (RFC 3461) — `RET`, `ENVID`, `NOTIFY` and `ORCPT` accepted and
  handed to the app, so a sender can ask for delivery status
  notifications. Today they are refused with `555 5.5.4`, and the client
  sends none.
- **Delivery into `@bumail/store`, ready-made** — an `onData` that puts
  each message in its recipients' inboxes, instead of the few lines the
  [guide](guide.md#delivering-into-bumailstore) shows today. The store
  itself has landed; only the helper is to come.

## Not planned

- **Relaying without AUTH** — not as a default, not as an option. A
  recipient outside `localDomains` takes an authenticated session; an open
  relay is a spam source within hours of going online.
- **AUTH on a clear connection** — the password would cross the network in
  base64. Use STARTTLS or implicit TLS.

## Shipped

### Unreleased — merged, not yet published

- **Behind a TCP proxy, the client's own address**, with `proxyProtocol:
  { trusted: [...] }`: the server reads the PROXY protocol, versions 1 and
  2, from the proxies listed — a Traefik TCP router, HAProxy — so
  `session.remoteAddress`, every hook, the Received field and
  `maxConnectionsPerClient` see the client, not the proxy. It works on 25
  and 587 with STARTTLS and on 465 with implicit TLS. A listed peer that
  sends no valid header within `handshakeTimeout` is reset without a word
  and holds no slot while it waits; a peer not listed is served as before,
  and a header it sends never sets an address. `ProxyProtocolOptions` is
  exported.

### 0.4.0

- **A connection limit per client**, `maxConnectionsPerClient` (default
  10): one host can no longer take every slot of `maxConnections` on an
  MX. A client is an IPv4 address, or an IPv6 address by its /64, and an
  IPv4-mapped or NAT64 address counts as its IPv4 address; one more is
  answered `421 4.7.0` and closed, and every close frees its slot.
  `clientKey(address)` is exported, to group clients the same way in
  `onConnect`.
- **The implicit TLS handshake is bounded.** A socket on an
  `implicitTls` port is counted by `maxConnections` and
  `maxConnectionsPerClient` from the TCP connection on, and closed past
  `handshakeTimeout` (default 10 seconds) if its handshake has not
  completed. Before, a socket that never sent its ClientHello was counted
  by no limit and closed by no timer.
- **`RCPT TO:<postmaster>` with no domain** (RFC 5321 §4.5.1) is taken
  as this server's postmaster, without AUTH: `onRcptTo` gets a `Path`
  with `postmaster: true`, and the envelope lists it as `'postmaster'`.

### 0.3.0

- **`isMailbox(address)`**, from `@bumail/smtp/client` — whether an
  address is exactly one `sendMail` takes, by the same check, so code that
  keeps addresses for later (a queue) refuses a bad one when it takes it,
  rather than at delivery.

### 0.2.1

- **Security: no command injection through an address.** `sendMail`
  refuses a source route (`@host:`) in `from` and `to`, and any control
  character, lone surrogate or out-of-range IPv4 literal in an address,
  before it connects; it used to drop the route unchecked and write the
  address as given, so a crafted recipient put extra commands on the
  wire. The server answers a path holding a control character, or a
  malformed route, with `501 5.5.4`. Upgrade if an address can come from
  user input.
- **A hang-up frees its slot within 500 ms**, not 5 seconds, for a client
  the server had stopped reading because it pipelined more than it could
  take; a client that went quiet still reads the last reply and a clean
  end, on Linux too.
- **IPv6 address literals** written with their `IPv6:` tag, in `helo`,
  `EHLO` and an address's domain, are taken in any case; one without the
  tag is refused, as RFC 5321 §4.1.3 asks.

### 0.2.0

- **A client that stops reading no longer holds a connection slot.** When
  the server hangs up on its own — the idle `timeout`, `maxErrors`, failed
  AUTH, a refusal — it no longer waits for the client to read what is
  queued: the connection is counted out at once, and what was never read
  is dropped. Such a close used to wait forever, so enough clients that
  pipelined commands and never read could fill `maxConnections`. The
  same holds on implicit TLS and after STARTTLS, where a client that paused
  and never answered the hang-up used to keep its slot even with nothing
  queued. `QUIT` still sends its `221` whole before hanging up, within a
  5-second grace when the client does not read it.

- **`stop(true)` closes sessions moved to TLS by STARTTLS.** They used to
  stay open, each holding its slot, because the listener no longer held
  them. A hang-up on TLS right after queued replies left no longer drops
  the end of them.

- **The client, as `@bumail/smtp/client`** — `sendMail(message, options)`
  delivers one message to a host (a smarthost, submission on 587 or 465,
  a local Mailpit) or to a domain's MX hosts by preference, through a
  resolver — `@bumail/dns`'s, or any with `mx`, `a` and `aaaa` — the
  domain's own address without MX, and a null MX refused; `helo` required
  by MX, by the type itself. STARTTLS opportunistic by default for
  MX, required — the certificate checked — with AUTH; implicit TLS; AUTH
  PLAIN and LOGIN only once the certificate checked out; PIPELINING, SIZE, 8BITMIME and
  SMTPUTF8; the message a string, bytes or a stream, dot-stuffed, a bare
  CR or LF refused. It resolves with each recipient's reply, and rejects
  with an `SmtpError` whose `temporary` tells a retry from a bounce. RFC
  5321's timeouts per step and a deadline; reply lines, replies and their
  total bounded against a hostile server.

- **`hookTimeout` bounded to what a timer can wait.** A value past
  2 147 483 seconds is refused, where it used to fire after a millisecond
  and time every hook out.

### 0.1.0

- **The server** — RFC 5321 on `Bun.listen`: EHLO with PIPELINING, SIZE,
  8BITMIME, SMTPUTF8 and ENHANCEDSTATUSCODES; STARTTLS and implicit TLS;
  AUTH PLAIN and LOGIN, offered only once encrypted; hooks where the app
  accepts or refuses a connection, a sender, a recipient or a message;
  limits on size, recipients, connections, errors and idle time; a
  greeting delay that turns away senders who talk before the 220; a `250`
  only once the app read the whole message; and a refusal of SMTP
  smuggling.
