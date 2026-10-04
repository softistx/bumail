# @bumail/server

The bumail mail server: the `@bumail/*` packages wired into one process,
configured by one TOML file, run as the `bumail` command.

**In progress, and private for now.** This package is not on npm yet: it
is built here slice by slice, and published once it serves mail. Today
it reads and checks its configuration (`bumail check-config`); `bumail
serve` checks it too, then says it is not implemented yet. What comes
next is in the [roadmap](https://github.com/softistx/bumail/blob/develop/packages/server/docs/roadmap.md).

**Bun only**, like every `@bumail/*` package: it runs on Bun 1.4.2 or
later.

## The configuration

One TOML file, `/data/bumail.toml` unless `--config` or `BUMAIL_CONFIG`
names another. Only `hostname` is required; with the default
`tls.mode = "acme"`, so is `[acme]`'s e-mail and its `acceptTerms`.

```toml
hostname = "mail.example.com"
data = "/data"             # the mail, the queue, the directory, the certificates

[ports]                    # 0 turns a listener off
mx = 25
submissions = 465
submission = 587
imaps = 993
https = 443
http = 80                  # ACME's HTTP-01 challenges
health = 8080              # on loopback only

[store]
url = "sqlite:/data/mail"  # or postgres://…?sslmode=require

[queue]
url = "sqlite:/data/queue" # or postgres://…, or rediss://…

[tls]
mode = "acme"              # or "files", with cert and key

[acme]
email = "postmaster@example.com"
acceptTerms = true

[smarthost]                # leave it out to deliver by MX
host = "smtp.example.net"
port = 465                 # with username, and passwordFile or BUMAIL_SMARTHOST_PASSWORD

[inbound]
dmarc = "enforce"          # p=reject refused, p=quarantine to Junk; or "mark"
```

The environment overrides URLs and secrets only, each over the file and
each also as `*_FILE`, which names a file holding the value (a Docker
secret): `BUMAIL_HOSTNAME`, `BUMAIL_STORE_URL`, `BUMAIL_QUEUE_URL` and
`BUMAIL_SMARTHOST_PASSWORD`.

There is no option to relay without authentication: `relay`,
`mynetworks` and `trustedNetworks` are refused wherever they appear.

## Checking it

```sh
bumail check-config --config ./bumail.toml
```

A valid file prints a summary and exits 0. Otherwise every problem is
listed at once, one `path: problem` line each, and it exits 1:

```text
bumail: ./bumail.toml:
  relay: not an option: bumail never relays without AUTH
  ports.submission: 465 is also ports.submissions
  store.url: the scheme "mysql:" is not one of sqlite:, postgres: or postgresql:
```

No problem repeats a URL or a secret: a URL is named by its scheme
alone.

Credentials to a store on another machine go over TLS, or not at all,
unless you say otherwise in so many words: `sslmode=disable` in a
PostgreSQL URL, `insecure = true` beside a `redis:` one. The summary
then shows such a store as `postgres (plaintext)` or `redis (plaintext)`.

## From code

```ts
import { readConfig, ServerError } from '@bumail/server';

try {
	const config = await readConfig({ path: './bumail.toml' });
	config.ports.mx; // 25
	config.store.url; // 'sqlite:/data/mail'
} catch (error) {
	if (!(error instanceof ServerError)) throw error;
	error.code; // 'INVALID_CONFIG'
	error.problems; // [{ path: 'ports.mx', problem: 'must be an integer from 0 to 65535' }, …]
}
```

## The command

| | |
| --- | --- |
| `bumail check-config` | check the configuration, print a summary; exits 0, or 1 |
| `bumail serve` | check the configuration, then (for now) exit 3: not implemented yet |
| `--config <file>`, `--config=<file>` | the file; default `$BUMAIL_CONFIG`, then `/data/bumail.toml` |
| `-h`, `--help` | print the usage |
| `-v`, `--version` | print the version |

Bad usage exits 2.

## API

| export | what it is |
| --- | --- |
| `readConfig(options?)` | reads, checks and fills in the configuration: `path`, `env` (default `process.env`), `now` (for the certificate's validity) |
| `configPath(options?)` | the file `readConfig` reads: `path`, else `BUMAIL_CONFIG`, else `DEFAULT_CONFIG_PATH` |
| `DEFAULT_CONFIG_PATH` | `/data/bumail.toml` |
| `ServerError` | thrown with a `code` (`INVALID_CONFIG`, `USAGE`) and, for a configuration, its `problems` |
| `ServerConfig` and its sections' types | what `readConfig` answers: `PortsConfig`, `StoreConfig`, `QueueConfig`, `DirectoryConfig`, `TlsConfig`, `AcmeConfig`, `SmarthostConfig`, `SmarthostTls`, `RouteConfig`, `InboundConfig`, `SubmissionConfig`, `JmapConfig` |
| `ReadConfigOptions`, `Env`, `ConfigProblem`, `ServerErrorCode` | the types around them |

## Documentation

- [Index](https://github.com/softistx/bumail/blob/develop/packages/server/docs/README.md): the pages below, and when to read each.
- [Guide](https://github.com/softistx/bumail/blob/develop/packages/server/docs/guide.md): every key of the configuration, its default, and what the environment overrides.
- [Troubleshooting](https://github.com/softistx/bumail/blob/develop/packages/server/docs/troubleshooting.md): every problem `check-config` reports, and what to do about it.
- [Roadmap](https://github.com/softistx/bumail/blob/develop/packages/server/docs/roadmap.md): what is coming, and what is not planned.
