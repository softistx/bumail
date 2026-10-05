# Running the server

`bumail serve` runs the server: it receives mail from other servers on
port 25, takes mail from its own users on 465 and 587 and sends it on,
DKIM-signed, through its queue, and serves mail to clients over IMAP on
port 993 and over JMAP on 443, and answers a health check on loopback. It
runs directly on the Internet, or behind Traefik. Its certificate is read
from files, or obtained and renewed from an ACME CA; see the
[roadmap](roadmap.md) for what comes next.

- [Starting](#starting)
- [The listeners](#the-listeners)
- [Receiving mail on 25](#receiving-mail-on-25)
- [Inbound checks: SPF, DKIM, DMARC](#inbound-checks-spf-dkim-dmarc)
- [Sending mail on 465 and 587](#sending-mail-on-465-and-587)
- [The queue](#the-queue)
- [DKIM signing](#dkim-signing)
- [Checking your DNS](#checking-your-dns)
- [Reading mail over IMAP](#reading-mail-over-imap)
- [JMAP over HTTPS](#jmap-over-https)
- [Behind Traefik](#behind-traefik)
- [Certificates from ACME](#certificates-from-acme)
- [The health check](#the-health-check)
- [Behind a TCP proxy: the PROXY protocol](#behind-a-tcp-proxy-the-proxy-protocol)
- [Stopping](#stopping)
- [The log](#the-log)
- [From code](#from-code)

## Starting

```sh
bumail serve --config /data/bumail.toml
```

It reads and checks the configuration whole, as `check-config` does,
and stops at the first thing it cannot do:

1. takes the certificate: with `tls.mode = "files"`, reads the certificate
   and its key; with `tls.mode = "acme"` (the **default**), reads the pair
   kept on the volume, and, when there is none that is usable, obtains
   one before any TLS listener starts
   ([Certificates from ACME](#certificates-from-acme));
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
4. binds each listener whose port is not 0 (port 80 only with
   `tls.mode = "acme"`), the health check last, then starts the queue's
   worker.

A port it cannot bind (another process holds it, or port 25, 443 or 993 needs
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
https = 443       # JMAP
health = 8080     # on loopback
```

**One server per data volume.** That is the layout supported: the
directory and a SQLite store are one process's at a time anyway. Two
servers sharing `data` (one with `mx = 0`, say) keep their spools apart,
each in its own folder, and neither sweeps the other's while its
heartbeat goes on — even two containers that both run as pid 1 under
one hostname.

The certificate is looked at again while the server runs: after renewing
it, [nothing needs a restart](#renewing-the-certificate); with ACME, the
server renews it itself.

## The listeners

| port | key | what it does |
| --- | --- | --- |
| 25 | `ports.mx` | SMTP from other servers: mail for the addresses the directory holds. STARTTLS offered, never required; never AUTH; never relaying |
| 465 | `ports.submissions` | submission over TLS from the first byte (RFC 8314): the directory's users log in, then send to anywhere |
| 587 | `ports.submission` | submission with STARTTLS: AUTH only once TLS is on, then the same |
| 993 | `ports.imaps` | IMAP over TLS from the first byte, for the users of the directory |
| 143 | `ports.imap` | IMAP with STARTTLS; LOGIN and AUTHENTICATE are refused until TLS is on. Off unless you set it |
| 443 | `ports.https` | JMAP over HTTPS, Basic auth for the directory's users; or, with `jmap.mode = "proxy"`, plain HTTP for a proxy that ends TLS, on the port you set |
| 80 | `ports.http` | ACME's HTTP-01 challenges, with `tls.mode = "acme"` only: nothing else is served ([Certificates from ACME](#certificates-from-acme)) |
| 8080 | `ports.health` | `GET /healthz`, on loopback by default |

Every mail listener binds to `bind` (default `0.0.0.0`); JMAP to
`jmap.bind` (default `bind`); the health check to `health.bind`
(default `127.0.0.1`); the challenge listener to `acme.bind` (default
`bind`).

A renewed certificate reaches all the TLS listeners without a restart:
see [Renewing the certificate](#renewing-the-certificate).

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

Publish the record at your DNS host (`bumail dns` prints it with the
others, and [checks it](#checking-your-dns)): the name and the value, or the
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

## Checking your DNS

A server nobody can find, or whose mail receivers distrust, is the usual
way a deployment fails, and it is all DNS. `bumail dns` prints what
to publish and checks that you did:

```sh
bumail domain add example.com
bumail user add alice@example.com
bumail dkim generate example.com
bumail dns example.com --ip 192.0.2.10          # copy these into your DNS host
bumail dns example.com --ip 192.0.2.10 --check  # a few minutes later: exits 0 when all is there
bumail serve
```

The records are the MX, the host name's A and AAAA, SPF, the DKIM key,
DMARC and the autoconfig SRV records; [the directory page](directory.md#bumail-dns)
has the output, what each is for, and why DMARC starts at `quarantine`.
Run `--check` again after any change, and from a machine that is not the
server: a DNS answer can differ from outside. Two things it cannot do:
the reverse DNS (PTR) of the server's address is set at your hosting
provider, and many receivers refuse mail without one that matches the
host name; and port 25 outbound is blocked by some providers, which no
DNS record fixes.

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

## JMAP over HTTPS

`@bumail/jmap` serves the same mailboxes as IMAP, from the store the
server opened: the session at `/.well-known/jmap`, the API at
`/jmap/api`, blob download and upload under `/jmap`. Every route
authenticates first, with **HTTP Basic**: the user's address and
password, checked by the directory through the failure limiter IMAP and
submission share, so ten failures from one client within 15 minutes
block it, its right password included. A Bearer token is refused with a
401: there are none. Basic is taken only over TLS; on a clear request it
is refused with a 403 before the password is read. The method is checked
after the credentials: a request with the wrong method gets the 401 until
it authenticates, and a wrong password on it counts as a failure like any
other; only an authenticated client gets the 405 and its `Allow`.

By default (`jmap.mode = "https"`) it is HTTPS on `ports.https`, 443,
with the certificate of `[tls]`, which a [renewal](#renewing-the-certificate)
replaces like the mail listeners'. The client the limiter counts is the TCP peer.

```sh
curl -u alice@example.com https://mail.example.com/.well-known/jmap
```

The session's `apiUrl`, `downloadUrl` and `uploadUrl` begin with
`jmap.origin`, the public URL (default `https://<hostname>`), whatever
`Host` the request carried. At a stop, JMAP stops
accepting and its requests under way get the drain time (10 seconds)
to finish, as SMTP sessions do; then their connections are closed.

A login refused is logged, as IMAP's is, never with the password:
`https: login refused from <ip>: <reason>`, the reason one of
`password`, `unknown`, `disabled`, `blocked`, `malformed` or `busy`.
Each log line of JMAP starts `https:`.

## Behind Traefik

Where Traefik (or another HTTP reverse proxy) owns port 443 and ends
TLS, run JMAP as plain HTTP for it:

```toml
[ports]
https = 8081

[jmap]
mode = "proxy"
origin = "https://mail.example.com"
trusted = ["172.18.0.0/16"]   # the Docker network Traefik reaches bumail on
```

`trusted` is required: the proxies' addresses or CIDRs. `origin` is
required: the public URL, which Traefik serves. `ports.https` must be
set, to the port Traefik connects to; keep it unpublished, on the
network the proxy shares with the server alone. A request from
any peer not in `trusted` is answered **403** at once, before any
header, login or route is looked at: only the proxies are served.
`check-config` refuses a file that leaves out any of the three.

The server then reads, from a trusted proxy only, the client in
`X-Forwarded-For` (the right-most entry that is not a trusted proxy)
and TLS in `X-Forwarded-Proto` (the right-most is `https`); see
[`[jmap]`](guide.md#jmap). So logins behind Traefik are counted per
client, not all in the proxy's one bucket. Traefik sets both headers
itself, and by default replaces any a client sent; leave
`entryPoints.<name>.forwardedHeaders.trustedIPs` unset unless another
proxy sits in front of Traefik.

Labels of the `bumail` container for an HTTP router, on an entry point
`websecure` and a certificate resolver `letsencrypt` of Traefik's own:

```yaml
services:
  bumail:
    labels:
      - traefik.enable=true
      - traefik.docker.network=proxy
      - traefik.http.routers.jmap.rule=Host(`mail.example.com`)
      - traefik.http.routers.jmap.entrypoints=websecure
      - traefik.http.routers.jmap.tls=true
      - traefik.http.routers.jmap.tls.certresolver=letsencrypt
      - traefik.http.services.jmap.loadbalancer.server.port=8081
    networks: [proxy]
```

The port is `ports.https`; the network is the one Traefik is on, and
the one `trusted` covers. This is the JMAP part only: the mail ports are
published by the container directly, or reached through Traefik's TCP
routers with [the PROXY protocol](#behind-a-tcp-proxy-the-proxy-protocol).
A mail client's JMAP discovery needs `https://mail.example.com/.well-known/jmap`
on the public name, which the router above serves.

## Certificates from ACME

With `tls.mode = "acme"`, the default, the server gets its certificate
from an ACME CA (RFC 8555), Let's Encrypt unless `acme.directory` says
otherwise, proves it holds its names by HTTP-01 on `ports.http`, and
renews the certificate by itself. One certificate covers `hostname` and
every name of `acme.names`, and serves SMTP's STARTTLS and implicit TLS,
IMAP and JMAP's HTTPS alike. The keys are in
[the guide](guide.md#tls-and-acme).

```toml
hostname = "mail.example.com"

[acme]
acceptTerms = true                   # required: the CA's terms, read and accepted
email = "postmaster@example.com"     # optional: where the CA writes about expiry
# directory = "staging"              # Let's Encrypt's staging CA, for a first try
# names = ["imap.example.com"]       # more names on the same certificate
```

Port 80 must reach the server from the Internet (or from a proxy, see
[behind Traefik](#acme-behind-traefik)), and each name must resolve to
it: the CA fetches `http://<name>/.well-known/acme-challenge/<token>`.
`check-config` refuses `ports.http = 0` with ACME.

### What is on the volume

Under `acme.dir` (default `<data>/acme`): `account.key`, the CA
account's key, made at the first start and kept; `key.pem` and
`cert.pem`, the certificate's key and its chain; `key.prev.pem` and
`cert.prev.pem`, the pair before them, once there has been a renewal.
The directory is made 0700 when the server creates it; one that exists
(`/data`, say) keeps the mode its owner gave it. Every file is mode
0600, written whole to a temporary file beside it (a name nobody can
guess, created exclusively and never through a symbolic link), synced,
renamed over the old one, and the directory synced; a temporary file
left by a write that failed is removed at once, and one left by an
earlier process is removed at the next start (only the server's own
temporaries: `<file>.<pid>.<uuid>.tmp` for its five files, so other
files in a shared directory are left alone). A new pair is
written in this order: both new files, then the old pair under the
`.prev.` names, then both renames, so a crash at any moment leaves one
whole pair under one of the two names. A new key is made for each
certificate. There is no order state to keep: one attempt is one whole
flow, and a stop in the middle of it starts the next attempt afresh.

### The first start

- **A certificate on the volume**, valid now and naming every name, is
  used at once by every TLS listener, with no call to the CA:
  `tls: using the stored certificate (<names>; expires <date>)`. One
  inside its renewal window is used too; the renewal replaces it soon
  after.
- **A pair that is not one** (a crash between the two renames of a
  renewal left the new key with the old certificate, say) falls back to
  the previous pair when that one is valid: `tls: the stored certificate
  is not used: <reason>; using the previous pair`. So does a volume with
  no current pair at all, as `tls: no certificate stored in <dir>; using
  the previous pair`. The previous pair is put back as the current one,
  and the listeners start with it. A previous pair that is expired,
  names another host or lacks a file is not used.
- **None, or an unusable one** (not there, expired, another name, a key
  that is not its own, and no valid previous pair) means the TLS
  listeners cannot start, since none can start without a pair. The server says why
  (`tls: no certificate stored in <dir>` or `tls: the stored
  certificate is not used: <reason>`), binds **port 80 and the health
  check**, and asks the CA, before it binds anything else. While it waits
  it logs `tls: waiting for a certificate from <directory>` at once and
  every 30 seconds, and the health check answers 503 with `"tls":"pending"`.
  It tries up to five times, waiting 10 s, 30 s, 1 and 2 minutes
  between (Let's Encrypt allows five failed validations of a name an
  hour), each failure logged as `tls: obtaining a certificate failed
  (try <n> of 5): <reason>`. When the CA rate limits and says how long
  to wait (`Retry-After`), the wait is at least that long; when it is
  longer than all the waits left, the server stops trying at once, as
  below. At the first success, `tls: obtained
  (<names>; expires <date>)`: the pair is on the volume, and the
  listeners start. A first start usually takes a few seconds.
- **No certificate after the last try** exits 5 with `no certificate for
  <names> from <directory> after 5 tries: <reason>. Check that each name
  resolves to this host and that port 80 (ports.http) reaches it`, having
  stopped what it started. A rate limit that asks for more than the
  waits left exits 5 at once with `no certificate for <names> from
  <directory>: the CA is rate limiting and asks to wait <wait> before
  another try, longer than the <left> the tries left would wait:
  <reason>. Start the server again after that`. Under a supervisor that
  restarts it, each restart is a new set of five tries: a CA limits how
  many failures it takes for one name an hour, so try `directory =
  "staging"` first.
- A **SIGHUP** while it waits is said and ignored: `bumail: SIGHUP, the
  server has not started yet; nothing to reload`. The wait goes on.
- A **SIGTERM** or **SIGINT** while it waits ends the wait and exits 0.

What the first start of a fresh volume logs:

```text
tls: no certificate stored in /data/acme
tls: waiting for a certificate from https://acme-v02.api.letsencrypt.org/directory
acme: the CA fetched the challenge Xe3k9QpA...
tls: obtained (mail.example.com; expires <date>)
bumail: serving mail.example.com
bumail: mx listening on 0.0.0.0:25: …
```

### Port 80

The listener answers `GET` and `HEAD` of `/.well-known/acme-challenge/<token>`
with the key authorization of a token being validated, and only of
those, through `@bumail/acme`'s `http01Responder`; a token it does not
hold is 404. A `GET /` is a `301` to `https://<hostname>/`, with the
`hostname` of the configuration: the `Host` header, the query and the
rest of the request never reach the `Location`, so it is no open
redirect. Everything else, any other path or method, is a 404. The log
has one line for the first request of each token,
`acme: the CA fetched the challenge <first 8 characters>...`, never one
per request.

### Renewal

Twice a day, plus up to an hour at random, the server reads the end of
the certificate in use (and about a minute after the start, so a
certificate stored inside its window is renewed at once). When fewer than
`acme.renewBeforeDays` days (30) remain, or a third of the certificate's
life if that is less — Let's Encrypt's six-day certificates are renewed
two days before their end — it obtains a new one, writes it to the
volume, and applies it with the same reload the certificate files get
([Renewing the certificate](#renewing-the-certificate)): every TLS
listener switches to it, or none does, and sessions already open are not
dropped. It logs `tls: reloaded (…)` from the reload, then `tls: renewed
(<names>; expires <date>)`.

A failure of any kind — the CA unreachable, a challenge that failed, a
listener refusing the pair — keeps the old certificate (a pair a
listener refused is written back over the new one), logs `tls: renewal
failed: <reason>; the current certificate stays, trying again in <wait>`,
and tries again after 10 minutes, then 30 minutes, then 1, 3 and 6 hours,
the last wait repeating, or after the CA's `Retry-After` when it rate
limited and asked for longer. The old certificate serves until it expires; the
health check turns 503 with `"tls":"down"` only then. Watch the log for
`tls: renewal failed`.

**SIGHUP** re-reads the pair on the volume and applies it if it changed
(`tls: reloaded (…)`, or `tls: unchanged (…)`): a pair you put there
yourself, say. It takes the pair only when it names `hostname` and every
name of `acme.names`; a refusal names the files by their paths in
`acme.dir` (`<dir>/cert.pem does not name <name>`). It never starts a
renewal.

### ACME behind Traefik

Behind Traefik, Traefik keeps its own certificates for HTTPS (and JMAP
runs in [proxy mode](#behind-traefik)); bumail's certificate is for the
mail ports it serves itself, and it needs the CA to reach port 80. Route
the challenge path, and only it, to bumail:

```toml
hostname = "mail.example.com"

[ports]
http = 8082          # unpublished: Traefik reaches it on the shared network

[acme]
acceptTerms = true
```

```yaml
services:
  bumail:
    labels:
      - traefik.enable=true
      - traefik.docker.network=proxy
      - traefik.http.routers.bumail-acme.rule=Host(`mail.example.com`) && PathPrefix(`/.well-known/acme-challenge/`)
      - traefik.http.routers.bumail-acme.entrypoints=web
      - traefik.http.routers.bumail-acme.priority=10000
      - traefik.http.routers.bumail-acme.service=bumail-acme
      - traefik.http.services.bumail-acme.loadbalancer.server.port=8082
    networks: [proxy]
```

`web` is Traefik's entry point on port 80. The `priority` is above the
default, which is the length of a rule, so no catch-all router of that
entry point takes the challenge first. Two things go wrong otherwise:

- **A redirect to HTTPS on the entry point itself** (`entryPoints.web.http.redirections`)
  is applied before any router: the CA is sent to 443, where JMAP answers
  it 404. Do the redirect with a middleware on a low-priority catch-all
  router instead, so the challenge router above wins.
- **Traefik's own ACME with the HTTP challenge** for the same name
  answers that path itself, ahead of every router. Give Traefik's
  certificate resolver the TLS or DNS challenge, or let it hold other
  names, so that only bumail answers `/.well-known/acme-challenge/` for
  `mail.example.com`.

The mail ports are not Traefik's here: see
[the TCP proxy](#behind-a-tcp-proxy-the-proxy-protocol) for them.

## The health check

`GET /healthz` on `ports.health` (8080), bound to `health.bind`
(default `127.0.0.1`, loopback: a Docker health check runs inside the
container). It answers **200** when

- every listener configured is up (bound, and not stopping),
- with `tls.mode = "acme"`, a certificate that has not expired is in use,
- the directory answers a lookup, and
- the mail store answers one, within 3 seconds,

and **503** otherwise. The JSON body names each part, and nothing
else: no address, no error, no secret.

```json
{"status":"ok","listeners":{"mx":"up","submissions":"up","submission":"up","imaps":"up","https":"up"},"directory":"ok","store":"ok"}
```

With the store down it is a 503, `"status":"unavailable"` and
`"store":"failed"`. A listener turned off (port 0) is not listed. Any
other path is a 404, any method but GET and HEAD a 405. With ACME the
body also has `"tls":"up"`; `"tls":"pending"` while the first
certificate is awaited, which lasts the bounded first-start tries, after
which the server exits 5; or `"tls":"down"` past the end of the last
certificate it served, whatever else is up; and `http` is among the
listeners. During a stop it
answers 503 until the health check itself is closed.

```yaml
healthcheck:
  test: ['CMD', '/usr/local/bin/bumail', 'health']
  interval: 30s
```

`bumail health` is that check: it reads `ports.health` and `health.bind`
from the configuration, asks `/healthz` and exits 0 for a 200, 1 for
anything else. The Docker image has it as its `HEALTHCHECK`, since it has
no `curl`; `--tls-pending` also exits 0 for `"tls":"pending"`, a
server waiting for its first certificate (with its port 80, the directory
and the store answering), so Traefik routes the CA's challenge to it
([deploy guide](deploy.md#behind-traefik)). It accepts `pending` only.
`pending` means this process has served no pair yet, so a stored pair
that has expired, which the server rejects at start (`tls: the stored
certificate is not used: expired`), is `pending` too, in the same bounded
wait. `"tls":"down"` is a pair that was served and has since expired, and
is unhealthy even with the flag. With `restart: unless-stopped` and a CA
that cannot be reached, the container therefore loops: each start is
healthy for the bounded tries, then the server exits 5 and Docker
restarts it. The loop shows in `docker inspect --format
'{{.RestartCount}}'` and in the log lines `tls: the stored certificate is
not used: expired` and `tls: obtaining a certificate failed (try … of …)`.

Looks that come together share one check, reused for about a
second, so a flood of them costs the store one call. The log says when it turns unhealthy, and when it is well again, not at
each look: `health: unhealthy: store`, then `health: healthy again`.
The queue is not part of it: a delivery failing shows in `outbound:`
lines.

## Behind a TCP proxy: the PROXY protocol

By default the mail ports are published directly, and the client is the
TCP peer. Behind a TCP proxy (a Traefik TCP router, HAProxy), the peer
is the proxy, and every limit, SPF check and log line would name it.
List the proxies, and the SMTP and IMAP listeners read the PROXY
protocol (HAProxy's, version 1 or 2) from them:

```toml
[proxyProtocol]
trusted = ["172.18.0.0/16"]
```

One list serves 25, 465, 587, 993 and 143. A peer in it must open with
a header, or it is reset; any other peer is served directly, with no
header read, so Internet clients can still reach a port the proxy does
not front. What a header makes of the connection, and what is refused,
is in the guides of [`@bumail/smtp`](../../smtp/docs/guide.md#running-behind-a-tcp-proxy)
and [`@bumail/imap`](../../imap/docs/guide.md#running-behind-a-tcp-proxy).
Traefik's side is a TCP router per port, with ``HostSNI(`*`)`` and no
`tls` section so STARTTLS and implicit TLS pass through to the server,
and a `serversTransport` with `proxyProtocol.version: 2`, in the
dynamic configuration, one entry point per port in the static one:

```yaml
tcp:
  routers:
    smtp:
      entryPoints: [smtp]          # ':25' in the static configuration
      rule: 'HostSNI(`*`)'
      service: smtp
    submissions:
      entryPoints: [submissions]   # ':465'
      rule: 'HostSNI(`*`)'
      service: submissions
    imaps:
      entryPoints: [imaps]         # ':993'
      rule: 'HostSNI(`*`)'
      service: imaps
  serversTransports:
    proxy-v2:
      proxyProtocol:
        version: 2
  services:
    smtp:
      loadBalancer:
        serversTransport: proxy-v2
        servers: [{ address: 'bumail:25' }]
    submissions:
      loadBalancer:
        serversTransport: proxy-v2
        servers: [{ address: 'bumail:465' }]
    imaps:
      loadBalancer:
        serversTransport: proxy-v2
        servers: [{ address: 'bumail:993' }]
```

`[proxyProtocol] trusted` holds Traefik's address on the network it
reaches `bumail` on. Port 587 is the same, with an entry point of its own.

Whatever the proxy, the certificate is the server's, from `[tls]`.

## Renewing the certificate

A renewed certificate takes effect without a restart and without
dropping an open session. `bumail serve` watches `tls.cert` and
`tls.key` (`tls.mode = "files"`), and switches every TLS listener to the
new pair: 25 and 587 for their STARTTLS, 465, 993 and 143, and JMAP's
HTTPS on 443.

- **Every `tls.pollSeconds`** (30 by default; 0 turns the polling off) it
  reads both files and compares them with the pair in use. It compares
  what the files hold, not their dates: Docker bind mounts and the
  symlink swaps of certbot or a Traefik certificate dump often raise no
  inotify event, and a `touch` that changed nothing reloads nothing. A
  symbolic link is followed.
- **On `SIGHUP`**, at once: `kill -HUP <pid>`, `docker kill -s HUP
  <container>`, or a certbot deploy hook. It logs what it found even
  when nothing changed.

A pair is taken only when it is a valid one: both files read, the
certificate PEM, in date and naming `hostname` (as `check-config`
checks), and the key its own. A key written before its certificate is
not applied half-way: the pair does not match yet, so the old one stays,
and the next look takes the new one once both files are there. Every
listener takes the pair, or none does: should one fail, those already
switched go back to the old pair; if putting one back fails too, the
line names it (`; <listener> left on the new pair, the rollback failed`).

One line says the outcome, once per change, never per look:

```text
tls: reloaded (CN=mail.example.com, expires <date>)
tls: not reloaded: tls.key is not the key of tls.cert
```

`tls: not reloaded: …` keeps the old pair, and says why: the same
reasons `check-config` gives (`tls.cert expired on …`, `tls.cert does not
name …`), each file's own name first, nothing of the key. The old pair
keeps serving until it expires: watch the log, or the certificate's date.

New connections get the new pair; a session already open keeps its TLS
until it ends. How, per listener: `@bumail/smtp` and `@bumail/imap`
take it with `setTls` (STARTTLS reads the pair for each upgrade, and
implicit TLS is upgraded socket by socket). JMAP's HTTPS is a Bun
server, which cannot swap its certificate, so a second one binds the
same port (`reusePort`) with the new pair and the first finishes its
requests. At most about 1 new handshake in 3 000 is reset in the swap;
a client retries it.

**A security consideration.** That swap needs the HTTPS port bound with
`SO_REUSEPORT` for as long as the server runs, and a socket opened so
lets any other process of the same user bind the port beside it and take
a share of its connections. In a container, the network namespace is the
container's own and nothing else runs there: the default is safe. On a
host shared with other users' processes, set `jmap.reloadTls = false`:
JMAP then binds alone, and the log says
`tls: reloaded (…); https keeps the old certificate until restart`, so
restart the server after a renewal. Behind a proxy (`jmap.mode =
"proxy"`) JMAP is plain HTTP, never swapped and never shared, whatever
`reloadTls` says. The mail ports never use `SO_REUSEPORT`.

With `tls.mode = "acme"` the pair is the one on the volume, and the
server makes the renewed pair itself
([Certificates from ACME](#certificates-from-acme)): the same reload
applies it, and `SIGHUP` reads the stored pair without renewing.

## Stopping

`SIGTERM` (as `docker stop` sends) or `SIGINT` (Ctrl-C) stops the server
cleanly:

1. no listener accepts a new connection, and the queue claims nothing
   more;
2. IMAP sessions are closed at once (clients reconnect); a command
   under way is cut off with its session, but the store call it is in
   finishes;
3. SMTP sessions, on 25, 465 and 587, and the requests under way on
   JMAP and the health check, get 10 seconds to finish what they are
   doing; a message under way when the signal came is still
   taken and answered, and one for another domain is kept in the queue
   for the next start;
4. sessions and connections still open after that are hung up on, and the server waits
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
bumail: https listening on 0.0.0.0:443: JMAP over HTTPS: Basic auth for the users of the directory
bumail: health listening on 127.0.0.1:8080: health check, GET /healthz: 200 when every listener is up and the directory and the store answer, else 503
mx: 1kq2f… from 192.0.2.10 <joe@example.org> delivered to alice@example.com (spf=pass dkim=pass dmarc=pass)
mx: 1kq2g… from 203.0.113.5 <ceo@example.net> refused by DMARC (spf=fail dkim=none dmarc=fail)
submissions: 7cd1a… from alice@example.com <alice@example.com> delivered to bob@example.com; queued as 0f3e… for joe@example.org
outbound: 0f3e… <alice@example.com> delivered to joe@example.org by mx.example.org
imaps: login refused from 203.0.113.9: password
https: login refused from 203.0.113.9: password
health: unhealthy: store
health: healthy again
bumail: SIGTERM, stopping
bumail: stopped
```

| line | when |
| --- | --- |
| `bumail: <listener> listening on <address>:<port>: …` | at start, one per listener |
| `bumail: https listening on <address>:<port>: JMAP over HTTPS: Basic auth for the users of the directory` | at start; with `jmap.mode = "proxy"`, `JMAP over plain HTTP for 1 trusted proxy, which ends TLS: Basic auth …`, or `for <n> trusted proxies, which end TLS: …` |
| `bumail: health listening on <address>:<port>: health check, GET /healthz: 200 when every listener is up and the directory and the store answer, else 503` | at start; with `tls.mode = "acme"`: `…200 when every listener is up, a certificate is in use, and the directory and the store answer, else 503` |
| `bumail: http listening on <address>:<port>: ACME HTTP-01 challenges on /.well-known/acme-challenge/, a redirect to HTTPS for GET /, 404 for the rest` | at start, with `tls.mode = "acme"` |
| `tls: using the stored certificate (<names>; expires <date>)` | at start: the pair on the volume is valid and names every name |
| `tls: no certificate stored in <dir>` | at start: none on the volume |
| `tls: no certificate stored in <dir>; using the previous pair` | at start: there is no current pair and `cert.prev.pem` with `key.prev.pem` is usable: it is put back as the current one |
| `tls: the stored certificate is not used: <reason>; using the previous pair` | at start: the current pair is not usable and `cert.prev.pem` with `key.prev.pem` is: it is put back as the current one |
| `tls: the stored certificate is not used: <reason>` | at start: `the certificate is not a PEM chain`, `not valid yet`, `expired`, `it does not name <names>`, `the key is not the certificate's` or `the key is not an unencrypted PEM private key`; the server then waits for a new one |
| `tls: waiting for a certificate from <directory>` | at start with no usable certificate, at once and every 30 seconds until it comes |
| `tls: obtaining a certificate failed (try <n> of <m>): <reason>` | a try for the first certificate failed; the next follows after its wait |
| `tls: obtained (<names>; expires <date>)` | the first certificate came and is on the volume |
| `acme: the CA fetched the challenge <token start>...` | the CA fetched a token's key authorization on port 80, once per token |
| `tls: renewed (<names>; expires <date>)` | a renewal succeeded and every listener switched to it |
| `tls: renewal failed: <reason>; the current certificate stays, trying again in <wait>` | a renewal failed: the old certificate stays, and it is tried again after the wait |
| `https: login refused from <ip>: <reason>` | a JMAP login refused: `password`, `unknown`, `disabled`, `blocked`, `malformed` or `busy`; the 401 is all the client gets. `<ip>` is the client's, behind a proxy |
| `https: error in a request from <ip>: …` | the store or the directory failed during a JMAP request: the client got a 503 or a `serverFail` |
| `https: a request with no client address was refused` | a JMAP request whose peer has no address: answered 500, never counted in the limiter's one bucket |
| `health: unhealthy: <parts>` | the health check turned 503; `<parts>` the listeners (by name), `directory` or `store` that are not well |
| `health: healthy again` | the health check is 200 again |
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
| `tls: reloaded (<subject>, expires <date>)` | a renewed pair was found, valid, and every TLS listener switched to it; its first certificate's subject and expiry |
| `tls: reloaded (…); https keeps the old certificate until restart` | with `jmap.reloadTls = false`: the other listeners took the pair, JMAP did not |
| `tls: not reloaded: <reason>; <listener> left on the new pair, the rollback failed` | a listener refused the pair and putting another back on the old one failed: it serves the new pair, the others the old |
| `tls: not reloaded: <reason>` | a pair that changed cannot be taken — a file that cannot be read, not PEM, expired, naming another host, a key that is not the certificate's, or a listener that refused — and the old pair stays; once per distinct reason, or at each `SIGHUP` |
| `tls: unchanged (<subject>, expires <date>)` | a `SIGHUP` found the files as the listeners already have them |
| `bumail: SIGHUP, the server has not started yet; nothing to reload` | a SIGHUP while `serve` waits for its first certificate: ignored, the wait goes on |
| `bumail: SIGHUP, looking for a renewed certificate` | the signal; one of the three lines above follows. With ACME it reads the pair on the volume and never renews |
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
server.listening; // [{ name: 'mx', hostname: '0.0.0.0', port: 25 }, …, { name: 'https', … }, { name: 'health', hostname: '127.0.0.1', port: 8080 }]

process.on('SIGTERM', () => void server.stop());
process.on('SIGHUP', () => void server.reloadTls()); // look for a renewed certificate now
```

`resolver` replaces the DNS, with any `Resolver` of `@bumail/dns` (a
`fixtureResolver` in a test): the inbound checks', and the queue's MX
lookups. `outbound` is for a test too: `mxPort` (the port MX hosts
listen on, 25 by default), `ca` (a certificate a smarthost or a route's
host may present, PEM), `pollInterval` (milliseconds between the
queue's looks, 5000) and `send` (what delivers to another server,
`sendMail` of `@bumail/smtp/client`). `acme` is for a test too, with
`tls.mode = "acme"`: `fetch` (the CA's calls, to trust a test CA's root),
`now`, and the timings (`checkMs`, `jitterMs`, `retryMs`, `startRetryMs`,
`waitingLogMs`, `pollMs`, `timeoutMs`). `signal` aborts the wait for a
first certificate: `serve` then rejects with `UNAVAILABLE`, having
stopped what it started. `stop({ force: true })` skips the waits.
