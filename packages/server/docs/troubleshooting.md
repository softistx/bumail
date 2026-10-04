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

The command exits 1 for these, and 2 for [bad usage](#usage). The
directory commands' own refusals are under
[the directory commands](#the-directory-commands).

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
- [`inbound.spoolBytes: must be at least inbound.maxMessageSize (…)`](#inboundspoolbytes-must-be-at-least-inboundmaxmessagesize-)

**Top-level keys**

- [`hostname: is required (or set BUMAIL_HOSTNAME)`](#hostname-is-required-or-set-bumail_hostname)
- [`hostname: must be a fully qualified domain name, such as mail.example.com`](#hostname-must-be-a-fully-qualified-domain-name-such-as-mailexamplecom)
- [`data: must be an absolute path`](#data-must-be-an-absolute-path)
- [`bind: must be an IPv4 or IPv6 address`](#bind-must-be-an-ipv4-or-ipv6-address)
- [`postmaster: must be an e-mail address, such as postmaster@example.com`](#postmaster-must-be-an-e-mail-address-such-as-postmasterexamplecom)

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

**The directory commands** (exit code 4, or 5 for the directory and the store)

*Names and addresses*

- [`"…" is not a domain name`](#-is-not-a-domain-name)
- [`"…" is not an e-mail address`](#-is-not-an-e-mail-address)

*Domains*

- [`the domain … already exists`](#the-domain--already-exists)
- [`the domain … does not exist`](#the-domain--does-not-exist)
- [`the domain … still has …; remove them first`](#the-domain--still-has--remove-them-first)
- [`the domain … is not hosted here; add it first`](#the-domain--is-not-hosted-here-add-it-first)

*Users*

- [`the user … already exists`](#the-user--already-exists)
- [`… is an alias; a user cannot take its address`](#-is-an-alias-a-user-cannot-take-its-address)
- [`the user … does not exist`](#the-user--does-not-exist)
- [`… is a target of …; remove that alias first`](#-is-a-target-of--remove-that-alias-first)

*Aliases*

- [`the alias … already exists`](#the-alias--already-exists)
- [`… is a user; an alias cannot take its address`](#-is-a-user-an-alias-cannot-take-its-address)
- [`the alias … does not exist`](#the-alias--does-not-exist)
- [`an alias needs at least one target`](#an-alias-needs-at-least-one-target)
- [`… is not a user here: an alias points to local users only, never elsewhere`](#-is-not-a-user-here-an-alias-points-to-local-users-only-never-elsewhere)

*DKIM keys*

- [`the domain … has a DKIM key already; --replace makes a new one`](#the-domain--has-a-dkim-key-already---replace-makes-a-new-one)
- [`the domain … has no DKIM key`](#the-domain--has-no-dkim-key), and `…; bumail dkim generate makes one`
- [`the selector must be a DNS name: letters, digits, hyphens and dots`](#the-selector-must-be-a-dns-name-letters-digits-hyphens-and-dots)

*Passwords*

- [`the password must be at least 12 characters`](#the-password-must-be-at-least-12-characters)
- [`the password must be at most 1024 bytes`](#the-password-must-be-at-most-1024-bytes)
- [`the password must not hold a control character, such as a line break`](#the-password-must-not-hold-a-control-character-such-as-a-line-break)
- [`the two passwords typed differ`](#the-two-passwords-typed-differ)
- [`no password typed`](#no-password-typed)
- [`--password-file: cannot be read (…)`](#--password-file-cannot-be-read-)
- [`--password-stdin: is larger than 1 MiB`](#--password-stdin-is-larger-than-1-mib)

*The directory and the store*

- [`the directory is in use by another process (…)`](#the-directory-is-in-use-by-another-process-)
- [`the directory … cannot be opened (…)`](#the-directory--cannot-be-opened-)
- [`the directory is at schema version …, newer than this server's …`](#the-directory-is-at-schema-version--newer-than-this-servers-)
- [`the mail store is in use by another process, such as the running server`](#the-mail-store-is-in-use-by-another-process-such-as-the-running-server)
- [`the mail store cannot be opened (…)`](#the-mail-store-cannot-be-opened-)
- [`the mail store failed (…)`](#the-mail-store-failed-)
- [`the user … is disabled, but its mail is not purged: …; run the command again`](#the-user--is-disabled-but-its-mail-is-not-purged--run-the-command-again)
- [`added the user …, but not its mailboxes: …; the server creates them at its first login`](#added-the-user--but-not-its-mailboxes--the-server-creates-them-at-its-first-login)

*From code*

- [`too many logins under way; try again later`](#too-many-logins-under-way-try-again-later)
- [`bumail: a login came from a client with no IP address; the failure limiter does not count such logins`](#bumail-a-login-came-from-a-client-with-no-ip-address-the-failure-limiter-does-not-count-such-logins)
- [`maxVerifies must be an integer of 1 or more`](#maxverifies-must-be-an-integer-of-1-or-more)
- [`the directory URL must be sqlite: and a path`](#the-directory-url-must-be-sqlite-and-a-path)

**Serving** (`bumail serve`: exit code 3 or 5; the replies other servers get; the log)

- [`acme mode arrives in a later slice: set tls.mode = "files", with cert and key, for now`](#acme-mode-arrives-in-a-later-slice-set-tlsmode--files-with-cert-and-key-for-now)
- [`… cannot listen on …:… (…)`](#-cannot-listen-on--)
- [`tls.cert … cannot be read (…)`](#tlscert--cannot-be-read-), and the same for `tls.key`
- [`the spool directory … cannot be used (…)`](#the-spool-directory--cannot-be-used-)
- [`the queue cannot be opened (…)`](#the-queue-cannot-be-opened-)
- [`bumail: the spool folder … is kept: …`](#bumail-the-spool-folder--is-kept-)
- [`bumail: the spool folder … was removed while in use; made it again`](#bumail-the-spool-folder--was-removed-while-in-use-made-it-again)
- [`550 5.1.1 User unknown`](#550-511-user-unknown)
- [`554 5.7.1 Relay access denied`](#554-571-relay-access-denied)
- [`550 5.7.1 Rejected by the DMARC policy of …`](#550-571-rejected-by-the-dmarc-policy-of-)
- [`451 4.7.0 DMARC check failed, try again later`](#451-470-dmarc-check-failed-try-again-later)
- [`550 5.7.1 The From field cannot be evaluated for DMARC: none, several, or not one mailbox`](#550-571-the-from-field-cannot-be-evaluated-for-dmarc-none-several-or-not-one-mailbox)
- [`452 4.3.1 Insufficient system storage, try again later`](#452-431-insufficient-system-storage-try-again-later)
- [`552 5.3.4 Message header too large`](#552-534-message-header-too-large)
- [`550 5.1.1 No recipient of this message is here any longer`](#550-511-no-recipient-of-this-message-is-here-any-longer)
- [`451 4.3.0 Message not taken, try again later`](#451-430-message-not-taken-try-again-later)
- [`451 4.3.0 Local error in processing`](#451-430-local-error-in-processing)
- [`421 4.3.2 … Too many connections, try later`](#421-432--too-many-connections-try-later)
- [`421 4.7.0 … Too many connections from your address, try later`](#421-470--too-many-connections-from-your-address-try-later)
- [`550 5.1.1 No postmaster mailbox is configured here`](#550-511-no-postmaster-mailbox-is-configured-here)
- [`bumail: postmaster … is in …, a domain not hosted here; mail for <postmaster> is refused until it is`](#bumail-postmaster--is-in--a-domain-not-hosted-here-mail-for-postmaster-is-refused-until-it-is)
- [`imaps: login refused from …: …`](#imaps-login-refused-from--), and `imap:`, `submissions:`, `submission:`
- [`mx: error in a session from …: …`](#mx-error-in-a-session-from--), and `submissions:`, `submission:`, `imaps:`, `imap:`
- [`bumail: the mail store did not close cleanly: …`](#bumail-the-mail-store-did-not-close-cleanly-), and `the queue`
- [`bumail: the queue did not stop cleanly: …`](#bumail-the-queue-did-not-stop-cleanly-)
- [`bumail: queue deliveries still under way are left to their leases`](#bumail-queue-deliveries-still-under-way-are-left-to-their-leases)
- [`mx: … not spooled: …`](#mx--not-spooled-), and `submissions:`, `submission:`
- [`mx: … abandoned before …: the session ended`](#mx--abandoned-before--the-session-ended), and `submissions:`, `submission:`

**Sending** (the replies a user's mail client gets on 465 and 587; the log of the queue)

- [`530 …`, `538 …`: AUTH and MAIL refused before TLS or a login](#530--538--auth-and-mail-refused-before-tls-or-a-login)
- [`535 …`: the login refused](#535--the-login-refused)
- [`553 5.7.1 Not authorized to send as <…>`](#553-571-not-authorized-to-send-as-)
- [`550 5.7.1 The From field names an address that is not yours`](#550-571-the-from-field-names-an-address-that-is-not-yours)
- [`550 5.6.0 The message needs exactly one From field`](#550-560-the-message-needs-exactly-one-from-field)
- [`550 5.6.0 The From field must name your address`](#550-560-the-from-field-must-name-your-address)
- [`553 5.1.3 The address is not one this server can send to`](#553-513-the-address-is-not-one-this-server-can-send-to)
- [`550 5.7.1 Mail to an address literal is not sent from here`](#550-571-mail-to-an-address-literal-is-not-sent-from-here)
- [`452 4.3.1 The queue is full, try again later`](#452-431-the-queue-is-full-try-again-later), `552 5.3.4 Message too big for the queue`, `452 4.5.3 Too many recipients`
- [`submissions: … not queued: …`](#submissions--not-queued-), and `submission:`
- [`submissions: … refused as sender <…>`](#submissions--refused-as-sender-), and `submission:`
- [`submissions: … (unsigned)`](#submissions--unsigned), and `submission:`
- [`submissions: … taken for nobody here any longer`](#submissions--taken-for-nobody-here-any-longer), and `submission:`
- [`outbound: … deferred until …: …`](#outbound--deferred-until--)
- [`outbound: … failed: …`](#outbound--failed-), and `outbound: …: a failed DSN to <…> queued as …`
- [`outbound: error …: …`](#outbound-error--)

**Usage** (exit code 2)

- [`bumail: …; see bumail --help`](#usage)

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

### `inbound.spoolBytes: must be at least inbound.maxMessageSize (…)`

**When**: `inbound.spoolBytes`, what the messages waiting to be checked
may hold on disk at once, is smaller than one message as large as
allowed: no such message could ever be taken. The number in brackets is
`inbound.maxMessageSize`.

**Fix**: raise it, or leave it out for the default, 20 times
`inbound.maxMessageSize`:

```toml
[inbound]
maxMessageSize = 26214400
spoolBytes = 524288000
```

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

### `postmaster: must be an e-mail address, such as postmaster@example.com`

`postmaster`, where the bare `RCPT TO:<postmaster>` goes, is not an
address the directory could hold: a local part and a domain, with no
quotes. Give a user or an alias, such as `postmaster@example.com`, or
leave the key out for `postmaster@` the first hosted domain.

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

**When**: a `redis:` URL with credentials — a password, or a user
alone (`redis://secret@host`), which Bun sends as a password — to a
host other than this machine.

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

## The directory commands

`bumail domain`, `user` and `alias` print a refusal as `bumail: <message>`
on standard error; each message has an entry here. No message repeats
a password. Exit code 4 is a refusal of the directory, 5 the directory
or the mail store unavailable. [The directory guide](directory.md) has
every command.

### Names and addresses

#### `"…" is not a domain name`

**When**: `domain add`, `domain remove`, or a `list` given a domain,
with what is not a domain name of two labels or more: a name with a
space or an `@`, a label over 63 characters. A value with no `.` and
no `@` — `localhost`, or a password typed in the wrong place — is not
repeated: `the value given is not a domain name`.

**Fix**: give the domain the server receives mail for, as in its MX
records. Case, a trailing dot and a name in Unicode are fine:
`Bücher.Example.` is kept as `xn--bcher-kva.example`.

```sh
bumail domain add example.com
```

#### `"…" is not an e-mail address`

**When**: a `user` or `alias` command, with what is not
`local@domain`: no `@`, an empty local part, a quoted local part
(`"john doe"@example.com`), two dots in a row, a local part over 64
octets, an address over 254. A value with no `@` and no `.` — `alice`,
or a password typed where the address goes — is not repeated: `the
value given is not an e-mail address`.

**Why**: the directory keeps dot-atom local parts only, so one mailbox
has one spelling. See [addresses](directory.md#addresses-and-their-case).

**Fix**: give the full address, domain included: `alice@example.com`,
not `alice`.

### Domains

#### `the domain … already exists`

**When**: `domain add` with a domain the directory has, in any case.

**Fix**: nothing to do; `bumail domain list` shows it.

#### `the domain … does not exist`

**When**: `domain remove` with a domain the directory does not have.

**Fix**: check the spelling against `bumail domain list`.

#### `the domain … still has …; remove them first`

**When**: `domain remove` with a domain that still has users or
aliases: `the domain example.com still has 2 users and 1 alias; remove
them first`.

With one user or one alias left, it ends `remove it first`.

**Why**: removing it would leave addresses nobody can receive mail at,
in a domain the server no longer hosts.

**Fix**: remove its aliases, then its users, then the domain.

```sh
bumail alias list example.com
bumail user list example.com
```

#### `the domain … is not hosted here; add it first`

**When**: `user add` or `alias add` with an address in a domain the
directory does not have.

**Fix**: add the domain first.

```sh
bumail domain add example.com
bumail user add alice@example.com
```

### Users

#### `the user … already exists`

**When**: `user add` with an address a user has, in any case:
`Alice@example.com` is `alice@example.com`.

**Fix**: choose another address, or change the user's password with
`bumail user passwd`.

#### `… is an alias; a user cannot take its address`

**When**: `user add` with the address of an alias.

**Why**: one address delivers to one place: a user's mailbox, or an
alias's users.

**Fix**: remove the alias first, or choose another address.

#### `the user … does not exist`

**When**: `user passwd`, `disable`, `enable` or `remove` with an address
no user has (an alias is not a user). With `--purge`, only when the mail
store has no account for it either: an account left there, by a plain
`remove` or by a login under way during a purge, is deleted, and the
command prints `… is not a user; deleted its account and mail left in
the mail store`. Since `--purge` looks in the store first, a store the
running server holds or one that cannot be reached answers before this:
exit 5, not 4.

**Fix**: check it against `bumail user list`.

#### `… is a target of …; remove that alias first`

**When**: `user remove` with a user an alias points to: `bob@example.com
is a target of sales@example.com; remove that alias first`, or `…;
remove those aliases first` when there are several.

**Why**: an alias left pointing nowhere would take mail and lose it.

**Fix**: remove the alias, and add it again with its other users.

```sh
bumail alias remove sales@example.com
bumail alias add sales@example.com alice@example.com
bumail user remove bob@example.com
```

### Aliases

#### `the alias … already exists`

**When**: `alias add` with an address an alias has.

**Fix**: to change its users, remove it and add it again.

#### `… is a user; an alias cannot take its address`

**When**: `alias add` with the address of a user.

**Fix**: choose another address for the alias.

#### `the alias … does not exist`

**When**: `alias remove` with an address no alias has.

**Fix**: check it against `bumail alias list`.

#### `an alias needs at least one target`

**When**: `Directory.aliases.add` with an empty list. (The command
refuses that as [bad usage](#usage) first.)

**Fix**: give one or more users.

#### `… is not a user here: an alias points to local users only, never elsewhere`

**When**: `alias add` with a target that is not a user of this
server: an address at another domain, an address nobody has here, or
another alias.

**Why**: an alias to an address elsewhere would make the server a
relay, and break SPF for what it passes on. There is no option to allow
it. See [no forwarding](directory.md#no-forwarding).

**Fix**: add the target as a user first, or point the alias at a user.
For another alias, list that alias's users instead.

### DKIM keys

#### `the domain … has a DKIM key already; --replace makes a new one`

`bumail dkim generate` for a domain with a key. Mail from it is signed
with that key already: `bumail dkim show <domain>` prints its record
again. To change keys, make the new one under a new selector, so the
old record can stay published while mail signed with it is still on
its way:

```sh
bumail dkim generate example.com --selector s2 --replace
```

Publish the new record; mail is signed with the new key from now on.
Remove the old record once a few days have passed.

#### `the domain … has no DKIM key`

`bumail dkim remove` (exit code 4), or `bumail dkim show` as `…; bumail
dkim generate makes one`, for a hosted domain with no key. Mail from it
goes unsigned; `bumail dkim generate <domain>` makes one.

#### `the selector must be a DNS name: letters, digits, hyphens and dots`

`--selector` names the record `<selector>._domainkey.<domain>`, so it is
one or more DNS labels: ASCII letters (taken lowercase), digits and
hyphens, not starting or ending with a hyphen, joined by dots. `s1`,
`mail2`, `k.example` are fine; `my_key` is not.

### Passwords

#### `the password must be at least 12 characters`

**When**: `user add` or `user passwd` with a password shorter than 12
characters (counted as characters, not bytes).

**Fix**: a longer one; a passphrase of a few words is easy to type and
hard to guess.

#### `the password must be at most 1024 bytes`

**When**: a password over 1024 bytes of UTF-8 — usually a file or
standard input holding more than the password.

**Fix**: give the password alone; one final line break is dropped.

#### `the password must not hold a control character, such as a line break`

**When**: the password holds a tab, a line break or another control
character — standard input or a file with two lines, or a Windows line
break doubled.

**Why**: no login prompt types one, so such a password could never be
used.

**Fix**: put the password alone on one line.

```sh
printf '%s\n' "$PASSWORD" | bumail user add alice@example.com --password-stdin
```

#### `the two passwords typed differ`

**When**: at the prompt, the second password typed is not the first.

**Fix**: run the command again, and type the same one twice.

#### `no password typed`

**When**: Ctrl-C or Ctrl-D at the password prompt.

**Fix**: nothing was changed; run the command again.

#### `--password-file: cannot be read (…)`

**When**: the file `--password-file` names is not there, or not
readable: `--password-file: cannot be read (ENOENT)`. The parenthesis is
the system's code. `--password-file: is not a regular file` (a
directory, a device) and `--password-file: is larger than 1 MiB` are
its siblings.

**Fix**: name a regular file holding the password, readable by whoever
runs the command.

#### `--password-stdin: is larger than 1 MiB`

**When**: standard input held more than 1 MiB.

**Fix**: pipe the password alone into the command.

### The directory and the store

#### `the directory is in use by another process (…)`

**When**: a change to the directory waited 5 seconds for another
process's write and gave up: `the directory is in use by another
process (SQLITE_BUSY)`. Exits 5, and nothing was changed. Its sibling
`the directory failed (…)` names any other failure of SQLite's.

**Why**: another `bumail` command, or a tool holding the file open in a
write transaction (an `sqlite3` shell left in `BEGIN`).

**Fix**: let the other finish, or close it, and run the command again.

#### `the directory … cannot be opened (…)`

**When**: the directory's file, `directory.url`, cannot be created or
opened: `the directory /data/directory.sqlite cannot be opened
(SQLITE_CANTOPEN)`. Exits 5.

**Why**: its directory is not writable, the path runs through a file,
the volume is not mounted, or the file is not SQLite.

**Fix**: check the path, the volume, and who owns them; the file and
its directory are created if missing.

#### `the directory is at schema version …, newer than this server's …`

**When**: the file was written by a newer bumail, which added to its
schema. Exits 5.

**Fix**: run that newer bumail, or a backup of the file from before the
upgrade. A server never downgrades a file.

#### `the mail store is in use by another process, such as the running server`

**When**: `user remove --purge` with a SQLite mail store the running
server holds, which only one process opens at a time. Exits 5, and
nothing is removed.

`user add` meets it too, but goes on: it adds the user and prints
`added the user …; the mail store is in use by the running server,
which creates its mailboxes at its first login`, exiting 0.

**Fix**: stop the server, purge, and start it again; or remove the
user without `--purge`, keeping its mail, and purge later.

#### `the mail store cannot be opened (…)`

**When**: `store.url` cannot be opened: a SQLite directory that is not
writable, a PostgreSQL URL Bun refuses. The reason is the store's, with
a password it repeats masked. Exits 5.

**Fix**: check `store.url` and `bumail check-config`.

#### `the mail store failed (…)`

**When**: the store opened, but a call failed: PostgreSQL unreachable,
a disk full. Exits 5.

**Fix**: what the reason says; the command can be run again.

#### `added the user …, but not its mailboxes: …; the server creates them at its first login`

**When**: `user add` added the user, but the mail store could not be
opened or used for another reason than the server holding it. Exits 5.

**Why**: the user is in the directory and can log in; the account and
its mailboxes are created at its first login, if the store works by
then.

**Fix**: fix the store, as the reason says; nothing needs undoing.

#### `the user … is disabled, but its mail is not purged: …; run the command again`

**When**: `user remove --purge` opened the store, disabled the user so
no new login creates its account again during the purge (one already
under way still may), and then the store failed deleting the account.
The reason is the store's. Exits 5; the user is still there, disabled,
and its mail may be partly deleted.

**Fix**: fix the store, as the reason says, and run the same command
again: it finishes the purge and removes the user. To keep the user
instead, `bumail user enable` it.

### From code

#### `too many logins under way; try again later`

**When**: thrown by an adapter (`smtpAuthenticate`, `imapAuthenticate`,
`jmapAuthenticate`) when `authenticate` answered `busy`: more than
`maxQueuedVerifies` logins waited for a verify, or one client had
`maxPending` (5) logins under way already, or as many as it has
failures left before a block. The listener tells the client a temporary
failure, and its `onError` gets this. A login already verified within
`cacheSeconds` is answered from the cache and is never `busy`.

**Fix**: a burst passes, and the client's retry succeeds. If it is
steady from the whole server, raise `maxVerifies` on a machine with the
memory for it (19 MiB each); if one client meets it with the right
password, it opens many connections at once with a password that
changed or is not yet cached: it passes once one of them is verified.

#### `bumail: a login came from a client with no IP address; the failure limiter does not count such logins`

**When**: a warning on the console, once per directory, the first time
`authenticate` gets a client address that is no IP address: an empty
string, a Unix socket path, or whatever a listener behind a proxy
passes when it cannot read the client's. `clientKey` answers
`undefined` for it, and such logins are not limited, rather than all
sharing one bucket that one guesser would block for everyone. The login
itself goes on as usual.

**Why**: the listener's `remoteAddress`, or the `ipOf` given to
`jmapAuthenticate`, answered no address.

**Fix**: pass the client's real address: for JMAP, `ipOf` as
`(request) => server.requestIP(request)?.address ?? ''`; behind a
proxy, the address the proxy reports. To log it elsewhere, give
`Directory.open` an `onUnlimited` callback.

#### `maxVerifies must be an integer of 1 or more`

**When**: `Directory.open` with `maxVerifies` that is not a positive
integer. `maxQueuedVerifies must be an integer of 0 or more`, and
`maxFailures`, `windowSeconds` or `maxClients must be an integer of 1 or
more` (from `new FailureLimiter`, with `maxPending`), and
`cacheSeconds must be an integer of 0 or more`, are its siblings.

**Fix**: give whole numbers, or leave the option out for its default.

#### `the directory URL must be sqlite: and a path`

**When**: `directoryFile` with a URL that is not `sqlite:`.
`readConfig` refuses such a `directory.url` before.

**Fix**: `sqlite:` and an absolute path: `sqlite:/data/directory.sqlite`.

## Serving

`bumail serve` exits 3 for what arrives in a later release, 5 for
what it cannot open or bind, and 1 for a configuration `check-config`
refuses. What it does is in [running the server](serve.md). It also
prints the directory's and the store's own messages, such as
[`the mail store is in use by another process, such as the running server`](#the-mail-store-is-in-use-by-another-process-such-as-the-running-server):
see [the directory and the store](#the-directory-and-the-store), exit
code 5.

### `acme mode arrives in a later slice: set tls.mode = "files", with cert and key, for now`

`bumail serve` with `tls.mode = "acme"`, the default. `check-config`
takes it, so a file written for ACME stays valid, but the server does
not obtain certificates yet. Exit code 3.

Get a certificate another way (certbot, your provider) and point the
server at it:

```toml
[tls]
mode = "files"
cert = "/etc/bumail/fullchain.pem"
key = "/etc/bumail/privkey.pem"
```

Remove `[acme]`, which `"files"` refuses.

### `… cannot listen on …:… (…)`

`mx`, `imaps` or `imap` could not bind its port; the reason is Bun's.
Exit code 5, with what was opened closed again.

- `Failed to listen at …: EADDRINUSE`: another process holds the port —
  another mail server, or a `bumail serve` already running. Stop it, or
  move this listener (`[ports]`).
- `EACCES`: ports under 1024 need privileges. Run as root in a
  container, or give Bun the capability:
  `setcap cap_net_bind_service=+ep "$(command -v bun)"`.
- `EADDRNOTAVAIL`: `bind` is an address this host does not have.

### `tls.cert … cannot be read (…)`

The certificate or the key was readable when the configuration was
checked, and is not a moment later: removed, or its permissions changed
under a running renewal. Exit code 5. Check the file, then start again.
The message never repeats the key.

### `the spool directory … cannot be used (…)`

`<data>/spool`, where a message waits while it is checked, could not be
created, cleared of what a stopped server left, or given this server's
folder (`<pid>-<random>`, with its `owner` file): `data` is read-only,
full, or owned by another user. Exit code 5. Give the server's user a
writable `data`. A folder is removed only once its `owner` file has
gone 5 minutes untouched, whichever machine wrote it. A folder with no
`owner` file — one another server is still making, or one left half
made — is judged by the folder's own modification time instead, with
the same 5 minutes.

### `the queue cannot be opened (…)`

`bumail serve`: the outbound queue at `queue.url` could not be opened:
a `sqlite:` directory that cannot be created or written (a read-only
`data`, a full disk, another owner), or a URL its store refused; the
reason is the queue's, with any password masked. Exit code 5, with the
directory and the mail store closed again. A PostgreSQL or Redis queue
connects at its first use, so one that is down shows later, as
[`outbound: error …`](#outbound-error--).

### `bumail: the spool folder … is kept: …`

Logged at start, once per entry, when the sweep of `<data>/spool` met
something it could not judge or remove, and left it there. The server
starts anyway.

- `its age cannot be read (…)`: the entry's `owner` file, or the entry
  itself, could not be read for a reason other than its absence — a
  stray file rather than a folder (`ENOTDIR`), or a folder the server's
  user may not read (`EACCES`).
- `it cannot be removed (…)`: it is older than 5 minutes, but removing
  it failed, often for its permissions.

**Fix**: remove the entry by hand, or give it to the server's user.
Nothing in it was acknowledged to a sending server, which sends it
again.

### `bumail: the spool folder … was removed while in use; made it again`

Logged by a running server when its own spool folder was gone: another
server sharing `data` swept it, judging it left behind. That happens
when this server's heartbeat stopped for more than 5 minutes — the
process was paused or suspended (a stopped container, a laptop asleep,
a debugger) — or when the machines' clocks, or the file server's,
disagree by more than that. The server makes the folder again, with its
`owner` file, at its next heartbeat or its next message, whichever comes
first, and goes on taking mail; it logs this once each time.

No message is lost to it. A message already spooled, or being written,
is read back through the file the server holds open, so its checks and
its delivery go on as if the folder were there. A message not yet begun
finds the folder missing, and its write makes the folder again and is
tried once more.

**Fix**: if it recurs, keep the clocks within a minute of each other
with NTP, and do not pause a server for minutes while others share its
`data`.

### `550 5.1.1 User unknown`

What a sending server is told for a recipient in a hosted domain that
no user or alias has. Add the user or the alias; it counts at once, no
restart.

### `554 5.7.1 Relay access denied`

What a sending server is told for a recipient in a domain this server
does not host. That is the rule on port 25, with no exception: no AUTH
is offered there, so no session can relay. If the domain should be
yours, `bumail domain add` it. A user who wants to send elsewhere uses
submission, on 465 or 587, logged in.

### `550 5.7.1 Rejected by the DMARC policy of …`

The message failed DMARC — neither an aligned DKIM signature nor an
aligned SPF pass — and the From domain publishes `p=reject`. With
`inbound.dmarc = "enforce"`, the default, it is refused during the
session, and logged as `refused by DMARC`. The sending server tells its
sender.

If an honest sender is refused, their mail is usually forwarded by a
server that breaks DKIM, or sent through a service missing from their
SPF record: the fix is on their side. To take such mail meanwhile,
`inbound.dmarc = "mark"` records the result and delivers everything.

### `451 4.7.0 DMARC check failed, try again later`

The From domain's DMARC record, or an aligned check, could not be had:
its DNS did not answer within the bound. Or DKIM did not finish within
10 seconds, or could not read the message back from the spool (a failure
of this server's disk, never of the message), while DMARC would
otherwise refuse or quarantine the message: a signature that would have
passed may be among those not checked. The log says `deferred: DMARC or
DKIM did not finish`, with `dkim=temperror` in its results. The sending
server tries again. Only with `inbound.dmarc = "enforce"`; with `"mark"`
the message is delivered. Repeated for every domain: check this host's
resolver.

### `550 5.7.1 The From field cannot be evaluated for DMARC: none, several, or not one mailbox`

The message has no From, two of them, or one that is not a single
mailbox (a group, an empty value). A second From is the classic way
around `p=reject`, since a reader may be shown either, so DMARC refuses
what it cannot read (RFC 7489 §6.6.1). Only with `inbound.dmarc =
"enforce"`; the sender has to fix the message.

### `452 4.3.1 Insufficient system storage, try again later`

What a sending server is told when the spool's budget is spent: at MAIL
FROM, while a message as large as `inbound.maxMessageSize` would not
fit besides those waiting, or at the end of DATA, when the message ran
past it as it came. The budget is `inbound.spoolBytes`, 20 times
`inbound.maxMessageSize` by default. It is a burst of large messages at
once, or many sessions held open mid-DATA; the sending server tries
again. The log says `deferred: the spool is full`. Raise
`inbound.spoolBytes` if the disk has room. One client holds
`inbound.maxConnectionsPerClient` sessions at most (10 by default). On
465 and 587, a user's message waits in the same spool while it is
signed, and gets the same reply.

### `552 5.3.4 Message header too large`

The message's header is over 256 KiB. No real mail has such a header;
it is refused, on 25 as on 465 and 587 (the log says `refused: its
header is over 256 KiB`, after `mx:`, `submissions:` or `submission:`).

### `550 5.1.1 No recipient of this message is here any longer`

Each recipient was accepted, then removed from the directory before the
message ended. The sending server reports it.

### `451 4.3.0 Message not taken, try again later`

Most often the message could not be written to the spool — a full
disk, a permission changed under the running server — which the log
records as [`mx: … not spooled: …`](#mx--not-spooled-). It is also the
answer when the session ended while the message was being delivered
([`abandoned before …`](#mx--abandoned-before--the-session-ended)). The
sending server tries again. A message the SMTP server cut off itself
gets that server's own reply instead: too big (`552 5.3.4`) or a bare
line break (`550 5.6.11`); a lost connection gets no reply at all.

### `451 4.3.0 Local error in processing`

What a sending server is told when the store or the directory failed
during its session, the message's spooled file could not be read back
while it was delivered (a failure of this server's disk), or a check ran
past the 60 seconds the SMTP server gives it. It tries again later. The
log has the reason, as [`mx: error in a session from
…`](#mx-error-in-a-session-from--).

### `421 4.3.2 … Too many connections, try later`

`inbound.maxConnections` sessions are open already; one more is told
this and closed, and its server tries again. Raise
`inbound.maxConnections` if honest servers hit it.

### `421 4.7.0 … Too many connections from your address, try later`

One client — an IPv4 address, or an IPv6 /64 — already holds
`inbound.maxConnectionsPerClient` sessions on port 25 (10 by default),
or `submission.maxConnectionsPerClient` on 465 or 587; one more is told
this and closed, before anything else. A sending server tries again.
Raise the key if many honest clients share an address, such as users
behind one NAT on submission.

### `550 5.1.1 No postmaster mailbox is configured here`

What a client is told for the bare `RCPT TO:<postmaster>` when no
postmaster address resolves: `postmaster` is not set and the first
hosted domain, by name, has no `postmaster@` user or alias, or
`postmaster` names an address nobody here has. RFC 5321 §4.5.1 asks
every server to take it. Give it somewhere to go:

```sh
bumail alias add postmaster@example.com alice@example.com
```

or set `postmaster = "alice@example.com"` at the top of the file.

### `bumail: postmaster … is in …, a domain not hosted here; mail for <postmaster> is refused until it is`

At start: `postmaster` names an address in a domain this server does
not host, so the bare `<postmaster>` resolves to nobody and is refused
with [`550 5.1.1 No postmaster mailbox is configured here`](#550-511-no-postmaster-mailbox-is-configured-here).
Set `postmaster` to a user or an alias of a hosted domain, or host the
domain:

```sh
bumail domain add example.com
```

### `imaps: login refused from …: …`

In the log (`imap:` for port 143, `submissions:` and `submission:` for
465 and 587), for every login refused, with why: `password`,
`unknown` (no such user), `disabled`, `blocked` (the failure limiter:
10 failures within 15 minutes), `malformed` or `busy`. The client is
told only `NO`, except on `busy`, where it gets `NO [UNAVAILABLE]
Temporary authentication failure` and may try again soon. The password
is never logged. An SMTP client gets `535` (`454` on `busy`). See
[logins](directory.md#logins).

### `mx: error in a session from …: …`

In the log: the store or the directory failed during a session, a
message's spooled file could not be read back while it was delivered (an
I/O error of the disk under `<data>/spool`), or a message's checks and
delivery ran past the 60 seconds the SMTP server gives its `onData`
hook; the reason has any store password masked. The SMTP client got `451
4.3.0` and will try again; an IMAP client got `NO [UNAVAILABLE]`, or `NO
[SERVERBUG]` for a failure the IMAP server did not expect. Check the
store (`store.url`), the disk and the DNS.

### `bumail: the mail store did not close cleanly: …`

In the log, during a stop (`the queue did not close cleanly` for the
queue's store): closing the mail store failed (a PostgreSQL
connection already gone, say), the reason with any password masked. The
directory is closed anyway, and the server still exits 0. A SQLite
store recovers its journal at the next start; nothing is lost that was
answered `250`.

### `bumail: the queue did not stop cleanly: …`

In the log, during a stop: the queue's store failed (a PostgreSQL or
Redis connection already gone, say) while the queue gave back the items
it had claimed and not yet begun, the reason with any password masked.
The stop goes on, and the server still exits 0. Nothing is lost: an
item not given back keeps its lease, which lapses (10 minutes), and it
is tried again then, by this server once restarted or by another
sharing the queue. Check the queue's store if it shows at every stop.

### `bumail: queue deliveries still under way are left to their leases`

In the log, during a stop: a delivery the queue had begun was still
talking to another server 5 seconds after the SMTP sessions ended, or a
second signal skipped the wait. The queue's store is closed anyway. The
item keeps its lease, which lapses (10 minutes), and it is tried again
then, by this server once restarted or by another sharing the queue: if
the other server took the message just before the stop, it gets it
twice. What the queue had claimed and not begun was given back at once.

### `mx: … not spooled: …`

In the log: a message could not be written to `<data>/spool` — a full
disk, a permission changed under the running server. The sending server
got `451 4.3.0` and tries again. Free the disk.

### `mx: … abandoned before …: the session ended`

In the log: the session ended (the client left, the 60 seconds to answer
ran out, the server stopped) while the message was being written for
several users. The users before the one named have it; the sending
server, never told `250`, sends it again, and they get it twice.

## Sending

What a user's mail client is told on 465 and 587, and what the queue
logs as it delivers. See [sending mail](serve.md#sending-mail-on-465-and-587).

### `530 …`, `538 …`: AUTH and MAIL refused before TLS or a login

`@bumail/smtp`'s own replies on submission: `538 5.7.11` to AUTH on 587
before STARTTLS — AUTH is neither offered nor taken in clear — and
`530 5.7.0` to MAIL before a login. Set the client to "STARTTLS" on
587, or "SSL/TLS" on 465, with "normal password" authentication.

### `535 …`: the login refused

A wrong address or password, a disabled user, or a client blocked by
the failure limiter (10 failures within 15 minutes, its right password
included); the log says which, as `submissions: login refused from …:
…`. Three failures in a session and the server hangs up. The login is
the user's address, in any case.

### `553 5.7.1 Not authorized to send as <…>`

MAIL FROM is not the logged-in user's address nor an alias it is one of
the users of; the null sender `<>` is refused too. A user sends as
itself: point the client's identity at the address it logs in with, or
`bumail alias add` the address to that user. The log says
`submissions: … refused as sender <…>`.

A session that logged in and then gets this for its own address: the
user was removed, disabled or given a new password since the login,
and the session sends nothing more. The client logs in again (with the
new password); a disabled user cannot.

### `550 5.7.1 The From field names an address that is not yours`

The message's From names an address the user may not send as — the
same rule as MAIL FROM — or one this server cannot read plainly: a
quoted local part, an address in a display name or a comment that is
not the user's, an `@` that belongs to no plain address. A reader must
never be shown an author that was not checked. Encoded-words are read
as an allow-list:

- every `=?` must start a well-formed word with no white space inside it;
- B text must be whole base64 groups, padded only at the end, with no
  `-` or `_`, and Q text must follow every `=` with two hex digits;
- the charset must be UTF-8, US-ASCII, ISO-8859-1 to 16 or
  windows-1250 to 1258, and a UTF-8 word must hold whole characters;
- no word may hold or decode to an `@`, or in UTF-8 to `＠` or `﹫`,
  which are refused written plainly too.

`=?UTF-8?Q?ceo=40bank.example?= <you@example.com>` shows a reader
`ceo@bank.example`, and is refused. A name encoded in ISO-2022-JP,
Shift_JIS, GB2312, Big5, EUC-KR, KOI8-R or UTF-7 is refused even when it
holds no `@`: set the mail client to encode headers in UTF-8. A From
field that is not valid UTF-8 written raw, or over 64 KiB, is refused
as well. Write From as
`Name <you@example.com>`.

### `550 5.6.0 The message needs exactly one From field`

The message has no From, or two (RFC 5322 §3.6). Every mail client
writes one; a script writing its own message must too.

### `550 5.6.0 The From field must name your address`

The From field names no address at all: a group with no member, such as
`undisclosed:;`, or a bare name. A message sent here must say who wrote
it, as an address the user may send as. Write From as
`Name <you@example.com>`; to hide the recipients, put them in Bcc, not
in From.

### `553 5.1.3 The address is not one this server can send to`

A recipient in another domain whose address SMTP cannot carry as
written: a local part over 64 characters, say. Check the address.

### `550 5.7.1 Mail to an address literal is not sent from here`

A recipient written with an address literal for its domain,
`carol@[192.0.2.1]` or `carol@[IPv6:2001:db8::1]`: the queue would
connect to whatever host a user names, this one's own services
included, so submission refuses it at RCPT. Send to the domain's name
instead.

### `452 4.3.1 The queue is full, try again later`

The queue refused the message: full (`452 4.3.1`), too big for it
(`552 5.3.4 Message too big for the queue`, past
`submission.maxMessageSize` and the room kept for the signature), or
with too many recipients (`452 4.5.3 Too many recipients`). The log says
`submissions: … not queued: …`. A full queue clears as it delivers.

### `submissions: … not queued: …`

In the log (`submission:` on 587): the queue refused a message, with
the queue's reason, its password masked; the client got one of the
replies above or `451 4.3.0`, and sends it again. A store that is down
(PostgreSQL, Redis) shows here first.

### `submissions: … refused as sender <…>`

In the log: the user named tried MAIL FROM another address, and got
[`553 5.7.1`](#553-571-not-authorized-to-send-as-).

### `submissions: … (unsigned)`

In the log, after a message sent: it was sent without a DKIM signature,
its From domain having no key. Mail from a domain with no DKIM key
fails DMARC wherever SPF does not align, and lands in spam:

```sh
bumail dkim generate example.com
```

then publish the TXT record it prints.

### `submissions: … taken for nobody here any longer`

In the log (`submission:` on 587): a message was taken, but every local
recipient it had at RCPT was removed from the directory before its end,
and it had none in another domain, so it went nowhere. Nothing to do,
unless the removal was a mistake.

### `outbound: … deferred until …: …`

In the log: a recipient's server, or the smarthost, answered `4xx`, or
could not be reached, and the queue tries again at the time given:
after 30 minutes, then 1, 2 and 4 hours, then every 4 hours, for 5
days. The reason is what the other side said (`… 4.7.0 TLS with … failed`,
`Could not connect to …`). A remote host often greylists the first
attempt. Every message deferred: check that port 25 out is open from
this host, or set a `[smarthost]`.

### `outbound: … failed: …`

In the log: a recipient's server answered `5xx` (`550 5.1.1` for an
unknown user, say), or the queue gave up after 5 days. The sender gets
a delivery status notification in its INBOX, from `<>`, with the reply
and the original's header — `outbound: …: a failed DSN to <…> queued as
…`, then its delivery. A DSN is never sent out of the server: it goes to
the local sender's own mailbox, and nothing is sent about a DSN.

### `outbound: error …: …`

In the log: the queue itself failed — its store (a PostgreSQL or Redis
down, a full disk), a lease lost to another worker, or a route
`sendMail` refuses (`INVALID_OPTION`, such as a smarthost that sends
credentials without TLS), which defers its recipients as `4.3.5` until
fixed. The reason has the queue URL's password masked.

## Usage

The command exits 2, with `ServerError`'s code `USAGE`, for:

- `bumail: no command given; see bumail --help`
- `bumail: unknown command …; see bumail --help` — the commands are
  `serve`, `check-config`, `domain`, `user`, `alias` and `dkim`. A word that is
  not lowercase letters and hyphens is shown as `…`, in case it is a
  password; so is an unexpected argument.
- `bumail: unknown option …; see bumail --help` — the options are
  `--config`, `--password-stdin`, `--password-file`, `--purge`,
  `--selector`, `--replace`, `-h` or
  `--help`, and `-v` or `--version`. A short option is named by its
  first letter alone (`-p…`), and a long one without what follows its
  `=`, so neither repeats a password typed there.
- `bumail: unexpected argument …; see bumail --help` — `serve` and
  `check-config` take no operand.
- `bumail: --config needs a file; see bumail --help`, and the same for
  `--password-file`; `--selector needs a selector`.
- `bumail: --config is given twice; see bumail --help`, and the same for
  `--password-file` and `--selector`.

The directory commands add:

- `bumail: … needs a command: …; see bumail --help` — `bumail user`
  alone; the message lists the commands it takes.
- `bumail: unknown command … …; … takes …; see bumail --help` —
  `bumail domain rename`.
- `bumail: … takes …; see bumail --help` — an operand missing, or one
  too many: `domain add takes one domain`, `alias add takes an address,
  then one or more users`, `user list takes a domain at most`. For
  `user add` and `user passwd` it reads `user add takes one address: a
  password is never taken from the command line`, the extra operand
  being, most likely, a password: it is not repeated.
- `bumail: … takes no --password-stdin; see bumail --help`, and the
  same for `--password-file`, `--purge`, `--selector` and `--replace`:
  only `user add` and `user passwd` read a password, only `user remove`
  purges, only `dkim generate` takes a selector or replaces a key.
- `bumail: --password-stdin and --password-file are both given; give one; see bumail --help`
- `bumail: a password is never taken from the command line: use --password-stdin or --password-file, or type it at the prompt; see bumail --help`
  — an option starting with `-pass` or `--pass`, such as
  `--password=…`. Its value is not repeated.
- `bumail: standard input is not a terminal, so no password can be typed: give --password-stdin or --password-file; see bumail --help`
  — `user add` or `user passwd` without either option, in a script or
  a container without a terminal.

```sh
bumail --config /data/bumail.toml check-config
bumail user add alice@example.com --password-file /run/secrets/alice
```
