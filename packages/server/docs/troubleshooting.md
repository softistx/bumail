# Troubleshooting

`bumail check-config`, `bumail serve` and `readConfig` report every
problem of a configuration at once, as a `ServerError` whose `code` is
`INVALID_CONFIG`:

```text
bumail: /data/bumail.toml:
  ports.submission: 465 is also ports.submissions
  acme.email: is required with tls.mode "acme"
```

Each line is `path: problem`, and each problem has an entry below,
headed by the line as printed. The parts shown as … vary: a key, a
number, a scheme. A path is the key, dotted from the top
(`smarthost.tls`); a value from the environment adds its variable
(`store.url (BUMAIL_STORE_URL)`); `(file)` is the file itself. No
problem repeats a URL or a secret, so a URL is named by its scheme.

The command exits 1 for these, and 2 for [bad usage](#usage).

**The file**

- [`(file): cannot be read (…)`](#file-cannot-be-read-)
- [`(file): is not TOML: …`](#file-is-not-toml-)
- [`…: is not a regular file`](#-is-not-a-regular-file)
- [`…: is larger than 1 MiB`](#-is-larger-than-1-mib)

**Any key**

- [`…: unknown key; did you mean "…"?`](#-unknown-key-did-you-mean-)
- [`…: unknown key`](#-unknown-key)
- [`…: not an option: bumail never relays without AUTH`](#-not-an-option-bumail-never-relays-without-auth)
- [`…: must be a table, not …`](#-must-be-a-table-not-)
- [`…: must be a string, not …`](#-must-be-a-string-not-)
- [`…: must be true or false, not …`](#-must-be-true-or-false-not-)
- [`…: must be an integer from … to …`](#-must-be-an-integer-from--to-)
- [`…: must be "…" or "…"`](#-must-be--or-)

**Top-level keys**

- [`hostname: is required (or set BUMAIL_HOSTNAME)`](#hostname-is-required-or-set-bumail_hostname)
- [`hostname: must be a fully qualified domain name, such as mail.example.com`](#hostname-must-be-a-fully-qualified-domain-name-such-as-mailexamplecom)
- [`data: must be an absolute path`](#data-must-be-an-absolute-path)
- [`bind: must be an IPv4 or IPv6 address`](#bind-must-be-an-ipv4-or-ipv6-address)

**Ports**

- [`ports.…: … is also ports.…`](#ports--is-also-ports)
- [`ports.http: is 0, but tls.mode "acme" answers its HTTP-01 challenges there`](#portshttp-is-0-but-tlsmode-acme-answers-its-http-01-challenges-there)

**URLs**

- [`…: is not a URL`](#-is-not-a-url)
- [`….url: the scheme "…:" is not one of …`](#url-the-scheme--is-not-one-of-)
- [`….url: must be sqlite: and an absolute path, such as sqlite:/data/mail`](#url-must-be-sqlite-and-an-absolute-path-such-as-sqlitedatamail)
- [`….url: sends credentials without TLS; use rediss:, or set insecure = true to send them in clear`](#url-sends-credentials-without-tls-use-rediss-or-set-insecure--true-to-send-them-in-clear)
- [`….url: sends credentials without TLS; add sslmode=require (or verify-ca, verify-full), or sslmode=disable to send them in clear`](#url-sends-credentials-without-tls-add-sslmoderequire-or-verify-ca-verify-full-or-sslmodedisable-to-send-them-in-clear)
- [`….url: is not a PostgreSQL URL Bun.sql takes`](#url-is-not-a-postgresql-url-bunsql-takes)
- [`….url: takes its credentials before the host (redis://:password@host); Bun ignores ?password=`](#url-takes-its-credentials-before-the-host-redispasswordhost-bun-ignores-password)
- [`….insecure: is only for a redis: URL that sends credentials to another host`](#insecure-is-only-for-a-redis-url-that-sends-credentials-to-another-host)
- [`….insecure: is only for a redis: URL; for PostgreSQL, write sslmode=disable in the URL`](#insecure-is-only-for-a-redis-url-for-postgresql-write-sslmodedisable-in-the-url)
- [`…: the scheme "…:" is not https:`](#-the-scheme--is-not-https), for `acme.directory` and `jmap.origin`
- [`…: must not hold credentials`](#-must-not-hold-credentials), for `acme.directory` and `jmap.origin`

**TLS and ACME**

- [`tls.mode: must be "acme" or "files"`](#-must-be--or-)
- [`tls.…: is required with tls.mode "files"`](#tls-is-required-with-tlsmode-files)
- [`tls.…: is only for tls.mode "files"`](#tls-is-only-for-tlsmode-files)
- [`acme: is only for tls.mode "acme"`](#acme-is-only-for-tlsmode-acme)
- [`tls.…: cannot be read (…)`](#tls-cannot-be-read-)
- [`tls.cert: is not a PEM certificate`](#tlscert-is-not-a-pem-certificate)
- [`tls.key: is not an unencrypted PEM private key`](#tlskey-is-not-an-unencrypted-pem-private-key)
- [`tls.cert: expired on …`](#tlscert-expired-on-)
- [`tls.cert: is not valid until …`](#tlscert-is-not-valid-until-)
- [`tls.cert: does not name …`](#tlscert-does-not-name-), with `(it names …)` when it names any
- [`tls.key: is not the key of tls.cert`](#tlskey-is-not-the-key-of-tlscert)
- [`acme.email: is required with tls.mode "acme"`](#acmeemail-is-required-with-tlsmode-acme)
- [`acme.email: must be an e-mail address`](#acmeemail-must-be-an-e-mail-address)
- [`acme.acceptTerms: must be true: the CA's terms of service, read and accepted`](#acmeacceptterms-must-be-true-the-cas-terms-of-service-read-and-accepted)

**Smarthost and routes**

- [`….host: is required`](#host-is-required)
- [`….host: must be a host name or an IP address`](#host-must-be-a-host-name-or-an-ip-address)
- [`smarthost.username: needs a password or a passwordFile`](#smarthostusername-needs-a-password-or-a-passwordfile)
- [`smarthost.password: needs a username`](#smarthostpassword-needs-a-username), or `BUMAIL_SMARTHOST_PASSWORD: needs a username`, or `BUMAIL_SMARTHOST_PASSWORD_FILE: needs a username`
- [`smarthost.password: is given with passwordFile; give one of them`](#smarthostpassword-is-given-with-passwordfile-give-one-of-them)
- [`smarthost.passwordFile: cannot be read (…)`](#smarthostpasswordfile-cannot-be-read-)
- [`smarthost.passwordFile: names an empty file`](#smarthostpasswordfile-names-an-empty-file)
- [`smarthost.tls: sends credentials without TLS; set tls = "required" or secure = true`](#smarthosttls-sends-credentials-without-tls-set-tls--required-or-secure--true)
- [`routes.…: is not a domain name`](#routes-is-not-a-domain-name)
- [`routes.…: is the same domain as routes.…`](#routes-is-the-same-domain-as-routes)
- [`routes.…: is "smarthost", but there is no [smarthost]`](#routes-is-smarthost-but-there-is-no-smarthost)
- [`routes.…: must be "mx", "smarthost" or a table with a host`](#routes-must-be-mx-smarthost-or-a-table-with-a-host)

**JMAP**

- [`jmap.origin: must be an origin, with no path or query, such as https://mail.example.com`](#jmaporigin-must-be-an-origin-with-no-path-or-query-such-as-httpsmailexamplecom)

**The environment**

- [`BUMAIL_…: is set with BUMAIL_…_FILE; set one of them`](#bumail_-is-set-with-bumail__file-set-one-of-them)
- [`BUMAIL_…_FILE: cannot be read (…)`](#bumail__file-cannot-be-read-)
- [`BUMAIL_…_FILE: names an empty file`](#bumail__file-names-an-empty-file)
- [`BUMAIL_SMARTHOST_PASSWORD…: is set, but there is no [smarthost]`](#bumail_smarthost_password-is-set-but-there-is-no-smarthost), as `BUMAIL_SMARTHOST_PASSWORD` or `BUMAIL_SMARTHOST_PASSWORD_FILE`

**Usage** (exit code 2)

- [`bumail: … ; see bumail --help`](#usage)

## The file

### `(file): cannot be read (…)`

**When**: the configuration file is not there, or not readable:
`(file): cannot be read (ENOENT)`. The parenthesis is the system's code:
`ENOENT` (no such file), `EACCES` (not allowed). A directory is
[not a regular file](#-is-not-a-regular-file).

**Why**: the path is `--config`, else `BUMAIL_CONFIG`, else
`/data/bumail.toml`: with neither given, the volume must hold that file.

**Fix**: name the file, or put it on the volume.

```sh
bumail check-config --config ./bumail.toml
```

### `(file): is not TOML: …`

**When**: the file does not parse: `(file): is not TOML: Strings must be
quoted: "…"`. The reason is Bun's, with anything it quotes masked, since
it could be a password.

**Why**: most often a string without quotes, `hostname =
mail.example.com`, or a table header twice.

**Fix**: quote strings, and give each table once.

```toml
hostname = "mail.example.com"
```

### `…: is not a regular file`

**When**: the configuration (`(file)`), `tls.cert`, `tls.key`,
`smarthost.passwordFile` or a `BUMAIL_…_FILE` names a directory, a
device or a pipe. It is checked before reading: a FIFO would never end.

**Fix**: name the file itself. A symbolic link to a file is followed,
as Kubernetes mounts its secrets.

### `…: is larger than 1 MiB`

**When**: one of those files is over 1 MiB, which no configuration,
certificate chain, key or secret is.

**Fix**: name the right file.

## Any key

### `…: unknown key; did you mean "…"?`

**When**: a key the section does not take, close to one it does:
`inbound.max_message_size: unknown key; did you mean "maxMessageSize"?`.

**Why**: keys are camelCase (`maxMessageSize`, `passwordFile`,
`acceptTerms`), and a typo is never taken silently: a key that is
ignored is a setting you think you made.

**Fix**: use the key suggested. The [guide](guide.md) lists every key.

### `…: unknown key`

**When**: a key no section takes, and nothing close to one that does:
`routes."example.org".username: unknown key`.

**Why**: the key is not an option there. A route, for instance, takes no
credentials.

**Fix**: remove it, or move it to the section that takes it (the
[guide](guide.md)).

### `…: not an option: bumail never relays without AUTH`

**When**: a `relay`, `mynetworks` or `trustedNetworks` key, wherever it
appears, and in any case or spelling: `RELAY`, `my_networks`,
`trusted-networks`.

**Why**: these are how other servers let a network send anywhere
without authenticating. bumail takes mail for a domain it does not host
only from an authenticated session, over TLS: there is no address or
setting that skips it.

**Fix**: remove the key. Give each sender an account and let it submit
on 465 or 587 with its credentials.

### `…: must be a table, not …`

**When**: a section given as a value: `ports = 25`.

**Fix**: a section is a table.

```toml
[ports]
mx = 25
```

### `…: must be a string, not …`

**When**: a value of another type where a string is wanted:
`data: must be a string, not an integer`. Dates, arrays and numbers are
named as such; the value itself is never repeated.

**Fix**: quote it.

### `…: must be true or false, not …`

**When**: `secure = "yes"`, `acceptTerms = 1`.

**Fix**: a TOML boolean, unquoted: `secure = true`.

### `…: must be an integer from … to …`

**When**: a port, a size or a count out of its range, or not an integer:
`ports.mx: must be an integer from 0 to 65535`,
`submission.maxRecipients: must be an integer from 1 to 10000`.

A fraction is refused (`mx = 25.5`); TOML's `25.0` reads as 25 and is
taken.

**Fix**: a whole number in the range. A port of 0 turns its listener
off; sizes are bytes.

### `…: must be "…" or "…"`

**When**: a value that is not one of the choices:
`inbound.dmarc: must be "enforce" or "mark"`,
`tls.mode: must be "acme" or "files"`,
`smarthost.tls: must be "required", "opportunistic" or "none"`.

**Fix**: one of the choices listed, as a string.

## Top-level keys

### `hostname: is required (or set BUMAIL_HOSTNAME)`

**When**: neither the file nor the environment names the server.

**Fix**:

```toml
hostname = "mail.example.com"
```

or `BUMAIL_HOSTNAME=mail.example.com`.

### `hostname: must be a fully qualified domain name, such as mail.example.com`

**When**: a single label (`mail`, `localhost`), an IP address, a space,
an underscore, or a Unicode name. From the environment, the path reads
`hostname (BUMAIL_HOSTNAME)`.

**Why**: the hostname is what other servers look up and what the
certificate must name.

**Fix**: the server's full name, in A-labels (`xn--…` for an IDN).

### `data: must be an absolute path`

**Fix**: `data = "/data"`, or another absolute directory.

### `bind: must be an IPv4 or IPv6 address`

**When**: a host name (`localhost`) or anything else that is not an
address.

**Fix**: `bind = "0.0.0.0"` (the default), `"::"`, or one of the
machine's addresses.

## Ports

### `ports.…: … is also ports.…`

**When**: two listeners on one port: `ports.submission: 465 is also
ports.submissions`, or the health port on a public one.

**Fix**: give each its own port, or 0 to turn one off.

### `ports.http: is 0, but tls.mode "acme" answers its HTTP-01 challenges there`

**Why**: ACME proves the server holds its name by answering the CA on
port 80 (HTTP-01).

**Fix**: leave `ports.http` at 80 and open it, or use certificates from
files:

```toml
[tls]
mode = "files"
cert = "/etc/bumail/fullchain.pem"
key = "/etc/bumail/privkey.pem"
```

## URLs

### `…: is not a URL`

**When**: `store.url`, `queue.url`, `directory.url`, `acme.directory`
or `jmap.origin` does not parse, or has no `/` after its scheme
(`user:secret@host` is taken for no URL at all, so its first word is
not repeated as a scheme).

**Fix**: a full URL: `sqlite:/data/mail`, `postgres://host/db`,
`rediss://host:6380`, `https://mail.example.com`.

### `….url: the scheme "…:" is not one of …`

**When**: a scheme the section does not take: `store.url: the scheme
"mysql:" is not one of sqlite:, postgres: or postgresql:`. The mail
store takes SQLite and PostgreSQL; the queue also Redis; the directory
SQLite only.

**Fix**: one of the schemes listed.

### `….url: must be sqlite: and an absolute path, such as sqlite:/data/mail`

**When**: `sqlite://data/mail` (where `data` reads as a host),
`sqlite:mail` (relative), or a query string.

**Fix**: `sqlite:` then an absolute path: `sqlite:/data/mail`.

### `….url: sends credentials without TLS; use rediss:, or set insecure = true to send them in clear`

**When**: a `redis:` URL with a password, to a host other than this
machine.

**Why**: the password, and every message the queue holds, would cross
the network in clear, for anyone on the path to read.

**Fix**: `rediss://:…@cache.internal:6380`, with TLS on the Redis
server; or a Redis on loopback. Where the network between them is
yours alone (a private Docker network, a host-only link) and you accept
that risk, say so:

```toml
[queue]
url = "redis://:…@cache:6379"   # better in BUMAIL_QUEUE_URL_FILE
insecure = true
```

`check-config` then shows the queue as `redis (plaintext)`.

### `….url: sends credentials without TLS; add sslmode=require (or verify-ca, verify-full), or sslmode=disable to send them in clear`

**When**: a `postgres:` URL with a password (in the URL, or in
`PGPASSWORD`, which Bun sends when the URL has none), to a host other
than this machine, that Bun would connect to without TLS. It is decided
as Bun decides, from `sslmode`, `ssl`, `tls` and `PGSSLMODE` together:
`sslmode=require&ssl=false` connects in clear, and is refused; `prefer`
and `allow` fall back to clear, and are refused.

**Fix**: append `?sslmode=verify-full` (or `require`), with TLS on the
PostgreSQL server, and nothing after it that turns TLS off; or a
PostgreSQL on loopback. Where the network is yours alone and you accept
that the password and the mail cross it in clear, write
`sslmode=disable`, once: `check-config` then shows the store as
`postgres (plaintext)`.

### `….url: is not a PostgreSQL URL Bun.sql takes`

**When**: Bun's PostgreSQL client refuses the URL, as for `sslmode`
given twice or a value it does not know. Its reason is not shown: it
can repeat the URL.

**Fix**: one `sslmode`, one of `disable`, `allow`, `prefer`, `require`,
`verify-ca`, `verify-full`. Try the URL with `new Bun.SQL(url)` to see
Bun's reason.

### `….url: takes its credentials before the host (redis://:password@host); Bun ignores ?password=`

**When**: a Redis URL with `?password=` or `?username=`.

**Why**: Bun's Redis client reads neither, and would connect without
authenticating.

**Fix**: `rediss://:password@host:6380`, or `rediss://user:password@host`.

### `….insecure: is only for a redis: URL that sends credentials to another host`

**When**: `insecure = true` beside a `rediss:` URL, a URL without a
password, one on loopback, or SQLite (the default).

**Fix**: remove it: nothing is sent in clear there.

### `….insecure: is only for a redis: URL; for PostgreSQL, write sslmode=disable in the URL`

**Fix**: remove `insecure`, and write `sslmode=disable` in the URL if
the credentials are to go in clear.

## TLS and ACME

### `tls.…: is required with tls.mode "files"`

**Fix**: give both `tls.cert` and `tls.key`, or use `mode = "acme"`.

### `tls.…: is only for tls.mode "files"`

**When**: `tls.cert` or `tls.key` without `mode = "files"`: the default
mode is ACME, which makes its own.

**Fix**: add `mode = "files"`, or remove `cert` and `key`.

### `acme: is only for tls.mode "acme"`

**Fix**: remove `[acme]`, or use `mode = "acme"`.

### `tls.…: cannot be read (…)`

**When**: the certificate or key file is not there or not readable. A
relative path starts from the configuration file's directory.

**Fix**: the right path, readable by the user the server runs as.

### `tls.cert: is not a PEM certificate`

**When**: the file holds no `-----BEGIN CERTIFICATE-----` block, or one
that does not decode: DER, a key, a CSR.

**Fix**: the PEM chain, leaf first (Let's Encrypt's `fullchain.pem`). To
convert DER: `openssl x509 -inform der -in cert.der -out cert.pem`.

### `tls.key: is not an unencrypted PEM private key`

**When**: the file holds no `PRIVATE KEY`, `RSA PRIVATE KEY` or
`EC PRIVATE KEY` block, the key is encrypted (`ENCRYPTED PRIVATE KEY`),
or it does not decode.

**Fix**: the key unencrypted, kept readable by the server only:
`openssl pkey -in encrypted.pem -out privkey.pem`.

### `tls.cert: expired on …`

**When**: the certificate's validity ended on that date.

**Fix**: renew it, or let ACME keep it current (`mode = "acme"`).

### `tls.cert: is not valid until …`

**When**: the certificate's validity starts after today: a clock that
is wrong, or a certificate issued for later.

**Fix**: check the machine's clock (and NTP), or use a certificate
valid now.

### `tls.cert: does not name …`

**When**: neither the certificate's subject alternative names nor its CN
match `hostname`. The names it holds follow, as
`does not name mail.example.com (it names mx.example.org)`; with no
DNS name and no CN, there is no parenthesis. A wildcard
`*.example.com` matches `mail.example.com`.

**Why**: a client checks that name, and refuses the connection, or
(for a server sending to it) delivers in clear or not at all.

**Fix**: a certificate for `hostname`, or the `hostname` the certificate
is for.

### `tls.key: is not the key of tls.cert`

**When**: the key is valid, but it is another certificate's: often the
key of the previous certificate, after a renewal.

**Fix**: the key generated with this certificate's request.

### `acme.email: is required with tls.mode "acme"`

**Fix**:

```toml
[acme]
email = "postmaster@example.com"
acceptTerms = true
```

### `acme.email: must be an e-mail address`

**Fix**: an address with a local part, an `@` and a domain.

### `acme.acceptTerms: must be true: the CA's terms of service, read and accepted`

**When**: `acceptTerms` is missing or `false`.

**Why**: an ACME CA does not issue to an account that did not accept its
terms; bumail does not accept them for you.

**Fix**: read the CA's terms (Let's Encrypt's are linked from its
directory), then set `acceptTerms = true`.

### `…: the scheme "…:" is not https:`

**When**: `acme.directory` or `jmap.origin` is not `https:`.

**Fix**: the `https:` URL. A local test CA (Pebble) serves its directory
over HTTPS too.

### `…: must not hold credentials`

**When**: `acme.directory` or `jmap.origin` holds `user:password@`.

**Fix**: remove it: an ACME account authenticates by its key, and JMAP
clients log in with their own credentials.

## Smarthost and routes

### `….host: is required`

**When**: `[smarthost]`, or a route given as a table, with no `host`.

**Fix**: `host = "smtp.example.net"`.

### `….host: must be a host name or an IP address`

**When**: a space, a scheme (`smtp://…`) or a port (`host:587`) in the
host.

**Fix**: the name alone, with the port in `port`.

### `smarthost.username: needs a password or a passwordFile`

**Fix**: give `passwordFile` (or `BUMAIL_SMARTHOST_PASSWORD_FILE`), or
remove `username` for a smarthost that takes mail without credentials.

### `smarthost.password: needs a username`

**When**: a password with no `username`. A password from the
environment names its variable instead:
`BUMAIL_SMARTHOST_PASSWORD: needs a username`, or
`BUMAIL_SMARTHOST_PASSWORD_FILE: needs a username`.

**Fix**: add `username`.

### `smarthost.password: is given with passwordFile; give one of them`

**Fix**: keep `passwordFile`, and remove `password` from the file.

### `smarthost.passwordFile: cannot be read (…)`

**When**: the file is not there or not readable. A relative path starts
from the configuration file's directory.

**Fix**: the right path, readable by the server.

### `smarthost.passwordFile: names an empty file`

**Fix**: write the password in the file; one trailing line break is
dropped.

### `smarthost.tls: sends credentials without TLS; set tls = "required" or secure = true`

**When**: a `username` with `tls = "opportunistic"` or `"none"`, and
not `secure`.

**Why**: opportunistic STARTTLS can be stripped by anyone on the path,
and the password would follow in clear.

**Fix**: `secure = true` on port 465, or `tls = "required"` on 587 (the
default once a `username` is given).

### `routes.…: is not a domain name`

**When**: a key under `[routes]` that is no domain: `routes.local`.

**Fix**: the recipient domain, quoted: `"example.org" = "mx"`.

### `routes.…: is the same domain as routes.…`

**When**: two keys name one domain once lowercased and without a
trailing dot: `"example.org"` and `"Example.ORG."`.

**Fix**: keep one route per domain.

### `routes.…: is "smarthost", but there is no [smarthost]`

**Fix**: add `[smarthost]`, or route the domain by `"mx"` or to a host
of its own.

### `routes.…: must be "mx", "smarthost" or a table with a host`

**When**: any other string, a number, an array.

**Fix**:

```toml
[routes]
"example.org" = "mx"
"partner.example" = { host = "mx.partner.example", port = 25 }
```

## JMAP

### `jmap.origin: must be an origin, with no path or query, such as https://mail.example.com`

**Fix**: scheme, host and port only. JMAP's paths are its own.

## The environment

### `BUMAIL_…: is set with BUMAIL_…_FILE; set one of them`

**When**: `BUMAIL_STORE_URL` and `BUMAIL_STORE_URL_FILE` (or any such
pair) are both set and not empty.

**Fix**: unset one: the `_FILE` is the one to keep for a secret.

### `BUMAIL_…_FILE: cannot be read (…)`

**When**: the file it names is not there or not readable, as when a
Docker secret is not mounted.

**Fix**: mount the secret, or correct the path.

### `BUMAIL_…_FILE: names an empty file`

**Fix**: write the value in the file.

### `BUMAIL_SMARTHOST_PASSWORD…: is set, but there is no [smarthost]`

The path is `BUMAIL_SMARTHOST_PASSWORD` or
`BUMAIL_SMARTHOST_PASSWORD_FILE`, whichever is set.

**Why**: the environment sets the smarthost's password only; where to
relay, and as whom, is in the file.

**Fix**: add `[smarthost]` with its `host` and `username`, or unset the
variable.

## Usage

The command exits 2, with `ServerError`'s code `USAGE`, for:

- `bumail: no command given; see bumail --help`
- `bumail: unknown command …; see bumail --help` — the commands are
  `serve` and `check-config`.
- `bumail: unknown option …; see bumail --help` — the options are
  `--config`, `-h` or `--help`, and `-v` or `--version`.
- `bumail: unexpected argument …; see bumail --help` — one command at a
  time.
- `bumail: --config needs a file; see bumail --help`
- `bumail: --config is given twice; see bumail --help`

```sh
bumail --config /data/bumail.toml check-config
```
