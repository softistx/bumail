# Running the server

`bumail serve` runs the server: it receives mail from other servers on
port 25 and serves it to mail clients over IMAP on port 993. Sending
mail (submission on 465 and 587), JMAP over HTTPS and the health check
come in later releases; see the [roadmap](roadmap.md).

- [Starting](#starting)
- [The listeners](#the-listeners)
- [Receiving mail on 25](#receiving-mail-on-25)
- [Inbound checks: SPF, DKIM, DMARC](#inbound-checks-spf-dkim-dmarc)
- [Reading mail over IMAP](#reading-mail-over-imap)
- [Stopping](#stopping)
- [The log](#the-log)
- [From code](#from-code)

## Starting

```sh
bumail serve --config /data/bumail.toml
```

It reads and checks the configuration whole, as `check-config` does,
and stops at the first thing it cannot do:

1. reads the certificate and its key (`tls.mode = "files"`).
   `tls.mode = "acme"` is the **default**, and `check-config` takes it,
   but `serve` exits 3 with it until ACME arrives in a later release: a
   minimal configuration needs `tls.mode = "files"`, with `cert` and
   `key`, for now;
2. creates `<data>/spool/<pid>`, where messages wait while they are
   checked, readable by the server alone, and removes what a server no
   longer running left under `<data>/spool`;
3. opens the directory and the mail store;
4. binds each listener whose port is not 0.

A port it cannot bind (another process holds it, or port 25 or 993 needs
privileges the process lacks) exits 5, with what was opened closed again.
Every problem has an entry in [troubleshooting](troubleshooting.md#serving).

```toml
hostname = "mail.example.com"

[tls]
mode = "files"
cert = "/etc/bumail/fullchain.pem"
key = "/etc/bumail/privkey.pem"

[ports]
mx = 25        # 0 turns it off
imaps = 993
imap = 0       # 143, with STARTTLS; off by default
```

The certificate is read once, at start: after renewing it, restart the
server. Reloading it while running comes in a later release.

## The listeners

| port | key | what it does |
| --- | --- | --- |
| 25 | `ports.mx` | SMTP from other servers: mail for the addresses the directory holds. STARTTLS offered, never required; never AUTH; never relaying |
| 993 | `ports.imaps` | IMAP over TLS from the first byte, for the users of the directory |
| 143 | `ports.imap` | IMAP with STARTTLS; LOGIN and AUTHENTICATE are refused until TLS is on. Off unless you set it |

Every listener binds to `bind` (default `0.0.0.0`). The other ports of
`[ports]` — `submissions`, `submission`, `https`, `http`, `health` —
are bound to nothing: their listeners arrive in later releases, and the
log says so at start, one line each. Leave them as they are, or set
them to 0 to silence those lines.

## Receiving mail on 25

A message is taken only for an address the directory resolves:

| the recipient | the answer |
| --- | --- |
| a user (`alice@example.com`), even disabled | `250`: delivered to its INBOX |
| an alias (`sales@example.com`) | `250`: delivered to each of its users, once each |
| an unknown address in a hosted domain | `550 5.1.1 User unknown` |
| an address in any other domain | `554 5.7.1 Relay access denied` |

**Never an open relay.** Port 25 has no AUTH at all: it is not offered
in EHLO, before or after STARTTLS, and the command is refused. So every
session is unauthenticated, and a recipient outside the hosted domains
is refused whoever the sender claims to be, a local address included.
There is no option that changes this. An alias only ever points to local
users, so nothing received is sent on.

**What is added to each message.** On top, in this order:

```text
Return-Path: <joe@example.org>
Authentication-Results: mail.example.com; dkim=pass header.d=example.org …; spf=pass smtp.mailfrom=example.org; dmarc=pass header.from=example.org
Received: from mx.example.org ([192.0.2.10])
	by mail.example.com with ESMTPS id …; …
```

`Return-Path` holds the envelope sender (`<>` for a bounce), as RFC 5321
§4.4 asks of the server that delivers. Any `Return-Path` the message
already had is removed, and so is any `Authentication-Results` whose
authserv-id is `hostname` (in any case, quoted or not, after comments):
a sender could otherwise write `dmarc=pass` in your server's name
(RFC 8601 §5). `Authentication-Results` fields from other servers are
kept. Every other field is kept byte for byte.

**Where it goes.** INBOX, or Junk for a message DMARC quarantines. The
user's account and its six mailboxes are created in the store if they
are missing — at every delivery, so a role mailbox the user deleted
(Archive, Trash) comes back with the next message. A user who renamed
Junk away from its role gets quarantined mail in INBOX.

**Limits.** `inbound.maxMessageSize` (25 MiB) is announced with SIZE and
enforced as the message comes (`552 5.3.4`); `inbound.maxConnections`
(1000) are served at once, and one more is answered `421` and closed. A
header over 256 KiB is refused with `552 5.3.4 Message header too large`.
A message waits on disk, in `<data>/spool/<pid>`, while it is checked,
and is removed once delivered or refused; memory holds 64 KiB of it at a
time, and its header.

**No bounce is ever sent** for mail received on 25. Every refusal is a
reply during the session, so the sending server, which knows the real
sender, reports it. A message is either taken (`250`) or not; nothing is
refused after the fact. If the store fails part-way through a message to
several users, the whole message is answered `451` and the sender tries
again later: the users it reached before the failure get it twice.

## Inbound checks: SPF, DKIM, DMARC

Each message is checked with `@bumail/auth`:

- **SPF** for the MAIL FROM domain (for a bounce, the HELO name), from
  the client's IP, begun at MAIL FROM;
- **DKIM**, every signature, over the message as received;
- **DMARC** for the From domain, aligning both.

`inbound.dmarc` says what the result does:

| DMARC | `"enforce"` (default) | `"mark"` |
| --- | --- | --- |
| `pass`, `none`, or a failing domain with `p=none` | INBOX | INBOX |
| fails, `p=quarantine` | Junk | INBOX |
| fails, `p=reject` | `550 5.7.1 Rejected by the DMARC policy of …` | INBOX |
| a From it cannot evaluate (none, two, a group) | `550 5.7.1 The From field cannot be evaluated for DMARC: …` | INBOX |
| `temperror`: the policy could not be looked up | `451 4.7.0 DMARC check failed, try again later` | INBOX |

Either way, the result is written into `Authentication-Results`. SPF on
its own never refuses a message: forwarding breaks it, and DMARC needs
only one of SPF and DKIM.

The DNS is the system's resolver, through a cache. Each query has 5
seconds per try and 2 tries; SPF and DMARC each give up after 10 seconds
(`temperror`), and the whole check is bounded by the 60 seconds the SMTP
server gives its hooks.

## Reading mail over IMAP

Clients log in with a user's address and password, over TLS only. Each
login goes through the directory: argon2id, at most 4 verifies at once,
an unknown user as slow as a known one, and failures counted per client
IP, taken from the socket. After 10 failures within 15 minutes a client
is refused, its right password included, until they age out; see
[the directory](directory.md#logins).

A delivery wakes the user's IMAP sessions in IDLE at once.

With `ports.imap` set (143, say), the plain port says `LOGINDISABLED`
and refuses LOGIN and AUTHENTICATE until the client runs STARTTLS. A
password never crosses the network in clear.

## Stopping

`SIGTERM` (as `docker stop` sends) or `SIGINT` (Ctrl-C) stops the server
cleanly:

1. no listener accepts a new connection;
2. IMAP sessions are closed at once (clients reconnect);
3. SMTP sessions get 10 seconds to finish what they are sending; a
   message under way when the signal came is still taken and answered;
4. sessions still open after that are hung up on, and the server waits
   up to 5 more seconds for deliveries already writing to the store;
5. the store and the directory are closed.

It then exits 0. A second signal skips the waits. A message cut off
by the stop was never answered `250`, so its sender tries again; if it
was cut off while being written for several users, those already
written to get it twice.

Under Docker, the drain and the wait for deliveries can take 15
seconds, past `docker stop`'s default 10 before it kills the process:
give it more, with `docker stop -t 20` or `stop_grace_period: 20s`.

## The log

One line per event, on standard output; nothing in it is a password or
a store URL's credentials.

```text
bumail: serving mail.example.com
bumail: mx listening on 0.0.0.0:25: SMTP from other servers: STARTTLS offered, no AUTH, mail for hosted addresses only
bumail: imaps listening on 0.0.0.0:993: IMAP over TLS from the first byte
bumail: submissions (port 465) arrives in a later slice; not listening
mx: 1kq2f… from 192.0.2.10 <joe@example.org> delivered to alice@example.com (spf=pass dkim=pass dmarc=pass)
mx: 1kq2g… from 203.0.113.5 <ceo@example.net> refused by DMARC (spf=fail dkim=none dmarc=fail)
imaps: login refused from 203.0.113.9: password
bumail: SIGTERM, stopping
bumail: stopped
```

| line | when |
| --- | --- |
| `bumail: <listener> listening on <address>:<port>: …` | at start, one per listener |
| `bumail: <name> (port <n>) arrives in a later slice; not listening` | at start, for each later port not 0 |
| `mx: <id> from <ip> <sender> delivered to <users> (…)` | a message taken; `(Junk)` when quarantined |
| `mx: <id> … refused by DMARC (…)` | `550 5.7.1`, with `inbound.dmarc = "enforce"` |
| `mx: <id> … deferred: DMARC temperror (…)` | `451 4.7.0` |
| `mx: <id> … refused: its header is over 256 KiB` | `552 5.3.4` |
| `mx: <id> … refused: no recipient is here any longer` | every recipient was removed between RCPT and the end of DATA |
| `mx: <id> from <ip> not spooled: …` | the spool could not take the message (a full disk, say): the client got `451` |
| `mx: <id> … abandoned before <user>: the session ended` | the session ended while the message was being written: the users before `<user>` have it |
| `mx: error in a session from <ip>: …` | the store or the directory failed, or a message's checks ran past the 60 s hook timeout: the client got `451` |
| `imaps: login refused from <ip>: <reason>` (`imap:` on 143) | `password`, `unknown`, `disabled`, `blocked`, `malformed` or `busy` |
| `imaps: error in a session from <ip>: …` (`imap:` on 143) | the store failed: the client got `NO [UNAVAILABLE]` |
| `bumail: SIGTERM, stopping`, `bumail: stopped` | the stop |
| `bumail: the mail store did not close cleanly: …` | during the stop: the store's close failed; the directory is closed anyway, and it exits 0 |
| `bumail: <signal> again, stopping now` | a second signal during the stop: the waits are skipped |

A refused recipient (`550 5.1.1`, `554 5.7.1`) is not logged: on port 25
there are many, and the sending server has the reply.

## From code

```ts
import { readConfig, serve } from '@bumail/server';

const config = await readConfig({ path: './bumail.toml' });
const server = await serve(config, {
	log: (line) => console.log(line),
	port: (listener, configured) => configured, // 0 binds a free port, for a test
	drainSeconds: 10,
});
server.listening; // [{ name: 'mx', hostname: '0.0.0.0', port: 25 }, { name: 'imaps', … }]

process.on('SIGTERM', () => void server.stop());
```

`resolver` replaces the DNS, with any `Resolver` of `@bumail/dns` (a
`fixtureResolver` in a test). `stop({ force: true })` skips the waits.
