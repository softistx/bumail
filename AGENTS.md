# AGENTS.md

Instructions for any coding agent working in `bumail`.

## What this repository is

A mail server native to Bun, published as `@bumail/*`. What is planned, in
what order and why, is in [docs/roadmap.md](./docs/roadmap.md); the table
below lists only what has landed.

| package | what it is | peers |
| --- | --- | --- |
| `@bumail/store` | the `MailStore` contract — accounts, mailboxes, messages, flags, UIDs, modseqs, changes — and its memory store | — |

Its skeleton is `softistx/alxia`'s, itself `softistx/nxgt-http`'s: the Bun
workspace, the root `build.ts`, Biome, changesets, `scripts/workspace.ts`,
`scripts/publish.ts` and `verify:artifacts`. A check added there is a check
to port here.

The repository is **private** until the owner says otherwise.

## Principles

- **No package has a dependency.** What one needs at runtime is a peer: a
  sibling `@bumail/*`, or `@alxia/core` for what speaks HTTP — once it is on
  npm: `verify:artifacts` refuses a required peer that is on no registry, so
  nothing here peers on alxia before its first publish. Bun's and the
  web platform's own APIs — `Bun.listen`, `socket.upgradeTLS`, `bun:sqlite`,
  `Bun.file`, Web Crypto, `TextDecoder`, `node:dns` — are not dependencies.
  `verify:artifacts` fails a manifest with a `dependencies` field that lists
  anything.
- **Never an open relay.** A message for a domain the server does not host
  is refused unless the session authenticated. That is the default of every
  server option, and every spec that relays authenticates first. A spec
  asserts the refusal; an option that would relay without AUTH does not
  exist.
- **AUTH only after TLS.** `AUTH` is not advertised, and is refused, on a
  connection that is not encrypted.
- **The RFC is the spec.** Every protocol package ships specs built on the
  RFC's own examples — the message, the header, the session transcript as
  printed in the RFC — and names the section each one comes from.
- **A store is a contract, with several answers.** What keeps state — the
  mailbox store, the outbound queue — defines its interface and ships a
  memory answer; `bun:sqlite` answers the same interface on disk. Whoever
  uses a store never knows which one it was given. The contract's specs are
  a `describe…` function in a `<subject>.fixtures.ts` beside the stores,
  run by each store's spec; `tsconfig.build.json` keeps fixtures out of
  `dist`.
- **The network is injected.** DNS and sockets reach a package through an
  option, so a spec never leaves the machine: a spec that needs MX, TXT or a
  peer server gets one from a fixture, never from the Internet.
- **Policy is a hook, not an option.** Accepting or refusing a connection, a
  sender, a recipient or a message is a hook the app gives the server; the
  server knows the protocol, the app knows the policy.
- **Streams, not strings, for message bodies.** A message can be large: what
  reads one reads a stream and keeps a bounded buffer.

## Layering

```
store           (standalone)
```

What is planned is in [docs/roadmap.md](./docs/roadmap.md); as packages land,
this section draws their arrows. A package that uses a sibling declares it by
`workspace:^`, as a peer and a devDependency, and imports it by its
published name, which resolves through `node_modules` to the sibling's
`dist/`. **There are no cycles.**

## The build

Every package is built by the root `build.ts`: JavaScript from `Bun.build`
with `packages: 'external'`, declarations from `tsc` against
`tsconfig.build.json`. Entry points are declared under `bumail.entrypoints`,
each with a matching key in `exports`.

- **Build before typecheck and tests**: `exports` points at `dist/`.
  `bun run build`, `typecheck` and `test` go through `scripts/workspace.ts`,
  which runs a package only after every sibling it names in any dependency
  field.
- **A build that exits 0 is not evidence the artifact loads.**
  `bun run verify:artifacts` packs, installs and imports every package.
- **Bun 1.4.2**, the version alxia and the nxgt suite pin.

## TypeScript

`tsconfig.base.json` is strict past `strict`: `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`,
`noUnusedLocals` and the rest. An app's own tsconfig may hold any of them,
so the published declarations must compile under all of them. Only
`scripts/`, copied from nxgt-http, relaxes two.

## Releasing

Changesets, independent versions. A change under `packages/` needs one.

**Releasing is off until the owner turns it on.** `release.yml` runs only
when the repository variable `RELEASE_ENABLED` is `true`, and only the owner
sets it: with no changeset pending, `changesets/action` runs the publish
script, which publishes every version the registry lacks — a package's
first included. The job runs in the `npm` environment. **Before setting
`RELEASE_ENABLED`, the owner creates that environment** with themself as
required reviewer and `NPM_TOKEN` as its only secret — GitHub creates a
missing environment on the first run, unprotected. Then every run that
could publish waits for the owner, and a PR that edits the workflow cannot
reach the token. Once on:

- merging to `develop` opens a "Version packages" PR; merging that publishes
  with `bun publish`, in dependency order;
- **the first publish of any `@bumail/*` package needs the owner's explicit
  answer**, every time, and nothing is published without their OK;
- releases are batched: weekdays, at 18:00 Eastern or later.

Registry configuration lives in `bunfig.toml`, never in `.npmrc`; publishing
reads `$NPM_TOKEN`, which must be an npm **granular** access token: npm no
longer accepts a classic token for publishing, and says "two-factor
authentication is required".

Every package is **public on npm** — the repository's privacy is a separate
matter — and MIT, with its own copy of `LICENSE`. Its manifest sets
`publishConfig: { "registry": "https://registry.npmjs.org", "access":
"public" }`: `bun publish` never reads the changeset config's `access`, and
publishes a scoped package as restricted without it. `verify:artifacts`
refuses a scoped manifest without `access: "public"`.

## Pull requests

Every PR goes into `develop`. Before merging:

1. the `nxgt-review` code-reviewer, its findings applied;
2. the `nxgt-docs` documentation-auditor, `ok: true` on the final head;
3. CI green on that head;
4. `gh pr merge <n> --merge --match-head-commit <sha>`.

## Conventions

- Biome, with tabs and single quotes. `./node_modules/.bin/biome check --write`
  before committing; `bunx biome ci` must pass.
- Commit messages: `<type>: <Capitalized summary>`, with `feat`, `fix`,
  `update`, `chore`, `docs`, `typo`, `ci`.
- Imports carry no extension. Specs live next to the code they test, files
  are organised in folders by role.
- A package's `README.md` is its npm page: by section, a copy-paste example
  each, and an **API** table of every export.
- A package's `docs/`, where it has one, is the long version, listed in
  `files` so it ships: `README.md` (an index of the pages), a guide,
  `troubleshooting.md` (one entry per error, headed by its exact message)
  and `roadmap.md`. The README ends with a **Documentation** section linking
  them by full GitHub URL on `develop`, since npm does not resolve relative
  links.

## Prior work

`softistx/nxgt-mail` writes and sends transactional e-mail (Maizzle
templates, `@nxgt/mail-smtp` over nodemailer); it is a client of an SMTP
server, not one, and shares no code with bumail. A bumail transport for it
would be an adapter in bumail, never a second implementation.
