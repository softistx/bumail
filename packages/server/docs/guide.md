# Configuration reference

`@bumail/server` reads one TOML file. This page lists every key it
takes, with its default; anything else is refused, with the closest key
it knows (`max_message_size` → `maxMessageSize`). When something is
wrong, [troubleshooting](troubleshooting.md) has an entry for each
problem.

- [Where the file is](#where-the-file-is)
- [The environment](#the-environment)
- [Checking a file](#checking-a-file)
- [Top-level keys](#top-level-keys): `hostname`, `data`, `bind`
- [`[ports]`](#ports)
- [`[store]`, `[queue]`, `[directory]`](#store-queue-directory)
- [`[tls]` and `[acme]`](#tls-and-acme)
- [`[smarthost]`](#smarthost)
- [`[routes]`](#routes)
- [`[inbound]`](#inbound)
- [`[submission]`](#submission)
- [`[jmap]`](#jmap)
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

A store is shown by its scheme only. With problems, every one is listed
(`bumail: <file>:` then one `  path: problem` line each) and the command
exits 1. No problem repeats a URL or a secret.

| exit code | meaning |
| --- | --- |
| 0 | valid (`check-config`), or `--help`, `--version` |
| 1 | the configuration has problems, or cannot be read |
| 2 | bad usage: an unknown command or option |
| 3 | `serve`: the configuration is valid, but serving is not implemented yet |

## Top-level keys

```toml
hostname = "mail.example.com"
data = "/data"
bind = "0.0.0.0"
```

| key | default | |
| --- | --- | --- |
| `hostname` | required | the server's own name: its MX host, the name in its greeting, the name its certificate must hold. A fully qualified name, taken lowercase, a trailing dot dropped. `BUMAIL_HOSTNAME` overrides it |
| `data` | `/data` | an absolute directory, for everything the server keeps: the default stores below, and the ACME certificates |
| `bind` | `0.0.0.0` | the IPv4 or IPv6 address every public listener binds to; `::` for both families where the host allows it |

## `[ports]`

Each listener's port; `0` turns it off. Two listeners never share a port.

| key | default | listener |
| --- | --- | --- |
| `mx` | 25 | SMTP from other servers. Never AUTH here, and never relaying |
| `submissions` | 465 | submission over implicit TLS (RFC 8314) |
| `submission` | 587 | submission with STARTTLS |
| `imaps` | 993 | IMAP over implicit TLS |
| `imap` | 0 | IMAP with STARTTLS; off unless you turn it on |
| `https` | 443 | JMAP |
| `http` | 80 | ACME's HTTP-01 challenges; needed with `tls.mode = "acme"` |
| `health` | 8080 | the health check, on loopback only |

## `[store]`, `[queue]`, `[directory]`

Each is a `url`, which says which store answers.

| section | default | schemes |
| --- | --- | --- |
| `[store]`, the mail | `sqlite:<data>/mail` | `sqlite:`, `postgres:`, `postgresql:` |
| `[queue]`, outbound mail | `sqlite:<data>/queue` | `sqlite:`, `postgres:`, `postgresql:`, `redis:`, `rediss:` |
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
- A URL with a password is a secret: keep it out of the file, in
  `BUMAIL_STORE_URL_FILE` or `BUMAIL_QUEUE_URL_FILE`.

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
| `acme.email` | required with `"acme"` | the account's contact, for the CA's expiry notices |
| `acme.acceptTerms` | required with `"acme"` | must be `true`: you have read the CA's terms of service and accept them |
| `acme.directory` | Let's Encrypt | the CA's directory URL, `https:` |

With `"acme"`, certificates come by HTTP-01 on `ports.http`, so it must
not be 0, and port 80 must reach the server from the Internet. `cert`
and `key` are refused there, and `[acme]` is refused with `"files"`.

With `"files"`, `check-config` reads both files and checks that:

- each is there and readable;
- the certificate is PEM and has not expired;
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

A route of its own takes `host`, `port`, `secure` and `tls`, as
`[smarthost]` does, and no credentials.

## `[inbound]`

Mail from other servers, on `ports.mx`.

| key | default | |
| --- | --- | --- |
| `dmarc` | `"enforce"` | `"enforce"`: a message failing DMARC under `p=reject` is refused during the session, under `p=quarantine` it goes to Junk. `"mark"`: only recorded, in `Authentication-Results` |
| `maxMessageSize` | 26214400 (25 MiB) | bytes, from 1 to 1073741824 |
| `maxConnections` | 1000 | from 1 to 100000 |

## `[submission]`

Mail from the server's own users, on `ports.submissions` and
`ports.submission`, always authenticated, always over TLS.

| key | default | |
| --- | --- | --- |
| `maxMessageSize` | 26214400 (25 MiB) | bytes, from 1 to 1073741824 |
| `maxRecipients` | 100 | per message, from 1 to 10000 |
| `maxConnections` | 1000 | from 1 to 100000 |

## `[jmap]`

| key | default | |
| --- | --- | --- |
| `origin` | `https://<hostname>`, with `:<ports.https>` when it is not 443 | where clients reach JMAP: an `https:` origin, no path. Set it when a proxy in front serves another name or port |

## What is never an option

`relay`, `mynetworks` and `trustedNetworks` are refused wherever they
appear: `not an option: bumail never relays without AUTH`. Mail for a
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
