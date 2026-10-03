# bumail

A mail server native to Bun, published as `@bumail/*` packages: SMTP in and
out, MIME, DKIM / SPF / DMARC, mail storage, and access to mailboxes. No
package has a runtime dependency. The server app at the end is built on
[alxia](https://github.com/softistx/alxia).

## Status

| package | what it is |
| --- | --- |
| [`@bumail/auth`](./packages/auth) | DKIM: verify every signature on a message and sign outbound mail (rsa-sha256, ed25519-sha256); SPF; DMARC with its organizational domain; the `Authentication-Results` header |
| [`@bumail/dns`](./packages/dns) | the DNS a mail server reads (MX, TXT, A, AAAA, PTR): on `node:dns`, a fixture for specs, a TTL cache |
| [`@bumail/imap`](./packages/imap) | an IMAP4rev2 server that serves a store's mail to Thunderbird, Apple Mail and the rest, logging in only over TLS |
| [`@bumail/mime`](./packages/mime) | read and write e-mail messages, with a streaming parser |
| [`@bumail/smtp`](./packages/smtp) | an SMTP server that receives mail, and never relays without AUTH; and, on `@bumail/smtp/client`, a client that sends it out to a smarthost or by MX |
| [`@bumail/store`](./packages/store) | where a mail server keeps its mail: a contract, a memory store and a `bun:sqlite` store on disk |

Nothing is published yet. What comes, in what order and why, is in
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

How the repository is laid out and the rules every package keeps are in
[AGENTS.md](./AGENTS.md).

## License

MIT
