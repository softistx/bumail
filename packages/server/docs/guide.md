# Configuration reference

`@bumail/server` reads one TOML file. This page lists every key it
takes, with its default; anything else is refused, with the closest key
it knows (`max_message_size` → `maxMessageSize`). When something is
wrong, [troubleshooting](troubleshooting.md) has an entry for each
problem.

- [Where the file is](#where-the-file-is)
- [The environment](#the-environment)
- [Checking a file](#checking-a-file)
- [Top-level keys](#top-level-keys): `hostname`, `postmaster`, `data`, `bind`
- [`[ports]`](#ports)
- [`[store]`, `[queue]`, `[directory]`](#store-queue-directory)
- [`[tls]` and `[acme]`](#tls-and-acme)
- [`[smarthost]`](#smarthost)
- [`[routes]`](#routes)
- [`[inbound]`](#inbound)
- [`[submission]`](#submission)
- [`[jmap]`](#jmap)
- [`[health]`](#health)
- [`[proxyProtocol]`](#proxyprotocol)
- [What is never an option](#what-is-never-an-option)
- [From code](#from-code)

## Where the file is

The first of:

1. `--config <file>` on the command line (`--config=<file>` works too);
2. `BUMAIL_CONFIG`;
3. `/data/bumail.toml`, on the volume the Docker image will mount.

A relative path inside the file — `tls.cert`, `tls.key`,
`smarthost.passwordFile` — starts from the file's own directory.

## The environment

The environment overrides **URLs and secrets only**, and always wins over
the file. Everything else is in the file, so one place says how the
server runs.

| variable | sets |
| --- | --- |
| `BUMAIL_HOSTNAME` | `hostname` |
| `BUMAIL_STORE_URL` | `store.url` |
| `BUMAIL_QUEUE_URL` | `queue.url` |
| `BUMAIL_SMARTHOST_PASSWORD` | `smarthost.password`, over `password` and `passwordFile` both |

Each also comes as `*_FILE`, naming a file that holds the value, as
Docker and Kubernetes mount secrets; one trailing line break is dropped.
Every file read — the configuration, `tls.cert`, `tls.key`,
`smarthost.passwordFile`, a `_FILE` — must be a regular file (a symbolic
link to one is followed) of 1 MiB at most.
Give a variable or its `_FILE`, not both. An empty variable counts as
unset.

```sh
BUMAIL_STORE_URL_FILE=/run/secrets/store-url \
BUMAIL_SMARTHOST_PASSWORD_FILE=/run/secrets/smarthost \
bumail check-config
```

A problem with a value from the environment names the variable:
`store.url (BUMAIL_STORE_URL): …`.

## Checking a file

```sh
bumail check-config --config ./bumail.toml
```

```text
./bumail.toml: ok
  hostname      mail.example.com
  data          /data
  listening     0.0.0.0: mx 25, submissions 465, submission 587, imaps 993, https 443, http 80, health 8080 (loopback)
  tls           acme
  store         sqlite
  queue         sqlite
  directory     sqlite
  outbound      mx
  inbound dmarc enforce
  jmap          https://mail.example.com
```

A store is shown by its scheme only. Behind a proxy the `jmap` row says
so (`https://mail.example.com (behind 1 trusted proxy, plain HTTP on
0.0.0.0:8081)`), and `[proxyProtocol]` adds a `mail proxies` row. With problems, every one is listed
(`bumail: <file>:` then one `  path: problem` line each) and the command
exits 1. No problem repeats a URL or a secret.

| exit code | meaning |
| --- | --- |
| 0 | valid (`check-config`), stopped cleanly (`serve`), or `-h`/`--help`, `-v`/`--version` |
| 1 | the configuration has problems, or cannot be read |
| 2 | bad usage: an unknown command or option |
| 3 | `serve`: the configuration is valid, but asks for what arrives later (`tls.mode = "acme"`) |
| 5 | `serve`: a port, the certificate, the spool, the directory, the store or the queue cannot be used |

## Top-level keys

```toml
hostname = "mail.example.com"
postmaster = "alice@example.com"
data = "/data"
bind = "0.0.0.0"
```

| key | default | |
| --- | --- | --- |
| `hostname` | required | the server's own name: its MX host, the name in its greeting, the name its certificate must hold. A fully qualified name, taken lowercase, a trailing dot dropped. `BUMAIL_HOSTNAME` overrides it |
| `postmaster` | `postmaster@` the first hosted domain, by name | where the bare `RCPT TO:<postmaster>` (RFC 5321 §4.5.1) goes: an address the directory resolves, a user or an alias. Taken lowercase. When it does not resolve, that recipient is refused with `550 5.1.1` |
| `data` | `/data` | an absolute directory, for everything the server keeps: the default stores below, and the ACME certificates |
| `bind` | `0.0.0.0` | the IPv4 or IPv6 address every public listener binds to; `::` for both families where the host allows it |

## `[ports]`

Each listener's port, a whole number from 0 to 65535 (`25.5` is refused;
TOML's `25.0` reads as 25); `0` turns it off. Two listeners never share
a port. `bumail serve` runs `mx`, `submissions`, `submission`, `imaps`,
`imap`, `https` and `health` today, and logs `http` as arriving later;
[running the server](serve.md#the-listeners) says what each does.

| key | default | listener |
| --- | --- | --- |
| `mx` | 25 | SMTP from other servers. Never AUTH here, and never relaying |
| `submissions` | 465 | submission over implicit TLS (RFC 8314) |
| `submission` | 587 | submission with STARTTLS |
| `imaps` | 993 | IMAP over implicit TLS |
| `imap` | 0 | IMAP with STARTTLS; off unless you turn it on |
| `https` | 443 | JMAP: HTTPS from the certificate files, or, with `jmap.mode = "proxy"`, plain HTTP for a proxy that ends TLS, on the port you set |
| `http` | 80 | ACME's HTTP-01 challenges; needed with `tls.mode = "acme"` |
| `health` | 8080 | the health check, on loopback unless `[health]` says otherwise |

## `[store]`, `[queue]`, `[directory]`

Each is a `url`, which says which store answers.

| section | default | schemes |
| --- | --- | --- |
| `[store]`, the mail | `sqlite:<data>/mail` | `sqlite:`, `postgres:`, `postgresql:` |
| `[queue]`, outbound mail, kept until delivered | `sqlite:<data>/queue` | `sqlite:`, `postgres:`, `postgresql:`, `redis:`, `rediss:` |
| `[directory]`, domains, users and aliases | `sqlite:<data>/directory.sqlite` | `sqlite:` |

```toml
[store]
url = "postgres://bumail@db.internal/mail?sslmode=verify-full"

[queue]
url = "rediss://cache.internal:6380"
```

- `sqlite:` takes an absolute path, with no host: `sqlite:/data/mail`.
- A URL that carries credentials to another machine must encrypt them:
  `rediss:` for Redis, `sslmode=require`, `verify-ca` or `verify-full`
  for PostgreSQL. Credentials to `localhost`, `127.0.0.1` or `::1` may
  go in clear.
- PostgreSQL's TLS is decided as Bun will connect: from `sslmode`,
  `ssl`, `tls` and `PGSSLMODE` together, so `sslmode=require&ssl=false`
  is refused. A password in `PGPASSWORD`, which Bun sends when the URL
  holds none, counts as credentials, and `PGHOST` names the host when
  the URL does not.
- Redis credentials go before the host (`rediss://:password@host`):
  Bun ignores `?password=`, which is refused. A user alone
  (`redis://secret@host`) counts as credentials, since Bun sends it as
  a password. Bun's Redis client reads no password from the
  environment, and `REDIS_URL` only when given no URL, which the server
  never is.
- A URL with a password is a secret: keep it out of the file, in
  `BUMAIL_STORE_URL_FILE` or `BUMAIL_QUEUE_URL_FILE`.
- The directory is one SQLite file, managed by `bumail domain`, `user`
  and `alias`: [the directory](directory.md) has every command.

### Credentials in clear, when you choose it

Refusal is the default. Where the network between the server and its
database is yours alone (a private Docker network, a host-only link),
you can let the credentials cross it in clear, in so many words:

```toml
[store]
url = "postgres://bumail:…@db:5432/mail?sslmode=disable"   # PostgreSQL: sslmode=disable, once

[queue]
url = "redis://:…@cache:6379"
insecure = true                                           # Redis: insecure, in [store] or [queue]
```

| key | default | |
| --- | --- | --- |
| `store.insecure`, `queue.insecure` | `false` | `true` lets a `redis:` URL send its password to another host in clear. Refused anywhere it means nothing: with `rediss:`, without a password, on loopback, with SQLite or PostgreSQL |

**The risk**: anyone who can read that network — another container on
it, a compromised host, a misrouted link — reads the password, and with
it every message the store or the queue holds; the mail itself crosses
in clear too. `check-config` shows such a store as `postgres
(plaintext)` or `redis (plaintext)`, so the choice stays visible.
`insecure = true` covers the URL in effect, so a `redis:` URL set
through `BUMAIL_STORE_URL` or `BUMAIL_QUEUE_URL` (or its `_FILE`) too.

## `[tls]` and `[acme]`

Where the certificate comes from. It covers SMTP's STARTTLS and implicit
TLS, IMAP and HTTPS alike.

```toml
[tls]
mode = "acme"   # the default

[acme]
email = "postmaster@example.com"
acceptTerms = true
directory = "https://acme-v02.api.letsencrypt.org/directory"   # the default
```

| key | default | |
| --- | --- | --- |
| `tls.mode` | `"acme"` | `"acme"`: obtained and renewed from an ACME CA. `"files"`: read from `cert` and `key` |
| `tls.cert` | required with `"files"` | the certificate chain, PEM, leaf first |
| `tls.key` | required with `"files"` | its private key, PEM, unencrypted |
| `tls.pollSeconds` | `30` | with `"files"`: seconds between two looks at the files for a renewed pair, 0 to 86400; 0 looks only on SIGHUP; refused with `"acme"` |
| `acme.email` | required with `"acme"` | the account's contact, for the CA's expiry notices |
| `acme.acceptTerms` | required with `"acme"` | must be `true`: you have read the CA's terms of service and accept them |
| `acme.directory` | Let's Encrypt | the CA's directory URL, `https:` |

`bumail serve` takes `"files"` only for now, and exits 3 with `"acme"`,
which `check-config` still takes. The files are read at start, and read
again every `tls.pollSeconds` and on SIGHUP: a renewed pair that is valid
takes effect on every TLS listener without a restart, and the old pair
stays when it is not
([Renewing the certificate](serve.md#renewing-the-certificate)).
`tls.pollSeconds` is only for `"files"`: with `"acme"`, it is refused.

```toml
[tls]
mode = "files"
cert = "/etc/bumail/fullchain.pem"
key = "/etc/bumail/privkey.pem"
pollSeconds = 60   # the default is 30; 0: only on SIGHUP
```

With `"acme"`, certificates come by HTTP-01 on `ports.http`, so it must
not be 0, and port 80 must reach the server from the Internet. `cert`
and `key` are refused there, and `[acme]` is refused with `"files"`.

With `"files"`, `check-config` reads both files and checks that:

- each is a regular file, of 1 MiB at most, and readable;
- the certificate is PEM, already valid and not expired;
- it names `hostname`, in its subject alternative names or its CN
  (a wildcard counts);
- the key is PEM, unencrypted, and is the certificate's own.

```toml
[tls]
mode = "files"
cert = "/etc/bumail/fullchain.pem"
key = "/etc/bumail/privkey.pem"
```

## `[smarthost]`

Where outbound mail goes when it does not go by MX: a provider's
submission port, where port 25 out is blocked or no PTR record can be
set. Leave the section out to deliver by MX.

```toml
[smarthost]
host = "smtp.example.net"
port = 465
username = "bumail"
passwordFile = "/run/secrets/smarthost"
```

| key | default | |
| --- | --- | --- |
| `host` | required | a host name or an IP address |
| `port` | 465 with `secure`, else 587 | |
| `secure` | `true` on port 465 | TLS from the first byte |
| `tls` | `"required"` with a `username` or `secure`, else `"opportunistic"` | STARTTLS: `"required"`, `"opportunistic"` or `"none"` |
| `username` | none | needs a password |
| `password` | none | in the file; prefer `passwordFile` or the environment |
| `passwordFile` | none | a file holding the password; one trailing line break is dropped |

Give `password` or `passwordFile`, not both; `BUMAIL_SMARTHOST_PASSWORD`
(or its `_FILE`) wins over either. Credentials go only over TLS: with a
`username`, `secure = true` or `tls = "required"`.

## `[routes]`

A route per recipient domain, over the default (the smarthost when there
is one, else MX). A domain's key is its name, quoted, since it holds
dots.

```toml
[routes]
"example.org" = "mx"                 # by MX, even with a smarthost
"example.com" = "smarthost"          # through [smarthost], which must exist
"partner.example" = { host = "mx.partner.example", port = 25, tls = "required" }
```

Two keys for one domain (`"example.org"` and `"Example.ORG."`) are
refused. A route of its own takes `host`, `port`, `secure` and `tls`, as
`[smarthost]` does, and no credentials.

## `[inbound]`

Mail from other servers, on `ports.mx`. What each DMARC outcome does is
in [running the server](serve.md#inbound-checks-spf-dkim-dmarc).

| key | default | |
| --- | --- | --- |
| `dmarc` | `"enforce"` | `"enforce"`: a message failing DMARC under `p=reject` is refused during the session, under `p=quarantine` it goes to Junk. `"mark"`: only recorded, in `Authentication-Results` |
| `maxMessageSize` | 26214400 (25 MiB) | bytes, from 1 to 1073741824 |
| `maxConnections` | 1000 | from 1 to 100000 |
| `maxConnectionsPerClient` | 10 | sessions one client holds at once, from 1 to 100000: an IPv4 address, or an IPv6 address by its /64. One more is answered `421 4.7.0` and closed |
| `spoolBytes` | 20 × `maxMessageSize` (500 MiB) | bytes the messages waiting to be checked may hold on disk at once; past it, `452 4.3.1`. At least `maxMessageSize`, at most 1099511627776 (1 TiB) |

## `[submission]`

Mail from the server's own users, on `ports.submissions` and
`ports.submission`, always authenticated, always over TLS. What it
takes, and where it goes, is in [running the
server](serve.md#sending-mail-on-465-and-587).

```toml
[submission]
maxRecipients = 50
maxConnectionsPerClient = 20   # users behind one NAT
```

| key | default | |
| --- | --- | --- |
| `maxMessageSize` | 26214400 (25 MiB) | bytes, from 1 to 1073741824 |
| `maxRecipients` | 100 | per message, from 1 to 10000 |
| `maxConnections` | 1000 | from 1 to 100000 |
| `maxConnectionsPerClient` | 10 | sessions one client holds at once, from 1 to 100000, as `inbound`'s |
| `handshakeTimeout` | 10 | seconds a client on `ports.submissions` has to complete its TLS handshake, from 1 to 300; past it, the socket is closed. A STARTTLS handshake on 587 is bounded by the session's idle time |

## `[jmap]`

JMAP (RFC 8620, RFC 8621) for the users of the directory, on
`ports.https`, served from the same store as IMAP. Clients log in with
**HTTP Basic**: the user's address and password, checked by the
directory through the same failure limiter as IMAP and submission.
There are no Bearer tokens. Basic is taken only over TLS: from the
server's own HTTPS, or, behind a proxy, when the proxy says it ended
TLS. [Running the server](serve.md#jmap-over-https) has the details.

```toml
# Direct HTTPS, the default: TLS from [tls], on 443
[jmap]
origin = "https://mail.example.com"   # the default
```

```toml
# Behind Traefik, or any HTTP reverse proxy that ends TLS
[ports]
https = 8081                          # plain HTTP, where the proxy connects

[jmap]
mode = "proxy"
origin = "https://mail.example.com"
trusted = ["172.18.0.0/16"]           # the proxy's addresses
bind = "0.0.0.0"
```

| key | default | |
| --- | --- | --- |
| `mode` | `"https"` | `"https"`: TLS from `tls.cert` and `tls.key`, on `ports.https`. `"proxy"`: plain HTTP on `ports.https`, accepted for the `trusted` proxies' forwarded client and scheme |
| `origin` | `https://<hostname>`, with `:<ports.https>` when it is neither 443 nor 0. **Required** with `"proxy"` | the public URL clients reach JMAP at: an `https:` origin, no path. The session's `apiUrl`, `downloadUrl` and `uploadUrl` start with it. It is configuration, never taken from the request's `Host` or `X-Forwarded-Host` |
| `trusted` | required with `"proxy"`; refused with `"https"` | the proxies: IPv4 and IPv6 addresses and CIDRs, at least one (`["10.0.0.5", "172.18.0.0/16", "fd00::/8"]`). The rules are `@bumail/smtp`'s: a `0` prefix, a host name, a zone or an IPv4-mapped prefix below 96 is refused, an IPv4-mapped entry is its IPv4 address, and a network of one family never matches the other |
| `bind` | `bind` | the address JMAP binds to: an IPv4 or IPv6 address. Behind a proxy, never a unix socket |
| `reloadTls` | `true` | with `"https"`: whether a renewed certificate reaches JMAP while it runs. It needs the port opened shareable (`SO_REUSEPORT`), which on a host shared with other users lets another process of the same user bind it too: `false` binds it alone, and JMAP takes the new certificate at the next start. Moot with `"proxy"`, which is plain HTTP |

`ports.https` must be set explicitly with `"proxy"`: its default, 443,
is the public HTTPS port, not where a proxy connects. `0` turns JMAP
off.

**Which client is it.** The login limiter counts failures per client
address, so it needs the client's, not the proxy's. With `"https"` it
is the TCP peer. With `"proxy"`:

- a request from a **trusted** peer: the client is the right-most
  `X-Forwarded-For` entry that is not itself a trusted proxy, and the
  request counts as TLS when the right-most `X-Forwarded-Proto` is
  `https`. What a client wrote to the left of the chain is never read
  past that entry, so a spoofed `X-Forwarded-For` does not choose the
  bucket. With no usable entry (none, only proxies, or one that is no IP
  address) the client is the peer;
- a request from a peer that is **not** trusted is answered **403**
  before anything else is read: no header, no login, no route. Only the
  proxies are served, so `X-Forwarded-For` and `X-Forwarded-Proto` from
  anyone else count for nothing;
- an address is counted as one text, whichever listener it came to:
  RFC 5952's form, an IPv4-mapped address as its IPv4 address. So one
  client is one entry of the failure limiter across JMAP, IMAP and
  submission;
- a listener with no client address to count (a unix socket) is not
  started: `serve` exits 5. `check-config` takes only IP addresses for
  `jmap.bind`, so this can only come from code that builds the
  configuration itself.

The environment sets none of these keys. Behind Traefik: [running the
server](serve.md#behind-traefik).

## `[health]`

The health check, `GET /healthz`, on `ports.health`.

| key | default | |
| --- | --- | --- |
| `bind` | `127.0.0.1` | the address it binds to: an IPv4 or IPv6 address. Loopback by default, since a Docker health check runs inside the container. The body holds no secret, but nothing else needs to reach it |

```toml
[ports]
health = 8080     # 0 turns it off

[health]
bind = "127.0.0.1"
```

What it answers is in [running the server](serve.md#the-health-check).

## `[proxyProtocol]`

Off by default: the mail ports are published directly, and the client
is the TCP peer. Where a TCP proxy sits in front of them (a Traefik TCP
router, HAProxy), list it here, and the SMTP listeners (25, 465, 587)
and the IMAP listeners (993, and 143 when on) read the PROXY protocol
(version 1 or 2) **from those peers**, so every limit and log line
names the client, not the proxy.

```toml
[proxyProtocol]
trusted = ["172.18.0.0/16"]
```

| key | default | |
| --- | --- | --- |
| `trusted` | required with the table | the proxies: IPv4 and IPv6 addresses and CIDRs, at least one, as `jmap.trusted`. A trusted peer must send a header first, or it is reset; a peer not listed is served directly, with no header read. There is one list for every mail listener |

Leave the table out to turn it off. Take the list from the proxy, never
from the Internet: a trusted peer names any client it likes. [Running the
server](serve.md#behind-a-tcp-proxy-the-proxy-protocol) has Traefik's side.

## What is never an option

`relay`, `mynetworks` and `trustedNetworks` are refused wherever they
appear, in any case or spelling (`RELAY`, `my_networks`): `not an option: bumail never relays without AUTH`. Mail for a
domain the server does not host is taken only from an authenticated
session, on submission, over TLS; no address, network or setting
changes that.

## From code

`readConfig` does what `check-config` does, and answers the
configuration with every default filled in, every `*File` read and the
environment applied:

```ts
import { readConfig, ServerError } from '@bumail/server';

try {
	const config = await readConfig({
		path: './bumail.toml', // default BUMAIL_CONFIG, then /data/bumail.toml
		env: process.env, // the default
	});
	config.tls.mode; // 'acme' | 'files'
	config.smarthost?.password; // read from passwordFile or the environment
} catch (error) {
	if (!(error instanceof ServerError) || error.code !== 'INVALID_CONFIG') {
		throw error;
	}
	for (const { path, problem } of error.problems) console.error(path, problem);
}
```
