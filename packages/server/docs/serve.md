# Running the server

`bumail serve` runs the server: it receives mail from other servers on
port 25, takes mail from its own users on 465 and 587 and sends it on,
DKIM-signed, through its queue, and serves mail to clients over IMAP on
port 993. JMAP over HTTPS and the health check come in later releases;
see the [roadmap](roadmap.md).

- [Starting](#starting)
- [The listeners](#the-listeners)
- [Receiving mail on 25](#receiving-mail-on-25)
- [Inbound checks: SPF, DKIM, DMARC](#inbound-checks-spf-dkim-dmarc)
- [Sending mail on 465 and 587](#sending-mail-on-465-and-587)
- [The queue](#the-queue)
- [DKIM signing](#dkim-signing)
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
3. opens the directory, the mail store and the queue (`queue.url`);
4. binds each listener whose port is not 0, then starts the queue's
   worker.

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
mx = 25           # 0 turns it off
submissions = 465
submission = 587
imaps = 993
imap = 0          # 143, with STARTTLS; off by default
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
| 465 | `ports.submissions` | submission over TLS from the first byte (RFC 8314): the directory's users log in, then send to anywhere |
| 587 | `ports.submission` | submission with STARTTLS: AUTH only once TLS is on, then the same |
| 993 | `ports.imaps` | IMAP over TLS from the first byte, for the users of the directory |
| 143 | `ports.imap` | IMAP with STARTTLS; LOGIN and AUTHENTICATE are refused until TLS is on. Off unless you set it |

Every listener binds to `bind` (default `0.0.0.0`). The other ports of
`[ports]` — `https`, `http`, `health` — are bound to nothing: their listeners arrive in later releases, and the
log says so at start, one line each. Leave them as they are, or set
them to 0 to silence those lines.

## Receiving mail on 25

A message is taken only for an address the directory resolves:

| the recipient | the answer |
| --- | --- |
| a user (`alice@example.com`), even disabled | `250`: delivered to its INBOX |
| an alias (`sales@example.com`) | `250`: delivered to each of its users, once each |
| an unknown address in a hosted domain | `550 5.1.1 User unknown` |
| the bare `<postmaster>`, with no domain | `250`: delivered to the postmaster address, below |
| an address in any other domain | `554 5.7.1 Relay access denied` |

**The bare `<postmaster>`.** RFC 5321 §4.5.1 asks every server to take
`RCPT TO:<postmaster>`, with no domain. It goes to `postmaster`, an
address at the top of the configuration, else to `postmaster@` the
first hosted domain, by name, delivered to whichever user or alias's
users the directory resolves it to. When neither resolves, it is refused
with `550 5.1.1 No postmaster mailbox is configured here`: add a
`postmaster@` alias to your first domain, or set the key.

```toml
postmaster = "alice@example.com"
```

`<postmaster@example.com>` is an ordinary address: give it a user or an
alias.

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
host name (letters, digits, hyphens and dots), followed by nothing but a
version number and `;`, and is neither `hostname` nor a domain the
directory hosts — an administrative domain often signs its results with
its domain — compared in any case, without a trailing dot, as A-labels.
A field with no authserv-id at all, as some large providers write them,
is removed too: that is intended, as nothing in it says whose it is.
`ARC-Authentication-Results` (RFC 8617) is another field: it is kept as
is, and bumail does not check ARC. Anything else — a control or
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
time, and its header. One client — an IPv4 address, or an IPv6 /64 —
holds `inbound.maxConnectionsPerClient` (10) sessions at most; one more
is answered `421 4.7.0` and closed.

**The spool's budget.** The spool holds `inbound.spoolBytes` at most,
20 times `inbound.maxMessageSize` by default (500 MiB), every message
waiting counted as it is written. While a message as large as allowed
would not fit, MAIL FROM is answered `452 4.3.1 Insufficient system
storage, try again later`; a message that runs past the budget as it
comes is read to its end, dropped, and answered the same. The sending
server tries again later. A user's message on 465 or 587 waits in the
same spool while it is signed.

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
| fails, but DKIM did not finish within 10 s, or could not read the message back from the spool | `451 4.7.0 DMARC check failed, try again later` | INBOX |

Either way, the result is written into `Authentication-Results`. SPF on
its own never refuses a message: forwarding breaks it, and DMARC needs
only one of SPF and DKIM.

The DNS is the system's resolver, through a cache. Each query has 5
seconds per try and 2 tries, so 10 seconds at worst. DKIM, SPF and DMARC
are each cut off after 10 seconds, as `temperror`. SPF runs from MAIL
FROM, while the message comes, so after the end of DATA the checks take
20 seconds at worst (DKIM, then DMARC), within the 60 seconds the SMTP
server gives its hook. A DKIM cut off, or one that could not read the
message back from the spool, cannot pass, so under `enforce` a message
DMARC would refuse or quarantine is deferred instead, as a signature
that would have passed may be among those not checked.

## Sending mail on 465 and 587

The directory's users send mail through the server, from any mail
client:

| port | client setting | |
| --- | --- | --- |
| 465 | "SSL/TLS" | TLS from the first byte (RFC 8314), AUTH offered at once |
| 587 | "STARTTLS" | AUTH offered, and taken, only once the client ran STARTTLS |

The login is the user's address, in any case, and its password; AUTH
PLAIN and LOGIN. Each login goes through the directory as IMAP's does:
argon2id, at most 4 verifies at once, failures counted per client IP
(10 within 15 minutes block it, its right password included). Three
failed attempts in a session and the server hangs up. MAIL is refused
with `530` until the session logged in, so **nothing is ever relayed
without AUTH**, and port 25 never offers it.

**Who may send as whom.** A user sends as its own address, or as an
alias it is one of the users of (`sales@example.com`, for each of its
users), compared as the directory compares addresses, without case:

| what | otherwise |
| --- | --- |
| MAIL FROM is the user's address or one of its aliases; never `<>` | `553 5.7.1 Not authorized to send as <…>` |
| the message has one From field | `550 5.6.0 The message needs exactly one From field` |
| From names an address (not `undisclosed:;`) | `550 5.6.0 The From field must name your address` |
| every address in From is the user's or one of its aliases, written plainly | `550 5.7.1 The From field names an address that is not yours` |

From is read strictly: every `@` in it must belong to a plain address,
so a quoted local part (`<"bob"@example.com>`), or another address in
a display name or a comment (`"bob@example.com" <alice@example.com>`),
is refused, since a reader could be shown an author this check did not
see. Encoded-words (RFC 2047) are read as an allow-list, since readers
decode them differently:

- every `=?` in From must start a well-formed encoded-word, with no
  white space or fold inside it;
- its text must be strict: B as whole base64 groups, padding only at
  the end and no base64url `-` or `_`; Q with every `=` followed by two
  hex digits;
- its charset must be UTF-8, US-ASCII, ISO-8859-1 to 16 or
  windows-1250 to 1258, and a UTF-8 word must hold whole characters
  (RFC 2047 §5), so each word is read on its own and no neighbour
  completes a character in it;
- no word may hold an `@` or decode to one, nor, in UTF-8, to the
  look-alike `＠` (U+FF20) or `﹫` (U+FE6B), which are refused written
  plainly too.

So `=?UTF-8?Q?ceo=40bank.example?= <alice@example.com>` is refused like
`"ceo@bank.example" <alice@example.com>`, while
`=?UTF-8?Q?Alice_M=C3=BCller?= <alice@example.com>` is taken. **A name
in ISO-2022-JP, Shift_JIS, GB2312, Big5, EUC-KR, KOI8-R or UTF-7 is
refused**: its client must encode names in UTF-8, as current mail
clients do by default. A From field that is not valid UTF-8 written
raw (Shift_JIS or GBK bytes, say), or over 64 KiB, is refused too.

A session that logged in keeps its rights only while the user is
unchanged: once it is removed, disabled (`bumail user disable`) or given
a new password, its next MAIL FROM is refused with `553 5.7.1`, and the
client must log in again.

**Where it goes.** Each recipient in a hosted domain is delivered
straight to the store, as the MX would: its INBOX, aliases expanded, a
`Return-Path` on top; an unknown one is refused at RCPT with
`550 5.1.1 User unknown`, and the bare `<postmaster>` goes to the
postmaster address. Every other recipient goes into the
[queue](#the-queue), once per message; an address literal
(`carol@[192.0.2.1]`) is refused at RCPT with
`550 5.7.1 Mail to an address literal is not sent from here`, since it
would have the queue connect to whatever host a user names, this one's
own services included. Any `Authentication-Results`
claiming the server's name or a hosted domain is removed first, as on
port 25. The local mailboxes get the message first, the queue last,
since a queued message may leave at once and cannot be taken back; the
client is answered `250` only once both took it. Should a local
delivery fail, or the queue refuse the message, the client is told to
send it again: a local recipient that already has it may get a second
copy, but no other domain does (unless a PostgreSQL or Redis queue
store commits the item and its reply is lost, when the retry queues it
again).

**Limits.** `[submission]`: `maxMessageSize` (25 MiB) announced with
SIZE, `maxRecipients` (100) per message, `maxConnections` (1000) at once,
`maxConnectionsPerClient` (10) from one client, `handshakeTimeout` (10
seconds) for a client on 465 to complete its TLS handshake, past which
it is closed without a word. The message waits in the spool while it is
signed, within `inbound.spoolBytes`.

## The queue

Mail for another domain is kept in `@bumail/queue`'s store at
`queue.url` — `sqlite:<data>/queue` by default, PostgreSQL or Redis if
you say so — and survives a restart.

- **By MX**, by default: each recipient domain's mail hosts, in order of
  preference, STARTTLS when offered (RFC 7435: the certificate is not
  checked, which beats a passive eavesdropper). The server's `hostname`
  is its EHLO name: its address must resolve back to it, and receiving
  hosts check.
- **Through `[smarthost]`**, when there is one: every message, with its
  credentials, over TLS whose certificate checks out. `[routes]` sends a
  domain its own way (`"mx"`, `"smarthost"` or a host of its own). See
  the [guide](guide.md#smarthost).
- **Retries.** A `4xx`, a connection that fails or a timeout leaves the
  recipient deferred: tried again after 30 minutes, then 1, 2 and 4
  hours, then every 4 hours, and given up after 5 days.
- **DSNs.** A recipient refused with a `5xx`, or given up on, gets its
  sender a delivery status notification (RFC 3464): a
  `multipart/report` from `<>` with the reply and the original's header.
  The sender is always a local user, so the DSN is **delivered to its
  own mailbox, never sent out**, and nothing is ever sent about a DSN.
  Mail the queue holds for a hosted domain is delivered to the store the
  same way, whatever the route.
- **A warning DSN.** A message still deferred for a recipient 4 hours
  after it was queued gets its sender one `delayed` DSN (`Action:
  delayed`), once per message, while the queue keeps trying: the sender
  knows it is late, not lost. It comes to the sender's mailbox like any
  DSN; the failure DSN follows only if the recipient is given up on.

Each outcome is a line of the log: `outbound: … delivered to … by …`,
`… deferred until …`, `… failed: …`.

## DKIM signing

Each message a user sends is signed with the DKIM key of its From
domain (RFC 6376, rsa-sha256, relaxed), when the domain has one; the
signature covers the message as it leaves, so the copy delivered here
carries it too. A domain with no key goes unsigned, and the log line
ends in `(unsigned)`. Make a key with the `bumail` command:

```sh
bumail dkim generate example.com
```

```text
generated an RSA-2048 DKIM key for example.com, selector bumail; mail from example.com is signed with it from now on
publish this TXT record:
  name   bumail._domainkey.example.com
  value  v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA…
as a zone file line:
  bumail._domainkey.example.com. IN TXT "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0B…" "…"
```

Publish the record at your DNS host: the name and the value, or the
zone file line, whose value is split into strings of 255 bytes at most,
as TXT records must be. Mail is signed from the next message on — no
restart — so publish it soon after: until then, receivers find no key
and treat the mail as unsigned.

| command | |
| --- | --- |
| `bumail dkim generate <domain>` | an RSA-2048 key for a hosted domain, selector `bumail`; `--selector <name>` names another; `--replace` replaces the key the domain has |
| `bumail dkim show <domain>` | the record again |
| `bumail dkim list` | the domains with a key, and its selector |
| `bumail dkim remove <domain>` | removes the key: the domain's mail goes unsigned |

The private key is kept in the directory's file, which only the
server's user can read (0600), and is never printed. Removing a domain
removes its key. To change keys, generate the new one under a new
selector with `--replace`, publish its record, and keep the old record
published a few days, for mail signed with it still on its way:

```sh
bumail dkim generate example.com --selector s2 --replace
```

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

1. no listener accepts a new connection, and the queue claims nothing
   more;
2. IMAP sessions are closed at once (clients reconnect); a command
   under way is cut off with its session, but the store call it is in
   finishes;
3. SMTP sessions, on 25, 465 and 587, get 10 seconds to finish what
   they are sending; a message under way when the signal came is still
   taken and answered, and one for another domain is kept in the queue
   for the next start;
4. sessions still open after that are hung up on, and the server waits
   up to 5 more seconds for deliveries, every store call under way,
   IMAP's included, and the queue's deliveries under way; the queue
   gives back what it claimed and did not begin, due at once for the
   next start;
5. the queue, the store, the directory and the spool folder are closed.

A delivery to another server still under way after those 5 seconds (or
at a second signal) is left behind: its item keeps its lease, which
lapses after 10 minutes, and is tried again then. If the other server
took the message just before the stop, it gets it twice; the log says
`bumail: queue deliveries still under way are left to their leases`.

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
bumail: submissions listening on 0.0.0.0:465: submission over TLS from the first byte: AUTH required, then mail to anywhere
bumail: submission listening on 0.0.0.0:587: submission with STARTTLS: AUTH only after TLS, then mail to anywhere
bumail: imaps listening on 0.0.0.0:993: IMAP over TLS from the first byte
bumail: https (port 443) arrives in a later slice; not listening
mx: 1kq2f… from 192.0.2.10 <joe@example.org> delivered to alice@example.com (spf=pass dkim=pass dmarc=pass)
mx: 1kq2g… from 203.0.113.5 <ceo@example.net> refused by DMARC (spf=fail dkim=none dmarc=fail)
submissions: 7cd1a… from alice@example.com <alice@example.com> delivered to bob@example.com; queued as 0f3e… for joe@example.org
outbound: 0f3e… <alice@example.com> delivered to joe@example.org by mx.example.org
imaps: login refused from 203.0.113.9: password
bumail: SIGTERM, stopping
bumail: stopped
```

| line | when |
| --- | --- |
| `bumail: <listener> listening on <address>:<port>: …` | at start, one per listener |
| `bumail: <name> (port <n>) arrives in a later slice; not listening` | at start, for each later port not 0 |
| `bumail: the spool folder <path> is kept: <reason>` | at start, for an entry under `<data>/spool` whose age cannot be read, or that cannot be removed |
| `bumail: the spool folder <path> was removed while in use; made it again` | another server swept this one's spool folder (the process was paused past 5 minutes, or the clocks disagree): the next heartbeat, or the next message, made it again |
| `mx: <id> from <ip> <sender> delivered to <users> (…)` | a message taken; `(Junk)` when quarantined |
| `mx: <id> … refused by DMARC (…)` | `550 5.7.1`, with `inbound.dmarc = "enforce"` |
| `mx: <id> … deferred: DMARC or DKIM did not finish (…)` | `451 4.7.0` |
| `mx: MAIL FROM from <ip> deferred: the spool is full`, `mx: <id> from <ip> deferred: the spool is full` (`submissions:`, `submission:` too) | `452 4.3.1`: the spool's budget is spent |
| `mx: <id> … refused: its header is over 256 KiB` (`submissions:`, `submission:` too) | `552 5.3.4` |
| `mx: <id> … refused: no recipient is here any longer` | every recipient was removed between RCPT and the end of DATA |
| `mx: <id> from <ip> not spooled: …` (`submissions:`, `submission:` too) | the spool could not take the message (a full disk, say): the client got `451` |
| `mx: <id> … abandoned before <user>: the session ended` (`submissions:`, `submission:` too) | the session ended while the message was being written: the users before `<user>` have it |
| `mx: error in a session from <ip>: …` (`submissions:`, `submission:` too) | the store or the directory failed, or a message's checks ran past the 60 s hook timeout: the client got `451` |
| `imaps: login refused from <ip>: <reason>` (`imap:` on 143, `submissions:` on 465, `submission:` on 587) | `password`, `unknown`, `disabled`, `blocked`, `malformed` or `busy` |
| `submissions: <id> from <user> <sender> delivered to <users>; queued as <item> for <recipients>` (`submission:` on 587) | a message sent: each part only when it has recipients, `(unsigned)` at the end when its From domain has no DKIM key |
| `submissions: <id> from <user> <sender> taken for nobody here any longer` | a message taken whose every local recipient was removed between RCPT and the end of DATA, with none for another domain: nothing was delivered or queued |
| `submissions: <user> from <ip> refused as sender <address>` | `553 5.7.1`: MAIL FROM another address |
| `submissions: <id> … refused: it has no From field, or several`, `… refused: its From field names no address`, `… refused: its From field names another address` | `550 5.6.0`, `550 5.6.0`, `550 5.7.1`; a display name, a comment or an encoded-word holding an address counts as another address |
| `submissions: <user> from <ip> refused as sender <address>`, after a login that went through | the user was removed, disabled or given a new password since the session logged in: it logs in again |
| `submissions: <id> … not queued: …` | the queue refused the message: the client got `452`, `552` or `451` |
| `outbound: <item> <sender> delivered to <recipient> by <host>` | a recipient's server, or the smarthost, took it; `by` the server's own name for a hosted domain, a DSN included |
| `outbound: <item> to <recipient> deferred until <time>: …` | a `4xx` or a failure to reach it: tried again then |
| `outbound: <item> to <recipient> failed: …` | a `5xx`, or given up on after 5 days |
| `outbound: <item>: a failed DSN to <sender> queued as <item>` | the DSN of that failure, for the sender's own mailbox (`delayed` for a warning) |
| `outbound: error[ on <item>]: …` | the queue's store failed, a lease was lost, or a route cannot be used |
| `imaps: error in a session from <ip>: …` (`imap:` on 143) | the store failed: the client got `NO [UNAVAILABLE]` |
| `bumail: postmaster <address> is in <domain>, a domain not hosted here; mail for <postmaster> is refused until it is` | at start: `postmaster` names a domain the directory does not host (`bumail domain add`) |
| `bumail: SIGTERM, stopping`, `bumail: stopped` | the stop |
| `bumail: the mail store did not close cleanly: …`, `bumail: the queue did not close cleanly: …` | during the stop: a store's close failed; the directory is closed anyway, and it exits 0 |
| `bumail: the queue did not stop cleanly: …` | during the stop: the queue's store failed as the queue gave back its claims; they lapse with their leases |
| `bumail: queue deliveries still under way are left to their leases` | during the stop: a delivery to another server outlasted the wait, and is tried again once its lease lapses |
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
server.listening; // [{ name: 'mx', hostname: '0.0.0.0', port: 25 }, { name: 'submissions', … }, …]

process.on('SIGTERM', () => void server.stop());
```

`resolver` replaces the DNS, with any `Resolver` of `@bumail/dns` (a
`fixtureResolver` in a test): the inbound checks', and the queue's MX
lookups. `outbound` is for a test too: `mxPort` (the port MX hosts
listen on, 25 by default), `ca` (a certificate a smarthost or a route's
host may present, PEM), `pollInterval` (milliseconds between the
queue's looks, 5000) and `send` (what delivers to another server,
`sendMail` of `@bumail/smtp/client`). `stop({ force: true })` skips the
waits.
