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
2. creates its spool folder, `<data>/spool/<pid>-<random>`, where
   messages wait while they are checked, readable by the server alone,
   with an `owner` file written before the folder takes its name. The
   server touches that file every 30 seconds while it runs. Before
   making its own, it removes every folder under `<data>/spool` whose
   owner file (or, without one, the folder itself) was last touched
   more than 5 minutes ago — whatever process or machine it names, since
   pids and hostnames repeat across containers and a heartbeat does
   not. The owner file's `<pid> <hostname>` is there for you to read;
   nothing judges by it. Ages are read against this machine's clock: if
   several servers share `data` over a network filesystem, keep their
   clocks (and the file server's) within a minute of each other, with
   NTP. An entry whose age cannot be read, or that cannot be removed, is
   kept and logged: `bumail: the spool folder … is kept: …`;
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

**One server per data volume.** That is the layout supported: the
directory and a SQLite store are one process's at a time anyway. Two
servers sharing `data` (one with `mx = 0`, say) keep their spools apart,
each in its own folder, and neither sweeps the other's while its
heartbeat goes on — even two containers that both run as pid 1 under
one hostname.

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
already had is removed, and so is every `Authentication-Results` but
those plainly from another server (RFC 8601 §5): one is kept only when
its authserv-id, after comments and folding and unquoted, is an ASCII
host name (letters, digits, hyphens and dots), followed by nothing but
a version number and `;`, and is neither `hostname` nor a domain the
directory hosts — an administrative domain often signs its results with
its domain — compared in any case, without a trailing dot, as A-labels.
A field with no authserv-id at all, as some large providers write
them, is removed too: that is intended, as nothing in it says whose it
is. `ARC-Authentication-Results` is another field, sealed by ARC
(RFC 8617) and checked against that seal, so it is kept as is. Anything else — a control or
invisible character, a byte outside ASCII, a fullwidth or look-alike
letter or dot, an empty id, a field that does not parse — is removed,
since a reader might take it for your server's and a sender could
otherwise write `dmarc=pass` in its name. A field kept is kept byte for
byte, as is every other field.

**Where it goes.** INBOX, or Junk for a message DMARC quarantines. The
user's account and its six mailboxes are created in the store if they
are missing — at every delivery, so a role mailbox the user deleted
(Archive, Trash) comes back with the next message. A user who renamed
Junk away from its role gets quarantined mail in INBOX.

**Limits.** `inbound.maxMessageSize` (25 MiB) is announced with SIZE and
enforced as the message comes (`552 5.3.4`); `inbound.maxConnections`
(1000) are served at once, and one more is answered `421` and closed. A
header over 256 KiB is refused with `552 5.3.4 Message header too large`.
A message waits on disk, in the spool folder, while it is checked, and
is removed once delivered or refused; memory holds 64 KiB of it at a
time, and its header.

**The spool's budget.** The spool holds `inbound.spoolBytes` at most,
20 times `inbound.maxMessageSize` by default (500 MiB), every message
waiting counted as it is written. While a message as large as allowed
would not fit, MAIL FROM is answered `452 4.3.1 Insufficient system
storage, try again later`; a message that runs past the budget as it
comes is read to its end, dropped, and answered the same. The sending
server tries again later. There is no cap per client yet: one client
can hold up to `inbound.maxConnections` sessions, since `@bumail/smtp`
has no per-client limit nor a hook at connection for one; that comes
in a later release.

**No bounce is ever sent** for mail received on 25. Every refusal is a
reply during the session, so the sending server, which knows the real
sender, reports it. A message is either taken (`250`) or not; nothing is
refused after the fact. If the store fails part-way through a message to
several users, the whole message is answered `451` and the sender tries
again later: the users it reached before the failure get it twice.

## Inbound checks: SPF, DKIM, DMARC

Each message is checked with `@bumail/auth`:

- **SPF** for the MAIL FROM domain, from the client's IP, begun at MAIL
  FROM. For a bounce (`MAIL FROM:<>`), SPF checks the HELO name, and
  `Authentication-Results` says `smtp.helo=` rather than
  `smtp.mailfrom=`; DMARC still aligns it, as RFC 7489 §3.1.2 allows;
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
| fails, but DKIM did not finish within 10 s | `451 4.7.0 DMARC check failed, try again later` | INBOX |

Either way, the result is written into `Authentication-Results`. SPF on
its own never refuses a message: forwarding breaks it, and DMARC needs
only one of SPF and DKIM.

The DNS is the system's resolver, through a cache. Each query has 5
seconds per try and 2 tries, so 10 seconds at worst. DKIM, SPF and
DMARC are each cut off after 10 seconds, as `temperror`. SPF runs from
MAIL FROM, while the message comes, so after the end of DATA the checks
take 20 seconds at worst (DKIM, then DMARC), within the 60 seconds the
SMTP server gives its hook. A DKIM cut off cannot pass, so under
`enforce` a message DMARC would refuse or quarantine is deferred
instead, as a signature that would have passed may be among those not
checked.

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
2. IMAP sessions are closed at once (clients reconnect); a command
   under way is cut off with its session, but the store call it is in
   finishes;
3. SMTP sessions get 10 seconds to finish what they are sending; a
   message under way when the signal came is still taken and answered;
4. sessions still open after that are hung up on, and the server waits
   up to 5 more seconds for deliveries and every store call under way,
   IMAP's included;
5. the store, the directory and the spool folder are closed.

Each store call is atomic: the SQLite store writes each change in one
transaction, synchronously, so a close cannot fall in the middle of it,
and the PostgreSQL store's transactions roll back whole if the
connection goes. A store call still running after the 5 seconds (or a
second signal) fails, and its client is told so.

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
| `bumail: the spool folder <path> is kept: <reason>` | at start, for an entry under `<data>/spool` whose age cannot be read, or that cannot be removed |
| `mx: <id> from <ip> <sender> delivered to <users> (…)` | a message taken; `(Junk)` when quarantined |
| `mx: <id> … refused by DMARC (…)` | `550 5.7.1`, with `inbound.dmarc = "enforce"` |
| `mx: <id> … deferred: DMARC or DKIM did not finish (…)` | `451 4.7.0` |
| `mx: MAIL FROM from <ip> deferred: the spool is full`, `mx: <id> from <ip> deferred: the spool is full` | `452 4.3.1`: the spool's budget is spent |
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
