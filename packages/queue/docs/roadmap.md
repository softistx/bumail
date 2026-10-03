# Roadmap

What `@bumail/queue` gives a mail server, and what is coming. This page is
a direction, not a commitment: the version something shipped in is the
only number on it.

## Now

- **The first slice, in review** — `createQueue`: every recipient's own
  state, delivery by domain through `@bumail/smtp/client` (direct MX, a
  smarthost, or a route per domain), a global and a per-domain
  concurrency limit, retries with exponential back-off and jitter on RFC
  5321 §4.5.4.1's schedule, a 5xx failed at once, DSNs (RFC 3464) for a
  failure and a delay, never about a message from `<>`; the `QueueStore`
  contract with an atomic claim and leases for several workers, its
  memory store and its `bun:sqlite` store, held to one spec suite;
  events, `list`, `retryNow` and `cancel`; an injectable clock and sender.

## Next

- **A PostgreSQL store**, on `Bun.sql` — the same contract for workers on
  several machines, the claim a `SELECT … FOR UPDATE SKIP LOCKED`. It
  runs the same contract specs.
- **A Redis store**, on `Bun.redis` — the due items in a sorted set, the
  claim and the lease in one script.
- **A MongoDB store** — the contract answered structurally, by a
  collection of the shape a MongoDB driver gives, so the package peers on
  no driver; the claim a `findOneAndUpdate`.
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
  store uses Bun's own SQLite, and the stores to come use Bun's own
  `Bun.sql` and `Bun.redis`.
- **Relaying on its own.** The queue sends what the app enqueues; who may
  send is decided before, by the SMTP server's AUTH or the app. No option
  will make the queue accept mail from the network.
- **DKIM signing in the queue.** A message is signed before it is
  enqueued, with `@bumail/auth`, so what is kept is exactly what leaves.

## Shipped

Nothing yet: the first slice is in review (see Now).
