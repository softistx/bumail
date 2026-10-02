# bumail

A mail server native to Bun, published as `@bumail/*` packages: SMTP in and
out, MIME, DKIM / SPF / DMARC, mail storage, and access to mailboxes. No
package has a runtime dependency. The server app at the end is built on
[alxia](https://github.com/softistx/alxia).

## Status

| package | what it is |
| --- | --- |
| [`@bumail/mime`](./packages/mime) | read and write e-mail messages, with a streaming parser |
| [`@bumail/smtp`](./packages/smtp) | an SMTP server that receives mail, and never relays without AUTH |

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
