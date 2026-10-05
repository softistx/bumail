# bumail

A mail server native to Bun, published as `@bumail/*` packages: SMTP in and
out, MIME, DKIM / SPF / DMARC, mail storage, and access to mailboxes. No
package has a runtime dependency. The server app at the end is built on
[alxia](https://github.com/softistx/alxia).

New to mail servers, or to bumail? Start with
[docs/overview.md](./docs/overview.md): what each part of a mail server
does, and which package does it.

## Status

| package | what it is |
| --- | --- |
| [`@bumail/acme`](./packages/acme) | an ACME client: certificates from Let's Encrypt or any ACME CA over HTTP-01, with its primitives — a certificate signing request for DNS names, signed JWS requests, the JWK thumbprint, keys as PEM |
| [`@bumail/auth`](./packages/auth) | DKIM: verify every signature on a message and sign outbound mail (rsa-sha256, ed25519-sha256); SPF checking; DMARC and the `Authentication-Results` header |
| [`@bumail/dns`](./packages/dns) | the DNS a mail server reads (MX, TXT, A, AAAA, PTR): on `node:dns`, a fixture for specs, a TTL cache |
| [`@bumail/imap`](./packages/imap) | an IMAP4rev2 server that serves a store's mail to Thunderbird, Apple Mail and the rest, logging in only over TLS |
| [`@bumail/jmap`](./packages/jmap) | a JMAP server (RFC 8620, RFC 8621) mounted in an alxia app: mailboxes, emails, threads and blobs of a store over HTTP and JSON |
| [`@bumail/mime`](./packages/mime) | read and write e-mail messages, with a streaming parser |
| [`@bumail/queue`](./packages/queue) | the outbound queue: each recipient's state, retries with back-off, delivery status notifications, leases for several workers, a memory, a `bun:sqlite`, a PostgreSQL and a Redis store |
| [`@bumail/smtp`](./packages/smtp) | an SMTP server that receives mail, and never relays without AUTH; and, on `@bumail/smtp/client`, a client that sends it out to a smarthost or by MX |
| [`@bumail/store`](./packages/store) | where a mail server keeps its mail: a contract, a memory store, a `bun:sqlite` store on disk and a PostgreSQL store for several instances |

All nine are on npm. The server app that wires them together,
[`@bumail/server`](./packages/server), is on npm too, and as the Docker image
`ghcr.io/softistx/bumail`: it reads and checks its configuration (`bumail check-config`),
manages its domains, users, aliases and DKIM keys (`bumail domain`,
`user`, `alias` and `dkim`), and, with `bumail serve`, receives mail on
port 25, sends its users' mail from 465 and 587 (AUTH only after TLS,
DKIM-signed) through its queue, by MX or a smarthost, and serves the
mailboxes over IMAP on 993 and over JMAP on 443 (HTTPS, or plain HTTP
behind a reverse proxy such as Traefik that ends TLS), with a certificate
from files or from an ACME CA (`@bumail/acme`, renewed by the server), a health
check (`GET /healthz`) on loopback and the PROXY protocol, from proxies
you list, on the mail ports, and it runs as a Docker image. What comes — the rest of the server app, a blob
store — in what order and why, is in
[docs/roadmap.md](./docs/roadmap.md).

## Development

```sh
bun install
bun run check            # Biome
bun run build            # every package, dependencies first
bun run typecheck
bun run test
bun run verify:artifacts # pack, install and import every package
```

The specs of `@bumail/queue/postgres` and `@bumail/store/postgres` need
a PostgreSQL, those of `@bumail/queue/redis` a Redis, and those of
`@bumail/acme`'s client Pebble, Let's Encrypt's test CA; each is
skipped, saying so, without one.
`bun run postgres:test` starts `postgres:17` in Docker, `bun run
redis:test` starts `redis:7`, `bun run pebble:test` starts Pebble, and
each prints the line to export:

```sh
eval "$(bun run --silent postgres:test)"   # sets BUMAIL_TEST_POSTGRES_URL
eval "$(bun run --silent redis:test)"      # sets BUMAIL_TEST_REDIS_URL
eval "$(bun run --silent pebble:test)"     # sets BUMAIL_TEST_PEBBLE_URL and _CA
bun run test
bun run postgres:test stop                  # removes the container
bun run redis:test stop
bun run pebble:test stop
```

How the repository is laid out and the rules every package keeps are in
[AGENTS.md](./AGENTS.md).

## License

MIT
