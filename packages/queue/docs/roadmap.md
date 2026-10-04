# Roadmap

What `@bumail/queue` gives a mail server, and what is coming. This page is
a direction, not a commitment: the version something shipped in is the
only number on it.

## Now

Nothing in progress. The MongoDB store is merged (see Shipped), the last
of the stores for several machines that were planned; MTA-STS and
TLS-RPT come first under Next.

## Next

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
  the Redis store Bun's own `Bun.redis`, and the MongoDB store the
  application's own driver, typed by its shape — not even a peer.
- **Relaying on its own.** The queue sends what the app enqueues; who may
  send is decided before, by the SMTP server's AUTH or the app. No option
  will make the queue accept mail from the network.
- **DKIM signing in the queue.** A message is signed before it is
  enqueued, with `@bumail/auth`, so what is kept is exactly what leaves.

## Shipped

### Unreleased — merged, not yet published

- **A MongoDB store**, `@bumail/queue/mongo`, for instances of a server
  on several machines sharing one queue, on the MongoDB driver the
  application already has: `MongoQueueStore.open({ db })` takes a `Db`
  of the `mongodb` driver, 6 or later, typed by the methods it calls, so
  the package depends on no driver, not even as a peer. Every write that
  decides — claim, renew, complete, reschedule, cancel — is one
  `findOneAndUpdate` or `findOneAndDelete` on one item's document,
  filtered on its lease: two instances never take the same item, and a
  crashed instance's items are claimed again once their leases expire,
  in due order, then the oldest. Messages are kept byte for byte as BSON
  binary, in chunks, so one larger than a document's 16 MiB fits;
  `maxItems` holds through a unique index on places, with no
  transaction, so a standalone server works as well as a replica set.
  Every collection is written with `w: 'majority', j: true` and read
  with `readConcern: 'majority'` from the primary; the guide spells out
  what a failover can and cannot cost, and the roles a worker needs.
  Held to the same contract specs as the other stores, and to specs of
  two instances delivering every item exactly once.

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
