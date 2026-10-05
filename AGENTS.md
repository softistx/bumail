# AGENTS.md

Instructions for any coding agent working in `bumail`.

## What this repository is

A mail server native to Bun, published as `@bumail/*`. What is planned, in
what order and why, is in [docs/roadmap.md](./docs/roadmap.md); the table
below lists only what has landed.

| package | what it is | peers (besides the optional `typescript`) |
| --- | --- | --- |
| `@bumail/mime` | reading and writing messages: headers, addresses, dates, encoded-words, RFC 2231 parameters, multipart, transfer encodings, charsets, a streaming parser | — |
| `@bumail/dns` | the `Resolver` interface for MX, TXT, A, AAAA and PTR: on `node:dns`, a fixture for specs, a TTL cache; and `formatZone`, records as BIND zone-file lines | — |
| `@bumail/smtp` | an SMTP server on `Bun.listen`: STARTTLS, AUTH after TLS, policy hooks, never an open relay, the PROXY protocol from trusted proxies, a renewed certificate taken by `setTls` without a restart; and, as `@bumail/smtp/client`, a client that delivers to a host or by MX | — (MX delivery takes a resolver of `@bumail/dns`'s shape, typed structurally) |
| `@bumail/store` | the `MailStore` contract — accounts, mailboxes, messages, flags, UIDs, modseqs, changes — its memory store, its `bun:sqlite` store as `@bumail/store/sqlite`, and its PostgreSQL store on `Bun.sql` as `@bumail/store/postgres` | — |
| `@bumail/imap` | an IMAP4rev2 server (RFC 9051) on `Bun.listen` serving any `MailStore`: STARTTLS, LOGIN only after TLS, IDLE, MOVE, SPECIAL-USE, the PROXY protocol from trusted proxies, a renewed certificate taken by `setTls` without a restart | `@bumail/store`, `@bumail/mime` |
| `@bumail/queue` | the outbound queue: every recipient's state, delivery by domain through `@bumail/smtp/client` (MX, a smarthost, per domain), retries with back-off, DSNs (RFC 3464), the `QueueStore` contract with an atomic claim and leases, its memory store as `@bumail/queue/memory`, its `bun:sqlite` store as `@bumail/queue/sqlite`, its PostgreSQL store on `Bun.sql` as `@bumail/queue/postgres` and its Redis store on `Bun.redis` as `@bumail/queue/redis` | `@bumail/smtp`, `@bumail/mime` |
| `@bumail/auth` | DKIM signing and verifying (RFC 6376, RFC 8463) through Web Crypto, SPF checking (RFC 7208), DMARC (RFC 7489) on an embedded Public Suffix List snapshot, and the `Authentication-Results` header (RFC 8601), and writers for the SPF, DMARC and DKIM records, each the inverse of its parser | `@bumail/dns`, `@bumail/mime` |
| `@bumail/jmap` | a JMAP server (RFC 8620 core, RFC 8621 mail) as an alxia app to mount: the session, the API with back-references, Mailbox, Email and Thread, blob download and upload, serving any `MailStore`; Basic only over HTTPS; an OpenAPI 3.1 document of its routes, shipped as `@bumail/jmap/openapi.json` and kept in step with them by a spec | `@alxia/core` (from npm), `@bumail/store`, `@bumail/mime` |
| `@bumail/server` | the server app, **private** until it is complete (`"private": true`, so neither changesets nor `scripts/publish.ts` touch it): its TOML configuration read and checked whole by `readConfig`, the environment overriding URLs and secrets only, its directory of domains, users, aliases and DKIM keys (a `bun:sqlite` file in WAL mode, argon2id passwords, a capped verify, a per-client failure limiter, aliases to local users only), and the `bumail` command (`check-config`, `domain`, `user`, `alias`, `dkim`, `dns` — the MX, SPF, DKIM, DMARC and SRV records every hosted domain needs, as a zone file or JSON, and `--check` of them against the live DNS — and `serve`: MX on 25 with no AUTH, SPF, DKIM and DMARC, delivery into the store; submission on 465 and 587, AUTH only after TLS, a user sending as itself or its aliases, DKIM-signed; the outbound queue, by MX or a smarthost, DSNs to the local sender's mailbox; IMAP on 993, JMAP on 443 — HTTPS from files, or plain HTTP for trusted reverse proxies, the client from `X-Forwarded-For` only from them — a health check on loopback, the PROXY protocol on the mail ports from trusted proxies, a certificate from files, reloaded when the files change or on SIGHUP, or from an ACME CA — kept on the volume, obtained by HTTP-01 on port 80 before the TLS listeners start when none is stored, renewed by a timer and applied through that same reload — a clean stop on SIGTERM) | `@bumail/store`, `@bumail/smtp`, `@bumail/imap`, `@bumail/jmap`, `@bumail/queue`, `@bumail/auth`, `@bumail/dns`, `@bumail/acme`; it peers on each package it wires, as `workspace:^` (and `@alxia/core` from npm), from the slice that first imports it |
| `@bumail/acme` | an ACME client (RFC 8555) on `fetch` and Web Crypto: `AcmeClient` (directory, nonces with the `badNonce` retry, account, orders, authorizations, challenges, finalize, the PEM chain; `https:` only, answers bounded, numbers clamped), `obtainCertificate` for the whole HTTP-01 flow, `http01Responder` for `Bun.serve`; and its primitives: a PKCS #10 CSR for DNS names on its own DER writer, the flattened JWS (ES256, RS256), the JWK thumbprint, key authorizations, P-256 and RSA keys as PKCS #8 PEM | — |

Its skeleton is `softistx/alxia`'s, itself `softistx/nxgt-http`'s: the Bun
workspace, the root `build.ts`, Biome, changesets, `scripts/workspace.ts`,
`scripts/publish.ts` and `verify:artifacts`. A check added there is a check
to port here.

The repository is **public**, on GitHub as `softistx/bumail`: what is
committed — code, docs, issues and pull requests — anyone can read, so
none of it names a private application.

## Principles

- **No package has a dependency.** What one needs at runtime is a peer: a
  sibling `@bumail/*`, `@alxia/core` for what speaks HTTP, or — for a store
  answer only, as the roadmap plans — the published client it wraps
  (`@nxgt/s3`). Apart from those store answers, nothing peers outside
  `@bumail/*` and `@alxia/core`; every package also names `typescript` as
  an optional peer, for its types only. Any peer only once it is on npm:
  `verify:artifacts` refuses a required peer that is on no registry.
  `@alxia/core` is on npm since 0.1.0, and `@bumail/jmap` peers on it by a
  caret range from the registry — never a `link:` or a workspace path to
  alxia's checkout — and lists the same range as a devDependency. Bun's and the
  web platform's own APIs — `Bun.listen`, `socket.upgradeTLS`, `bun:sqlite`,
  `Bun.file`, `Bun.sql`, `Bun.redis`, Web Crypto, `TextDecoder`, `node:dns`
  — are not dependencies.
  `verify:artifacts` fails a manifest with a `dependencies` field that lists
  anything.
- **Data a package needs is a snapshot it embeds**, never fetched at
  runtime: `@bumail/auth`'s Public Suffix List is
  `src/dmarc/psl-data.ts`, written by `bun run scripts/refresh-psl.ts`
  (MPL 2.0, its notice kept in the file, its text shipped as
  `LICENSE-MPL-2.0`). A refresh is a patch changeset. A module that is
  only data is listed under `bumail.unmappedSources`, so the build leaves
  its content out of the source map and it ships once. `verify:artifacts`
  refuses a packed map that still embeds a listed module, or embeds any
  source over 32 KiB that is not listed, so dropping the entry fails it.
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
  `@bumail/acme`'s specs also have `openssl` read what it writes; they
  skip, saying so, without it on the PATH, except where
  `BUMAIL_TEST_OPENSSL_REQUIRED` is set, as in CI's "CI" job. Its
  client's specs run the whole flow against Pebble, Let's Encrypt's test
  CA, validating HTTP-01 for real, at `BUMAIL_TEST_PEBBLE_URL` under the
  CA file `BUMAIL_TEST_PEBBLE_CA` (`bun run pebble:test` starts it in
  Docker); skipped without, failed where `BUMAIL_TEST_PEBBLE_REQUIRED`
  is set, as in that job, which runs Pebble as a service.
  `@bumail/server`'s ACME specs (`src/serve/acme-pebble.spec.ts`) use the
  same container and variables, and serve its HTTP-01 on port 5002; its
  `src/serve/acme.fixtures.ts` repeats the few lines of `describePebble`.
  Pebble's certificates last 90 days or six, at its choice, so a spec
  never assumes one.
- **A store is a contract, with several answers.** What keeps state — the
  mailbox store, the outbound queue — defines its interface and ships a
  memory answer; `bun:sqlite` answers the same interface on disk. Whoever
  uses a store never knows which one it was given. The contract's specs are
  a `describe…` function in a `<subject>.fixtures.ts` beside the stores,
  run by each store's spec; `tsconfig.build.json` keeps fixtures out of
  `dist`. A store on a server database runs them against the server an
  environment variable names: `@bumail/queue/postgres` and
  `@bumail/store/postgres` the PostgreSQL of
  `BUMAIL_TEST_POSTGRES_URL` (`bun run postgres:test` starts one in
  Docker), `@bumail/queue/redis` the Redis of `BUMAIL_TEST_REDIS_URL`
  (`bun run redis:test`); CI's "CI" job runs both as services. They are
  skipped, saying so, without it, except where
  `BUMAIL_TEST_POSTGRES_REQUIRED` or `BUMAIL_TEST_REDIS_REQUIRED` is set,
  as in that job: there they fail. Both scripts start their container
  through `scripts/containers.ts`. Such a store also runs
  multi-instance specs: the queue's `src/queue/instances.fixtures.ts`,
  where two instances on two clients deliver every item exactly once,
  and the mail store's `src/postgres/instances.spec.ts`, where two
  instances appending, flagging and moving at once give each UID and
  modseq once, in order, and a third following the changes misses none.
  `@bumail/store/postgres` is also held to the memory store by
  `src/postgres/parity.spec.ts`: random histories, every answer
  compared. "Newest peers" runs none, on purpose.
- **A store on a server takes the application's client, typed by its
  shape**, or a URL for which it opens one of its own: `PostgresClient`
  for a `Bun.SQL`, `RedisQueueClient` for a `Bun.RedisClient`, so the
  shipped `.d.ts` names nothing of Bun's, and an `open.spec.ts` asserts
  Bun's client fits; `@bumail/store/postgres` takes the queue's
  `PostgresClient` shape, so one client serves both. It closes only a
  client it opened, checks every option at `open` and connects to
  nothing until the first call, and never repeats a URL in an error
  (`src/masked.ts`, in each package that has such a store, masks a
  password a client's reason repeats). Text PostgreSQL cannot keep as
  given — a NUL, a lone surrogate, which `Bun.sql` sends as U+FFFD —
  never reaches it: an id or a key holding one names nothing, a value to
  keep is `INVALID`. Every PostgreSQL transaction sets its isolation
  level first (writes and migrations `READ COMMITTED`), whatever the
  client's sessions default to, and two packages never share a
  `tablePrefix`: both have a `<prefix>messages`, and the store refuses a
  `<prefix>schema` it did not make. The Redis store is one Redis or a primary
  with replicas, never Cluster: its scripts reach keys they are not
  given, and its `keyPrefix` refuses `{`.
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
dns             (standalone)
mime            (standalone)
smtp            (standalone; its specs use store and dns, its Mailpit example auth, as devDependencies)
store           (standalone)
auth            → dns, mime
imap            → store, mime
queue           → smtp, mime (its specs use dns, as a devDependency)
acme            (standalone)
jmap            → store, mime, @alxia/core (from npm; its specs use jmap-jam and @alxia/openapi-routes as devDependencies)
server          → store, smtp, imap, jmap (with @alxia/core from npm), queue, auth, dns, acme, and each package it wires as a slice first imports it; a private app, never a peer of any package
```

`examples/demo` is an app, not a package: a private workspace that wires
every package into a runnable server, with its end-to-end script
(`bun run demo`, `bun run demo:e2e`; see its README). Nothing depends on
it; the build, `test`, `verify:artifacts` and publishing glob
`packages/*` only, and the changeset config's `privatePackages` keeps it
out of versioning. `typecheck` ends with `typecheck:demo`, so CI
typechecks the demo, in both jobs; its e2e is not run in CI, because it
needs Docker (for Mailpit).

What is planned is in [docs/roadmap.md](./docs/roadmap.md); as packages land,
this section draws their arrows. A package that uses a sibling declares it by
`workspace:^`, as a peer and a devDependency, and imports it by its
published name, which resolves through `node_modules` to the sibling's
`dist/`. A sibling only a spec uses is a devDependency alone, never a peer:
the package still needs nothing of it at runtime. **There are no cycles.**
A peer outside bumail (`@alxia/core`) is declared the same way, by its
npm range, as a peer and a devDependency: `verify:artifacts` checks it is
on the registry and installs it from there beside the tarballs, and the
"Newest peers" job leaves a range with one alternative as it is.

Three pieces are copied rather than shared, on purpose:

- **SASL PLAIN decoding** (RFC 4616), in `smtp/src/protocol/sasl.ts` and
  `imap/src/protocol/sasl.ts`: about forty lines, the same `Credentials`
  shape. A package for them would be a peer each server needs for one
  function; a fix to one is a fix to the other.
- **The socket transport**, in `smtp/src/server/transport.ts` and
  `imap/src/server/transport.ts`: its rule is under Deliberate
  duplications.
- **The PROXY protocol**, in `smtp/src/server/proxy/` and
  `imap/src/server/proxy/`, with each server's `src/server/admission.ts`:
  also under Deliberate duplications.

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
  `verify:artifacts` also refuses a built import of anything the manifest
  does not declare, in the `.js` and in the `.d.ts` (where a type-only
  import fails a consumer's `tsc`): the install holds every sibling side by
  side, so a sibling listed only as a devDependency would load there and
  fail for a consumer. That check (`scripts/artifacts/imports.ts`) is bumail's
  addition to the scripts copied from alxia and nxgt-http, worth porting
  back.
- **The lockfile's toolchain is the oldest end of each peer range.** CI's
  "Newest peers" job runs `scripts/newest-peers.ts` (from alxia), which
  pins the last alternative of each range — TypeScript 7 for
  `^6.0.3 || ^7.0.0` — then builds, typechecks, tests and verifies the
  artifacts. It resolves without a lockfile, so it is read, never required.
  The repository's scripts therefore stay off TypeScript's JS API, which
  TypeScript 7 does not export.
- **Bun 1.4.2**, the version alxia and the nxgt suite pin.

## TypeScript

`tsconfig.base.json` is strict past `strict`: `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`,
`noUnusedLocals` and the rest. An app's own tsconfig may hold any of them,
so the published declarations must compile under all of them. Only
`scripts/`, copied from nxgt-http, relaxes two.

## Releasing

Changesets, independent versions. A change under `packages/` needs one.

**Releasing works as in alxia.** `release.yml` runs on every push to
`develop`, with the softistx organisation's `NPM_TOKEN`: with changesets
pending, `changesets/action` opens a "Version packages" PR; with none, it
runs the publish script, which publishes every version the registry lacks —
a package's first included. So:

- merging to `develop` opens a "Version packages" PR; merging that publishes
  with `bun publish`, in dependency order. **Only the owner merges it**: an
  agent never merges, approves or edits a "Version packages" PR;
- **the first publish of any `@bumail/*` package needs the owner's explicit
  answer**, every time, and nothing is published without their OK;
- releases are batched: weekdays, at 18:00 Eastern or later.

Registry configuration lives in `bunfig.toml`, never in `.npmrc`; publishing
reads `$NPM_TOKEN`, which must be an npm **granular** access token: npm no
longer accepts a classic token for publishing, and says "two-factor
authentication is required".

Every package is **public on npm**, as the repository is, and MIT, with
its own copy of `LICENSE`. A package that embeds a file under another
license declares `MIT AND <SPDX id>` and ships that
license's text as `LICENSE-<id>`, which `verify:artifacts` checks:
`@bumail/auth` is `MIT AND MPL-2.0`, for its Public Suffix List. Its manifest sets
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

## Deliberate duplications

- **The trusted proxies and the address rules**, in `@bumail/smtp` and
  `@bumail/imap` (`src/server/proxy/address.ts`, `trusted.ts` and its
  spec, byte for byte the same) and in `@bumail/server` (`src/proxy/`,
  the same three files byte for byte): IP addresses and CIDRs, no
  zone, no prefix of 0, an IPv4-mapped address or peer matched as its
  IPv4 address, and never a match across families (an IPv6 network,
  however wide, trusts no IPv4 peer). Neither package exports them, and
  the server needs them for `jmap.trusted` and `proxyProtocol.trusted`
  alike: `check-config` runs `trustedPeers` on each entry, so whatever a
  listener would refuse at start is a line of it, and JMAP matches its
  peers with it. `src/proxy/canonical.ts` (the server's own) writes
  every client's address, for the limiter and the log, in RFC 5952's
  form with a mapped address as IPv4. A change to the rules is a change
  to all three copies.

- **The PostgreSQL plumbing**, in `@bumail/queue` and `@bumail/store`:
  `src/masked.ts` (and its spec) byte for byte — and in `@bumail/server`
  too, which masks a store URL's password in what the `bumail` command
  prints; `src/postgres/connect.ts`'s
  checks of `sql` (a client by its shape, its adapter, a URL opened
  with its password masked, the `tablePrefix` pattern), the
  `PostgresClient` and `PostgresQueryable` shapes in `options.ts`, the
  `migrate` of `schema.ts` (the fast path through `to_regclass` and the
  version, then one transaction under an advisory lock) and
  `describePostgres` in `databases.fixtures.ts`, each with its own
  package's error class and words; and `isStorable`, the queue's in
  `src/text.ts`, the store's in `src/postgres/storable.ts` (which takes
  `unknown` and narrows to a string, for ids from a caller). Two
  differences in `migrate`. First, only the store refuses, before its
  first migration, a foreign `<prefix>schema` or a table of its own name
  already there; the queue does not, which is why a table prefix is never
  shared between packages. Second, the store reads its fast-path version in a
  `REPEATABLE READ, READ ONLY` transaction, since every store call pins
  its level; the queue's reads it in two autocommit statements, which can
  stay, since a stale or torn answer there only sends it to the locked
  path, which reads the version again at `READ COMMITTED`. No package
  peers on another for a few dozen lines, and the two stores' tables
  differ. A fix to one is a fix to the other.

- **A little DER and PEM**, in `@bumail/acme` (`src/der/write.ts`,
  `pemBytes` in `src/encoding.ts`) and `@bumail/auth`
  (`src/dkim/der.ts`, `pemBody` in `src/dkim/private-key.ts`): a length,
  an element, a PEM body. Neither package peers on the other for a few
  lines; a fix to one is checked against the other.
- `packages/auth/src/dmarc/from-mailbox.ts` tokenizes a From value as
  `@bumail/mime`'s `headers/tokens.ts` does, but strictly: the mime
  parser is lenient by design (it leaves out what it cannot read), and
  for DMARC that leniency lets a reader and the check take different
  authors from one field. The two differ on purpose — anything left
  unterminated, a control character or a stray `)` is refused here — so
  a fix to the RFC 5322 grammar in one is checked against the other, not
  copied blindly.
- `packages/smtp/src/client/mx.ts` copies `@bumail/dns`'s `isTemporary`
  (and reads a `DnsError` by its `name` and `code`): the client imports
  nothing of `@bumail/dns`, so a smarthost-only app never installs it.
  Change both together.
- `packages/smtp/src/client/options.ts` declares `MxResolver` by shape —
  `mx`, `a` and `aaaa`, with the fields of `MxRecord` and `AddressRecord`
  the client reads — rather than importing `Resolver`: a type import in
  the built `.d.ts` fails a consumer's `tsc` (TS2307) when `@bumail/dns`
  is not installed. `options.spec.ts` asserts that `@bumail/dns`'s
  `Resolver` is assignable to it, so a change to either that breaks the
  fit fails `typecheck`. With nothing of `@bumail/dns` imported, smtp
  lists it as a devDependency only, never a peer (see Layering).
- **The socket transport** — writing with a backlog, `drained()`, pause and
  resume, the STARTTLS upgrade, the hang-up — in
  `smtp/src/server/transport.ts` and `imap/src/server/transport.ts`, each
  adapted to its protocol's flow (each queues through its own
  `src/io/outgoing.ts`; smtp writes text, imap writes bytes and exposes
  its `backlog`). Should a third server need
  it, it becomes a package. Both copies keep one rule, with the same names
  and shape:
  - **a hang-up never waits on the client.** A close the server decides on
    — a timeout, a 421 or a BYE — must complete even when the client never
    reads, or the connection keeps a `maxConnections` slot for good: the
    connection marks itself closed and queues its last words without
    awaiting the backlog;
  - **it half-closes with `socket.shutdown(true)`**, never Bun's `end()`,
    once what is queued has left — except on TLS when the hang-up waited
    for a queue to drain: there it calls a full `shutdown()`, which closes
    once the client, reading a moment ago, answers (`#hangUp(drained)`);
  - **a forced close terminates when bytes are queued**: `abort()` drops
    them and calls `terminate()`; with nothing queued it hangs up as
    `end()` does;
  - **every hang-up reads again first when reading is paused**: `#hangUp`
    calls `resume()` before its `shutdown`, for `end()` and `abort()`
    alike, whatever the reason (a timeout, a 421, a BYE, QUIT, LOGOUT);
    what the client sends from then on reaches a closed connection and is
    dropped;
  - **a paused hang-up lingers**: after that `resume()` it half-closes
    only once the client's input stopped for `LINGER_QUIET_MS` (20 ms);
    each server's `data` handler calls `transport.received()`, which puts
    the half-close back while it lingers. It lingers `LINGER_MAX_MS`
    (500 ms) at most: input not quiet for 20 ms by then is reset
    (`terminate()`), a client that stopped in the last 20 ms included,
    from the timer or from the first `received()` past that time. A second
    `end` or `abort` meanwhile does not shut down early;
  - **every end is bounded by the grace**: each `end`, queue empty or not,
    arms the 5-second `CLOSE_GRACE_MS`, whose timer terminates the socket
    unless `close` came first; a second `end` or `abort` keeps the first
    deadline;
  - **the `#closed` guard**: `closed()`, called from every `close` handler,
    clears that timer, drops the queue and sets `#closed`, so a later
    `write`, `end` or `abort` — as each `close` handler then runs
    `connection.close()` for a client that hung up first, or for
    `stop(true)` — touches no socket and arms no timer.

  Measured on Bun 1.4.2:

  - on TLS, `socket.end()` against a paused peer never closes, and a
    `terminate()` after it does nothing;
  - a full `shutdown()` holds a paused client's slot until the grace;
    the client then gets ECONNRESET and loses its last reply when it
    reads later;
  - `shutdown(true)` fires `close` at once, freeing the slot, and still
    delivers the last reply and a clean end;
  - but not while the server has paused reading a client that sent more
    than it could take. Over that unread input the half-close never fires
    `close`, and the slot waits for the grace (a client pipelining EHLOs
    it never reads, Linux and macOS alike). `resume()` then
    `shutdown(true)` fires `close` at once, on a clear socket and on TLS,
    and a client that stopped sending still gets the last reply and a
    clean end (80 runs in 80 on macOS, 300 KiB or 1 MiB left unread),
    where `terminate()` loses that reply to ECONNRESET. A client that
    keeps sending is reset either way;
  - on Linux (`oven/bun:1.4.2` in Docker, as CI's ubuntu runners), that
    `resume()` then `shutdown(true)` lost the reply every time, 10 runs in
    10: Bun closes the socket the moment it half-closes — its `end` and
    `close` handlers fire at once, before any FIN from the client — and
    Linux answers a close with input still unread (here about 800 KiB of
    1 MiB a `node:net` client had already handed the kernel) with a reset,
    so the client's `error` (EPIPE) came before the 421 and the 421 never
    reached it. macOS read everything left before the close, so it never
    showed. Lingering — reading and dropping until the input stopped for
    20 ms — then half-closing delivered the 421 and a clean end on Linux,
    and both close specs passed 20 runs in 20 on Linux and on macOS;
  - that linger was not bounded until it reset at `LINGER_MAX_MS`: each
    `received()` re-armed its timer, so a client that never paused kept
    it from firing, and a `shutdown(true)` that came late against a client
    still sending did not always fire `close` on Linux. A `node:net` client
    writing without pause, refilling on `drain`, held the slot past
    `LINGER_MAX_MS`: 5000 ms, the grace, on Linux, 1265 ms on macOS in
    the run measured there. Resetting it at
    `LINGER_MAX_MS` freed the slot 499 to 502 ms after the hang-up on
    Linux and 469 to 501 ms on macOS, and that client, reading, still had
    the 421 or the BYE: both close specs passed 20 runs in 20 on each;
  - a `node:tls` client that does read, pipelining about 1 MiB behind
    commands that fail into a close the server decides on while it paused
    reading — smtp's `maxErrors` (refusals from an `onRcptTo` that takes
    20 ms), imap's third failed LOGIN — got the 421 or the BYE and a clean
    end in 30 runs of 30 on each. Resetting there instead cost smtp's
    client the clean end every time, and imap's half-close waited for the
    grace and then its reset;
  - on TLS, `shutdown(true)` called in the `drain` that took the last of a
    large queue drops what Bun still holds in its own TLS buffer: 1 run in
    20 to 2 in 15, 16 to 96 KiB short, for a `node:tls` client reading
    slowly, in both copies. A full `shutdown()` there lost nothing in 15
    runs, and `write` gives no sign of that buffer;
  - a native `Bun.listen` TLS listener (implicit TLS used one before
    **TLS hot reload**; a socket upgraded in `open`, as it now does, has
    the `open` at the TCP connection from the start) calls `open` only
    once the handshake completed unless it has a `handshake` handler: without one, a socket
    that never sends its ClientHello reaches no `open`, so no limit counts
    it and no `socket.timeout` closes it (50 raw sockets held 12 s with a
    1 s timeout). With a handshake handler, `open` comes at the TCP
    connection and the socket timer runs during the handshake. imap's
    listener held the same way 50 raw sockets 12 s with a 1 s
    `loginTimeout`, a TLS client greeted past a `maxConnections` of 10.
    Each server sets one, counts the socket there, bounds the handshake by
    `handshakeTimeout` and holds its greeting, or its refusal, until the
    handshake completes; with it, imap's 50 were counted, then closed
    within 4 s of a 1 s `handshakeTimeout`. Each server's `stop(true)`
    also resets a socket still in its handshake, with no TLS to write a
    last reply on, though Bun's own `stop(true)` already closed it
    synchronously, before the server's loop reached it (measured in
    smtp, three pending handshakes);
  - Bun's `listener.stop(true)` no longer closes a socket STARTTLS moved
    to TLS, so each server's `stop(true)` also closes every connection it
    holds;
  - a reset reaches the client's kernel, not always the client: one sent
    into the window a client closed by not reading can be dropped (RFC
    5961), and the client then learns of it at its next probe of the
    server's zero window, the probes doubling from 200 ms. With the reset
    dropped on Linux, a client whose window had been closed 3.9 s at the
    hang-up saw the close 2.9 s after. smtp's `close.spec.ts` waited a
    flat 2 s for it and failed so on CI's ubuntu runners now and then,
    the slot already free; its `hungUp` waits the time the window has
    been closed, plus 200 ms and a second.

  smtp's real-socket specs: `quiet.spec.ts` (`node:net` and `node:tls`
  clients) covers a paused client on a clear socket, on implicit TLS and
  after STARTTLS, counted out within a bound at the idle `timeout` and then
  reading the 421 and a clean end, and a paused client after `QUIT`;
  `close.spec.ts` covers a client that never reads with replies queued,
  counted out as soon as the idle time is up, and a hang-up while the
  server paused reading, freed at once, a `node:net` client that stopped
  sending then reading the 421 and a clean end, one that reads and never
  stops sending reset at `LINGER_MAX_MS`, its socket closed within
  `LINGER_MAX_MS` plus 250 ms (750 ms) of the decision, having read
  the 421, and a `maxErrors` hang-up
  while paused on a real server, freed within 1 s of the decision with no
  RCPT the client kept pipelining behind it run;
  `server.spec.ts` covers `stop(true)` after STARTTLS. imap's:
  `server.spec.ts` covers a client that never reads with output queued, a
  slow reader of a large FETCH pipelined with LOGOUT, a paused client on a
  clear `node:net` socket, on implicit TLS and after STARTTLS, freed at
  `loginTimeout` before the grace and reading the BYE and a clean end once
  it resumes after the grace, and `stop(true)` after STARTTLS;
  `close.spec.ts` covers a client that sends four times `INPUT_LIMIT`
  behind a LOGIN whose `authenticate` never settles, so the server paused
  reading with nothing queued, on implicit TLS and after STARTTLS: freed
  within 1 s of the `loginTimeout` decision, then reading the BYE and a
  clean end, or, sending on, freed as fast with no LOGIN sent after the
  first reaching `authenticate`, or reading and never pausing its sending,
  freed as fast once reset at `LINGER_MAX_MS`, having read the BYE;
  `transport.spec.ts` covers a slow TLS reader of 8 MiB queued at `end()`.
  smtp's `handshake.spec.ts` and imap's `handshake.spec.ts` cover raw
  sockets on implicit TLS that never send a ClientHello: counted by
  `maxConnections` (and smtp's `maxConnectionsPerClient`) and freed on
  closing, closed at `handshakeTimeout`, a garbage handshake counted out
  at once, and `stop(true)` with handshakes pending, which writes them
  nothing and calls no `onError`; imap's also that `loginTimeout` counts
  from the greeting, the ClientHello sent after a wait longer than it.
  Both `close.spec.ts` also time the server's own `close` from its
  decision: within 100 ms for a reset with replies queued (smtp), from
  a millisecond under `LINGER_QUIET_MS` (19 ms, for the timer's rounding)
  to before `LINGER_MAX_MS` for a linger over a client gone quiet, and
  from those same 19 ms to within `LINGER_MAX_MS` plus 250 ms over one
  still sending, which under load may pause long enough to half-close early
  (measured 30 runs each on macOS and Linux beside busy cores: at most
  12 ms, 37.5 ms, and 28 ms past `LINGER_MAX_MS`).
  The idle `timeout` (30 minutes at least) runs the same close but no imap
  real-socket spec waits for it. Each copy's `transport.spec.ts` checks,
  on a fake socket, that `shutdown` gets `true` (and nothing on TLS after
  a drain), that a paused hang-up calls `resume` first and lingers while
  `received()` comes, and resets at `LINGER_MAX_MS` input not yet quiet for 20 ms,
  even when no timer can fire between its chunks, the grace and the
  `#closed` guard. A fix to one copy is a fix
  to the other.

- **The PROXY protocol** (HAProxy's proxy-protocol.txt, versions 1 and
  2) — `src/server/proxy/` in `@bumail/smtp` and `@bumail/imap`, byte for
  byte: `address.ts` (addresses as bytes, RFC 5952's text, IPv4-mapped as
  IPv4), `header.ts` (the parser: a v1 line of 107 bytes at most, v2 TLVs
  of `MAX_TLV_BYTES`, 2048, at most, skipped and never read), `reader.ts`
  (the header from a trusted peer within `handshakeTimeout`, a timer from
  the TCP connection that input does not extend), `trusted.ts` (the
  `trusted` list), `tls.ts` (`ProxiedTls`), their specs and
  `headers.fixtures.ts`; `src/server/tls-context.ts`, which reads and
  checks `tls` at `listen()` on implicit TLS, with a proxy or without, so
  a key it cannot use fails alike (each server's `listen.spec.ts`, with
  two `listen()` at once), and holds the pair in use (`TlsHolder`) that
  `setTls` replaces, see **TLS hot reload**; and `src/server/front.fixtures.ts`, a proxy for
  specs. `src/server/admission.ts` (the listener's `open`, `handshake`
  and `close`) and `src/server/raw-socket.ts` are adapted to each
  server: smtp counts each client by `clientKey` and turns one away with
  a reply, imap with a BYE. Should a third server need it, it becomes a
  package. The rules both keep:
  - **off by default, and only from `trusted`**: a peer not listed is
    served as without the option, and a header it sends is bad input
    that never sets an address;
  - **a trusted peer sends a valid header first**, or it is reset —
    nothing written, nothing reported, no limit counting the proxy's own
    address. It holds no slot until the header named its client; then
    it is counted, by that address, as any client is;
  - **v2 `PROXY` over TCP on IPv4 or IPv6 names the client**; `LOCAL`,
    `UNSPEC`, UNIX, datagrams and v1 `UNKNOWN` keep the peer;
  - **implicit TLS behind the header runs on `node:tls`**: with
    `proxyProtocol`, an `implicitTls` server listens in clear, and every
    socket's TLS — after the header from a trusted peer, from the first
    byte from any other — is `ProxiedTls`, a `node:tls` server socket over
    a `Duplex` it feeds from the raw socket. It has the shape of the Bun
    socket a `SocketTransport` drives (`RawSocket`), so the transport's
    rules above hold over it unchanged: `write` takes nothing while TLS
    holds past its high-water mark, and the `Duplex` waits for the raw
    socket's `drain`;
  - **`ProxiedTls` ends its `Duplex` on the TLS socket's `finish`**:
    `tls.end()` sends the close_notify and fires `finish`, but `node:tls`
    never ends the stream under it before the client answers, so without
    that a client that stopped reading held its slot of `maxConnections`
    for good (measured: a paused client after QUIT, and one paused at the
    idle timeout, both still counted after 2 s and 7 s);
  - **`trusted` refuses what would trust the wrong peer**: an address
    with a zone (`fe80::1%eth0`, which names an interface of this host)
    and a prefix of 0 (`0.0.0.0/0`, `::/0`, `::ffff:0.0.0.0/96`), which
    would trust every peer.

  Measured on Bun 1.4.2: `socket.upgradeTLS` on a clear socket reads
  only what arrives after it is called, and Bun gives a socket's bytes
  to `data` with no way to put any back. A proxy that sends the header
  and the client's ClientHello in one segment, as one that waits for the
  client's first bytes does, leaves the ClientHello in the chunk the
  header came in, and the handshake never completes; sent apart, it
  completes. A `node:tls` `TLSSocket` with `isServer` over a `Duplex`
  completes it either way. STARTTLS keeps `upgradeTLS`: its client waits
  for the reply before its ClientHello. Each server's `proxy.spec.ts`
  covers the clear and STARTTLS ports — v1 and v2, `LOCAL`, `UNSPEC`,
  garbage, a long v1 line, oversized TLVs, a truncated header and a
  slowloris closed at `handshakeTimeout`, `stop(true)` with headers
  pending, the limits keyed on the client — `proxy-tls.spec.ts` implicit
  TLS behind the header, the ClientHello in the header's segment and
  apart, through `front.fixtures.ts` (smtp: 1 MiB of DATA then QUIT;
  imap: a slow reader of a 4 MiB FETCH), and a peer not trusted — and
  `proxy-quiet.spec.ts` the clients that stop reading through
  `ProxiedTls`, as smtp's `quiet.spec.ts` does (smtp: at the idle
  timeout, and after QUIT; imap: at `loginTimeout`, and after LOGOUT):
  freed within the bound, then reading the last reply and a clean end.
  Each server's `listen.spec.ts` covers two `listen()` at once, a `stop()`
  before `listen()` resolved (clear and implicit TLS, with a proxy or
  without), and a key or certificate that cannot be used. A fix to one
  copy is a fix to the other.

- **TLS hot reload** — `setTls({ key, cert })` on `@bumail/smtp`'s and
  `@bumail/imap`'s server, and `src/server/tls-context.ts` in both, byte
  for byte (`readTls`, which reads a pair whole, `Bun.file` included, and
  makes a `node:tls` context of it, and `TlsHolder`, which holds the pair
  in use and replaces it only once the new one checked); each server's
  `admission.ts` (`upgradingHandlers`), `reload.spec.ts` and
  `reload.fixtures.ts`, and the `renewed.crt` and `renewed.key` of each
  `fixtures/`. The rules both keep:
  - **a pair that cannot be used leaves the old one** and rejects with
    `INVALID_OPTION` (`setTls(): tls: { key, cert } cannot be used: …`);
  - **new connections only**: a STARTTLS upgrade reads the holder's
    options, an implicit TLS socket is upgraded in `open` from them, and
    `ProxiedTls` is given the holder's context; a session already
    encrypted keeps its TLS;
  - **implicit TLS without a proxy listens in clear** and upgrades each
    socket in `open` with `socket.upgradeTLS`, the STARTTLS mechanism
    from the first byte; the clear socket's own handlers drop its data,
    which is the TLS records the encrypted socket reads.

  Measured on Bun 1.4.2, macOS and Linux (`oven/bun:1.4.2`) alike:

  - `Bun.listen`'s `listener.reload()` takes `{ socket }` handlers only
    (its type says so); given a `tls`, it does nothing: a new connection
    was still served the first certificate. `Bun.serve`'s `server.reload`
    ignores a `tls` the same way;
  - `socket.upgradeTLS`'s `tls` is read per call: swapping the options
    served the new certificate to the next connection, 10 of 10 on a
    clear listener that upgrades in `open`, with no ClientHello lost (the
    upgrade comes before the first read), and the whole existing suites
    for implicit TLS — handshake, quiet, close, proxy — passed on it;
  - `Bun.listen` and `Bun.serve` take `reusePort`: a second listener binds
    the same port beside the first when both set it, and without it the
    bind fails (`Failed to listen`). A swap by it — bind the new, stop the
    old — lost 1 handshake in 2 749 (macOS) and 0 to 1 in 3 300 to 3 500
    (Linux, 5 runs) of new connections hammering the port through the
    swap: the connection the old listener had accepted and not read. The
    old server finishes the requests it has, a request under way
    included. It is used for JMAP's HTTPS alone (`httpListener`'s
    `setTls`), since `Bun.serve` offers nothing else, and never for the mail
    ports, where upgrading in `open` has no such loss. **It is a
    security consideration**: the port stays opened shareable for the
    process's life, so another process of the same user can bind it and
    take connections. `jmap.reloadTls = false` (default `true`) binds
    JMAP alone and leaves the certificate to the next start, said in the
    log line; in a container, whose network namespace is its own, the
    default is safe; on a shared host, set it false. `jmap.mode =
    "proxy"` is plain HTTP, has no TLS to swap and never sets
    `reusePort`;
  - the cost of upgrading in `open`: the clear socket's `data` handler
    still gets every TLS record, and drops it; and the handshakes are
    slower, about 30% on 1 000 concurrent ones, probably the context built
    from the PEM for each connection (a rerun here, on a busy machine,
    was too noisy to confirm the figure). `upgradeTLS` takes no prebuilt
    context: given `node:tls`'s `SecureContext` it throws `The
    "secureContext" argument must be of type SecureContext`;
  - `setTls` calls run in the order made (`TlsHolder` chains them), so
    the later call wins however slowly the earlier reads; an empty key
    or certificate is refused like any pair that cannot be used.

  `@bumail/server` (`src/serve/reload.ts`) is the caller: it reads
  `tls.cert` and `tls.key` as `check-config` does (`checkTlsPair`), every
  `tls.pollSeconds` and on SIGHUP, and compares **text**, not mtime and
  size, which a bind mount or a symlink swap leaves unchanged or moves
  without a change; a valid pair goes to every listener's `setTls`, those
  that took it going back to the old pair should one refuse; one line a
  change, never a poll. A fix to one copy of `tls-context.ts` is a fix to
  the other.

## Prior work

`softistx/nxgt-mail` writes and sends transactional e-mail (Maizzle
templates, `@nxgt/mail-smtp` over nodemailer); it is a client of an SMTP
server, not one, and shares no code with bumail. A bumail transport for it
would be an adapter in bumail, never a second implementation.
