# Roadmap

What `@bumail/queue` gives a mail server, and what is coming. This page is
a direction, not a commitment: the version something shipped in is the
only number on it.

## Now

Nothing in progress: the MongoDB store, first under Next, is the next
one taken. The Redis store is merged (see Shipped).

## Next

More answers to the `QueueStore` contract, built for several instances of
a server sharing one queue — each claim atomic across them, each lease
taken back from an instance that crashed — and each held to the same
contract specs as the memory, `bun:sqlite`, PostgreSQL and Redis
stores. None adds a dependency.

- **A MongoDB store** — the contract answered structurally, against a
  collection of the shape a MongoDB driver gives, so the package peers on
  no driver: the application passes in its own collection; the claim a
  `findOneAndUpdate`.

Then:

- **MTA-STS (RFC 8461) and TLS-RPT (RFC 8460)** — a recipient domain's
  policy fetched, cached and enforced, `mxTls: 'required'` with the
  certificate checked against the policy's MX names, and the reports.
- **DANE (RFC 7672)** — TLSA records checked for MX hosts, once a
  resolver that validates DNSSEC can be given to the queue.
- **One session for several messages** — the queue hands several items
  for one domain to one SMTP session, once `@bumail/smtp`'s client reuses
  connections.
- **The contract's specs, exported**, so a store written outside this
  package can hold itself to them.
- **A DSN that cannot be lost on a crash** — today a crash between
  recording a failure and enqueuing its DSN loses that DSN; the store
  will take both in one step.

## Later

- **REQUIRETLS (RFC 8689)** — a message that asks for TLS all the way is
  never sent in clear, and fails rather than downgrade.
- **DSN requests (RFC 3461)** — `NOTIFY`, `RET` and `ENVID` given at
  enqueue and passed on, with a "delivered" DSN when asked for.
- **Retries per recipient** — a schedule of its own for each recipient,
  rather than one per message.
- **A history** — delivered and failed items kept for a while, for an
  admin to look up, rather than dropped once done.

## Not planned

- **A runtime dependency.** The memory store needs none, the `bun:sqlite`
  store uses Bun's own SQLite, the PostgreSQL store Bun's own `Bun.sql`,
  the Redis store Bun's own `Bun.redis`, and the MongoDB store will take
  the application's own collection, typed by its shape.
- **Relaying on its own.** The queue sends what the app enqueues; who may
  send is decided before, by the SMTP server's AUTH or the app. No option
  will make the queue accept mail from the network.
- **DKIM signing in the queue.** A message is signed before it is
  enqueued, with `@bumail/auth`, so what is kept is exactly what leaves.

## Shipped

### Unreleased — merged, not yet published

- **The PostgreSQL store's writes run at `READ COMMITTED`** — whatever
  the client's sessions default to, so a client shared with code that
  defaults to `repeatable read` or `serializable` serves the queue:
  concurrent claims, outcomes, adds with `maxItems` and migrations no
  longer fail with SQLSTATE 40001, and `maxItems` holds under them.
- **A message the store lost no longer loops** — an item whose message
  is gone (a Redis key evicted or deleted, a row removed by hand) fails
  its pending recipients at once as `5.3.0`, `Message unreadable`, says
  so on the `error` event (`MESSAGE_UNREADABLE`), sends its failure DSN
  without the original and leaves the queue, rather than be claimed
  again at every lease, forever, holding its `maxItems` place.
- **A set-up error never shows the password** — `The PostgreSQL queue
  cannot be set up` and `The Redis queue cannot be set up` mask it
  should the database's reason repeat it; and a password under 4
  characters is masked only where a URL holds it, so the rest of the
  reason stays readable.

### 0.3.0

- **A Redis store**, `@bumail/queue/redis`, on Bun's own `Bun.redis`,
  for instances of a server on several machines sharing one queue:
  `RedisQueueStore.open({ client })` takes a `Bun.RedisClient`, or
  `{ url }` a `redis://` URL, and needs no driver. Every operation that
  writes is one Lua script, which Redis runs whole: two instances never
  take the same item, a crashed instance's leases expire and its items
  are claimed again, and `maxItems` holds across instances. The due
  items are in sorted sets, each item a hash, its message written byte
  for byte, every key under a `keyPrefix`. Held to the same contract
  specs as the other stores, and to specs of two instances delivering
  every item exactly once. One Redis, or a primary with replicas, not
  Cluster; its durability is Redis's, which the guide spells out.
- **A lease lost to an instance that finished the item is reported** —
  an instance that stalled past its lease, while another claimed the
  item, delivered it and dropped it, no longer takes the item's absence
  for a cancel: it reports `LEASE_LOST` on the `error` event, tells no
  outcome and sends no DSN, so the operator learns the message may have
  gone out twice. With no record of who dropped an item, a lease that
  expired, or a renewal refused while the item was still there, is
  reported as lost or cancelled; a cancel under a lease that
  still held is told as before, and no longer draws a `LEASE_LOST` from
  a renewal that finds the item gone.

### 0.2.0

- **A PostgreSQL store**, `@bumail/queue/postgres`, on Bun's own
  `Bun.sql`, for instances of a server on several machines sharing one
  queue: `PostgresQueueStore.open({ sql })` takes a `Bun.SQL` client or a
  `postgres://` URL, and needs no driver. A claim is one `UPDATE …
  RETURNING` whose item a `SELECT … FOR UPDATE SKIP LOCKED` picks, so two
  instances never take the same item; a crashed instance's leases expire
  and its items are claimed again. The tables — the `bun:sqlite` store's,
  the message as `bytea` — are made by `migrate()` or the first call,
  once however many instances start together, under a `tablePrefix`.
  Held to the same contract specs as the other stores, and to specs of
  two instances delivering every item exactly once. Once the tables are
  current, a worker's role needs no `CREATE`.
- **A reply cut at its limit never splits a character** — the text kept
  for a recipient ends before a surrogate pair rather than inside it, and
  every store refuses a NUL or a lone surrogate in what it keeps, so an
  outcome is always recorded.

### 0.1.0

- **The first slice** — `createQueue`: every recipient's own state,
  delivery by domain through `@bumail/smtp/client` (direct MX, a
  smarthost, or a route per domain), a global and a per-domain
  concurrency limit, retries with exponential back-off and jitter on RFC
  5321 §4.5.4.1's schedule, a 5xx failed at once, DSNs (RFC 3464) for a
  failure and a delay, never about a message from `<>`; the `QueueStore`
  contract with an atomic claim and leases for several workers, its
  memory store and its `bun:sqlite` store, held to one spec suite;
  events, `list`, `retryNow` and `cancel`; an injectable clock and sender.
  The package's first release.
