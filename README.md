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
| [`@bumail/auth`](./packages/auth) | DKIM: verify every signature on a message and sign outbound mail (rsa-sha256, ed25519-sha256); SPF checking; DMARC and the `Authentication-Results` header |
| [`@bumail/dns`](./packages/dns) | the DNS a mail server reads (MX, TXT, A, AAAA, PTR): on `node:dns`, a fixture for specs, a TTL cache |
| [`@bumail/imap`](./packages/imap) | an IMAP4rev2 server that serves a store's mail to Thunderbird, Apple Mail and the rest, logging in only over TLS |
| [`@bumail/jmap`](./packages/jmap) | a JMAP server (RFC 8620, RFC 8621) mounted in an alxia app: mailboxes, emails, threads and blobs of a store over HTTP and JSON |
| [`@bumail/mime`](./packages/mime) | read and write e-mail messages, with a streaming parser |
| [`@bumail/queue`](./packages/queue) | the outbound queue: each recipient's state, retries with back-off, delivery status notifications, leases for several workers, a memory, a `bun:sqlite` and a PostgreSQL store (the last merged, not yet on npm) |
| [`@bumail/smtp`](./packages/smtp) | an SMTP server that receives mail, and never relays without AUTH; and, on `@bumail/smtp/client`, a client that sends it out to a smarthost or by MX |
| [`@bumail/store`](./packages/store) | where a mail server keeps its mail: a contract, a memory store and a `bun:sqlite` store on disk |

All eight are on npm. What comes — more stores, then a server app and a
Docker image that runs it — in what order and why, is in
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

The specs of `@bumail/queue/postgres` need a PostgreSQL, and are skipped,
saying so, without one. `bun run postgres:test` starts `postgres:17` in
Docker and prints the line to export:

```sh
eval "$(bun run --silent postgres:test)"   # sets BUMAIL_TEST_POSTGRES_URL
bun run test
bun run postgres:test stop                  # removes the container
```

How the repository is laid out and the rules every package keeps are in
[AGENTS.md](./AGENTS.md).

## License

MIT
