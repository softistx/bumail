# @bumail/server

The bumail mail server: the `@bumail/*` packages wired into one process,
configured by one TOML file, run as the `bumail` command.

**In progress, and private for now.** This package is not on npm yet: it
is built here slice by slice, and published once it is complete. Today
it reads and checks its configuration (`bumail check-config`), manages
its directory of domains, users and aliases (`bumail domain`, `bumail
user`, `bumail alias`), and **receives mail**: `bumail serve` takes
mail for its users on port 25 and serves it over IMAP on 993, with a
certificate from files. Sending mail, JMAP and ACME come next; see the
[roadmap](https://github.com/softistx/bumail/blob/develop/packages/server/docs/roadmap.md).

**Bun only**, like every `@bumail/*` package: it runs on Bun 1.4.2 or
later. It peers on the packages it wires: `@bumail/store`,
`@bumail/smtp`, `@bumail/imap`, `@bumail/auth` and `@bumail/dns`.

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

## Serving

```sh
bumail serve --config /data/bumail.toml
```

```text
bumail: serving mail.example.com
bumail: mx listening on 0.0.0.0:25: SMTP from other servers: STARTTLS offered, no AUTH, mail for hosted addresses only
bumail: imaps listening on 0.0.0.0:993: IMAP over TLS from the first byte
mx: 1kq2f… from 192.0.2.10 <joe@example.org> delivered to alice@example.com (spf=pass dkim=pass dmarc=pass)
```

- **Port 25 takes mail for the directory's addresses only**: a user, or
  an alias, delivered to each of its users. An unknown address in a
  hosted domain gets `550 5.1.1 User unknown`, any other domain
  `554 5.7.1 Relay access denied`. AUTH is never offered there, so no
  session can relay. STARTTLS is offered, not required.
- **SPF, DKIM and DMARC** are checked on each message. With
  `inbound.dmarc = "enforce"` (the default), `p=reject` is refused with
  `550` during the session and `p=quarantine` goes to Junk; `"mark"`
  only records. The result goes into an `Authentication-Results` field,
  and any field already there claiming the server's name is removed.
- **No bounce is ever sent** for inbound mail: a refusal is a reply in
  the session.
- **IMAP on 993** logs users in through the directory, its failure
  limiter counting each client's IP. Port 143 (`ports.imap`) is off; on,
  it refuses logins until STARTTLS.
- **`tls.mode = "files"` only, for now.** `"acme"` is the default, so
  a minimal configuration makes `serve` exit 3 until ACME arrives: set
  `tls.mode = "files"`, with `cert` and `key`.
- **SIGTERM or SIGINT** stops it cleanly: no new connection, SMTP
  sessions given 10 seconds to finish, then the store closed. It exits 0.

The other ports (465, 587, 443, 80, 8080) are logged as arriving later
and bound to nothing. [Running the server](https://github.com/softistx/bumail/blob/develop/packages/server/docs/serve.md)
has every listener, the log and the stop in detail.

## The directory

Domains, users and aliases live in one SQLite file, `directory.url`
(default `sqlite:<data>/directory.sqlite`), managed by the command:

```sh
bumail domain add example.com
bumail user add alice@example.com            # prompts for the password, twice
printf '%s\n' "$PASSWORD" | bumail user add bob@example.com --password-stdin
bumail user add carol@example.com --password-file /run/secrets/carol
bumail alias add sales@example.com alice@example.com bob@example.com

bumail domain list      # example.com  3 users, 1 alias
bumail user list        # one address a line; bumail user list example.com for one domain
bumail alias list       # sales@example.com  alice@example.com, bob@example.com

bumail user passwd alice@example.com
bumail user disable bob@example.com          # no login; mail still delivered
bumail user enable bob@example.com
bumail alias remove sales@example.com
bumail user remove carol@example.com         # keeps its mail in the store
bumail user remove bob@example.com --purge   # deletes its mail too
bumail domain remove example.com             # refused while it has users or aliases
```

- **Names are lowercase**, local parts included: `Alice@Example.COM` is
  `alice@example.com`, and no two users differ by case alone.
- **A password is never an argument**: a prompt, `--password-stdin` or
  `--password-file`. It is at least 12 characters, at most 1024 bytes,
  hashed with argon2id (19 MiB, two passes), and never printed.
- **`user add` creates the user's mailboxes** in the mail store
  (`INBOX`, `Sent`, `Drafts`, `Archive`, `Junk`, `Trash`). While the
  server holds a SQLite store, the server creates them at the first
  login instead.
- **Removing a user keeps its mail**, so a mistake costs nothing;
  `--purge` deletes it.
- **An alias points to local users only.** Forwarding to an address
  elsewhere would make the server a relay, and is refused.
- **Changes count at once**: the server reads the file at every login
  and every recipient, with no restart.

Logins verify at most 4 hashes at once, verify a dummy hash for an
unknown user so the time taken does not reveal who exists, and are
counted per client: 10 failures within 15 minutes block a client (an
IPv6 /64 counting as one) until they age out.

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

The server, with a log of your own:

```ts
import { readConfig, serve } from '@bumail/server';

const server = await serve(await readConfig(), { log: (line) => console.log(line) });
server.listening; // [{ name: 'mx', hostname: '0.0.0.0', port: 25 }, { name: 'imaps', … }]
process.on('SIGTERM', () => void server.stop());
```

The directory, for the listeners:

```ts
import { Directory, directoryFile, readConfig, smtpAuthenticate } from '@bumail/server';

const config = await readConfig();
const directory = Directory.open({ file: directoryFile(config.directory.url) });

directory.domains.has('example.com'); // true: the domains the MX takes mail for
directory.resolve('Sales@example.com'); // ['alice@example.com', 'bob@example.com'], or undefined
await directory.authenticate('alice@example.com', 'correct horse battery staple', '192.0.2.1');
// { ok: true, user: { address: 'alice@example.com', … } }, or { ok: false, reason: 'password' }

const authenticate = smtpAuthenticate(directory); // @bumail/smtp's authenticate option
```

## The command

| | |
| --- | --- |
| `bumail check-config` | check the configuration, print a summary; exits 0, or 1 |
| `bumail serve` | check the configuration, then run the server until SIGTERM or SIGINT; exits 0 once stopped, 3 for `tls.mode = "acme"`, 5 for a port or a file it cannot use |
| `bumail domain add\|list\|remove` | the domains the server hosts |
| `bumail user add\|list\|passwd\|disable\|enable\|remove` | the users; `--password-stdin`, `--password-file`, `remove --purge`; `list [<domain>]` |
| `bumail alias add\|list\|remove` | the aliases, to local users only; `list [<domain>]` |
| `--config <file>`, `--config=<file>` | the file; default `$BUMAIL_CONFIG`, then `/data/bumail.toml` |
| `-h`, `--help` | print the usage |
| `-v`, `--version` | print the version |

Bad usage exits 2, a refusal of the directory 4 (an address, a
password, a name taken, not found, still in use), and a directory, a
mail store, a port or a certificate that cannot be used 5.

## API

| export | what it is |
| --- | --- |
| `readConfig(options?)` | reads, checks and fills in the configuration: `path`, `env` (default `process.env`), `now` (for the certificate's validity) |
| `configPath(options?)` | the file `readConfig` reads: `path`, else `BUMAIL_CONFIG`, else `DEFAULT_CONFIG_PATH` |
| `DEFAULT_CONFIG_PATH` | `/data/bumail.toml` |
| `ServerError` | thrown with a `code` (`INVALID_CONFIG`, `USAGE`, `INVALID`, `NOT_FOUND`, `ALREADY_EXISTS`, `IN_USE`, `UNAVAILABLE`, `NOT_IMPLEMENTED`) and, for a configuration, its `problems` |
| `serve(config, options?)` | runs the server: `mx`, `imaps` and `imap` for the ports not 0; answers a `RunningServer`. `options`: `log`, `resolver` (a `@bumail/dns` `Resolver`), `port(listener, configured)` (0 for a free port), `drainSeconds` |
| `RunningServer`, `Listening`, `ListenerName`, `ServeOptions`, `Log` | `listening` (`name`, `hostname`, `port`), `stop({ force? })`; the types around them |
| `DEFAULT_DRAIN_SECONDS`, `ACME_LATER` | 10, the seconds a stop waits for SMTP sessions; what `serve` says of `tls.mode = "acme"` |
| `Directory` | `Directory.open({ file, maxVerifies?, maxQueuedVerifies?, cacheSeconds?, onUnlimited?, limiter? })`: `domains`, `users`, `aliases`, `authenticate(login, password, ip)`, `resolve(address)`, `limiter`, `close()` |
| `Domains`, `Users`, `Aliases` | the types of its three parts: `add`, `get`, `list`, `remove`, and `has` (domains), `setPassword`, `setDisabled`, `require`, `checkAddable`, `checkRemovable` (users; none hands out a hash), `targets` (aliases) |
| `DomainEntry`, `UserEntry`, `AliasEntry` | what they answer |
| `AuthResult`, `AuthFailure`, `AuthenticatorOptions`, `DirectoryOptions` | `authenticate`'s answer, its reasons (`blocked`, `malformed`, `unknown`, `password`, `disabled`, `busy`), and the options |
| `FailureLimiter`, `FailureLimiterOptions`, `Begun`, `clientKey(ip)` | failed logins per client: `blocked(ip)`; `begin(ip)`, answering a `Begun` (`'started' \| 'blocked' \| 'busy'`), and `end(ip, failed)` around a login; `fail(ip)`, for a login that cost a verify; `limits(ip)`; `blockedUntil(ip)`; `maxFailures` (10), `windowSeconds` (900), `maxClients` (100 000), `maxPending` (5, capped at `maxFailures`). `clientKey(ip)` is the key a client is counted under, or `undefined` for anything that is no IP address, which is not limited |
| `smtpAuthenticate(directory, options?)`, `imapAuthenticate(directory, store, options?)`, `jmapAuthenticate(directory, store, ipOf, options?)` | `authenticate` in the shape `@bumail/smtp`, `@bumail/imap` and `@bumail/jmap` take; `options.onRefused(reason, ip)` |
| `Authenticates`, `LoginCredentials`, `ClientSession`, `JmapLogin`, `AdapterOptions`, `BUSY_MESSAGE` | the types around them, and what they throw on `busy` |
| `provisionAccount(store, address)`, `purgeAccount(store, address)`, `MAILBOXES` | a user's account in the mail store, with its six mailboxes; deleting it |
| `openStore(config.store)`, `OpenedStore` | opens the mail store `store.url` names |
| `directoryFile(url)` | the file of a `sqlite:` directory URL |
| `addressOf(text)`, `domainOf(name)`, `Address`, `MAX_LOCAL_BYTES`, `MAX_ADDRESS_BYTES` | an address or a domain as the directory keeps it, or `undefined` |
| `HASH_OPTIONS`, `MIN_PASSWORD_LENGTH`, `MAX_PASSWORD_BYTES`, `DEFAULT_MAX_VERIFIES`, `DEFAULT_MAX_QUEUED_VERIFIES` | the password rules and the verify cap |
| `ServerConfig` and its sections' types | what `readConfig` answers: `PortsConfig`, `StoreConfig`, `QueueConfig`, `DirectoryConfig`, `TlsConfig`, `AcmeConfig`, `SmarthostConfig`, `SmarthostTls`, `RouteConfig`, `InboundConfig`, `SubmissionConfig`, `JmapConfig` |
| `ReadConfigOptions`, `Env`, `ConfigProblem`, `ServerErrorCode` | the types around them |

## Documentation

- [Index](https://github.com/softistx/bumail/blob/develop/packages/server/docs/README.md): the pages below, and when to read each.
- [Guide](https://github.com/softistx/bumail/blob/develop/packages/server/docs/guide.md): every key of the configuration, its default, and what the environment overrides.
- [Running the server](https://github.com/softistx/bumail/blob/develop/packages/server/docs/serve.md): `bumail serve`, each listener, what port 25 takes and refuses, SPF, DKIM and DMARC, IMAP logins, the log and the stop.
- [The directory](https://github.com/softistx/bumail/blob/develop/packages/server/docs/directory.md): domains, users and aliases, every command with an example, passwords, logins and the failure limiter.
- [Troubleshooting](https://github.com/softistx/bumail/blob/develop/packages/server/docs/troubleshooting.md): every problem `check-config` reports, every refusal of the directory commands, every reason `serve` stops or refuses a message, and what to do about it.
- [Roadmap](https://github.com/softistx/bumail/blob/develop/packages/server/docs/roadmap.md): what is coming, and what is not planned.
