# Troubleshooting

Each entry is headed by the message of the `QueueError` thrown, or given
to the `error` event; its `code` is the group it is listed under. The
parts shown as … vary.

**Enqueuing** (`enqueue`)

- [`QueueError: The message is larger than the limit of … bytes`](#queueerror-the-message-is-larger-than-the-limit-of--bytes)
- [`QueueError: The message has … recipients; the limit is …`](#queueerror-the-message-has--recipients-the-limit-is-)
- [`QueueError: The queue holds … items, its limit`](#queueerror-the-queue-holds--items-its-limit)
- [`QueueError: … must be an address, local@domain, not "…"`](#queueerror--must-be-an-address-localdomain-not-)
- [`QueueError: to must hold one recipient or more`](#queueerror-to-must-hold-one-recipient-or-more)
- [`QueueError: The envelope is an object: { from, to }`](#queueerror-the-envelope-is-an-object--from-to-)
- [`QueueError: The message is a Uint8Array, a string or a ReadableStream<Uint8Array>`](#queueerror-the-message-is-a-uint8array-a-string-or-a-readablestreamuint8array)
- [`QueueError: The message stream must give Uint8Array chunks`](#queueerror-the-message-stream-must-give-uint8array-chunks)
- [`QueueError: The message has a bare CR or LF at byte …: every line must end in CRLF`](#queueerror-the-message-has-a-bare-cr-or-lf-at-byte--every-line-must-end-in-crlf)

**Creating the queue** (`createQueue`)

- [`QueueError: The 'mx' route needs a resolver, such as @bumail/dns's nodeResolver()`](#queueerror-the-mx-route-needs-a-resolver-such-as-bumaildnss-noderesolver)
- [`QueueError: hostname must be this server's public host name, not …`](#queueerror-hostname-must-be-this-servers-public-host-name-not-)
- [`QueueError: route must be 'mx' or a smarthost with a host`](#queueerror-route-must-be-mx-or-a-smarthost-with-a-host)
- [`QueueError: route.auth needs tls: 'required', the default with auth: with tls: '…' the password would go to a server whose certificate is not checked`](#queueerror-routeauth-needs-tls-required-the-default-with-auth-with-tls--the-password-would-go-to-a-server-whose-certificate-is-not-checked)
- [`QueueError: route.auth.username must be a non-empty string`, and the other smarthost options](#queueerror-routeauthusername-must-be-a-non-empty-string-and-the-other-smarthost-options)
- [`QueueError: timeouts.… must be a number of seconds above 0 and at most 2147483, not …`](#queueerror-timeouts-must-be-a-number-of-seconds-above-0-and-at-most-2147483-not-)
- [`QueueError: store must be a QueueStore, such as MemoryQueueStore`](#queueerror-store-must-be-a-queuestore-such-as-memoryqueuestore)
- [`QueueError: … must be an integer of at least …, not …`](#queueerror--must-be-an-integer-of-at-least--not-)
- [`QueueError: dsn.returnContent must be 'headers' or 'full', not …`](#queueerror-dsnreturncontent-must-be-headers-or-full-not-)
- [`QueueError: createQueue() takes an options object`](#queueerror-createqueue-takes-an-options-object)
- [`QueueError: owner must be a non-empty string`](#queueerror-owner-must-be-a-non-empty-string)

**The `error` event**

- [`QueueError: The lease on … was lost before its outcome was recorded; another worker will try it again`](#queueerror-the-lease-on--was-lost-before-its-outcome-was-recorded-another-worker-will-try-it-again)
- [`QueueError: The lease on … was lost while it was delivered`](#queueerror-the-lease-on--was-lost-while-it-was-delivered)
- [`QueueError: The lease on … expired before its outcome was recorded, and the item is gone: lost to another worker that finished it, the message then sent twice, or cancelled`](#queueerror-the-lease-on--expired-before-its-outcome-was-recorded-and-the-item-is-gone-lost-to-another-worker-that-finished-it-the-message-then-sent-twice-or-cancelled)
- [`QueueError: The lease on … was lost while it was delivered, and the item is gone: finished by the worker that took it, the message then sent twice, or cancelled`](#queueerror-the-lease-on--was-lost-while-it-was-delivered-and-the-item-is-gone-finished-by-the-worker-that-took-it-the-message-then-sent-twice-or-cancelled)
- [`SmtpError: sendMail(): …` (`INVALID_OPTION`), with recipients deferred as `4.3.5`](#smtperror-sendmail--invalid_option-with-recipients-deferred-as-435)
- [`SQLiteError: database is locked`, or another store error, during a delivery](#sqliteerror-database-is-locked-or-another-store-error-during-a-delivery)
- [`PostgresError: …`, or a connection error, during a delivery](#postgreserror--or-a-connection-error-during-a-delivery)
- [`RedisError: …` during a delivery: `Connection closed`, `OOM command not allowed …`, `READONLY …`](#rediserror--during-a-delivery-connection-closed-oom-command-not-allowed--readonly-)
- [`MongoServerSelectionError: …`, `MongoNotConnectedError: …` or another driver error during a delivery](#mongoserverselectionerror--mongonotconnectederror--or-another-driver-error-during-a-delivery)

**The `bun:sqlite` store** (`@bumail/queue/sqlite`)

- [`QueueError: A SQLite queue store needs a directory`](#queueerror-a-sqlite-queue-store-needs-a-directory)
- [`QueueError: The queue at "…" cannot be opened: …`](#queueerror-the-queue-at--cannot-be-opened-)
- [`QueueError: The database is at schema version …, newer than this store's …`](#queueerror-the-database-is-at-schema-version--newer-than-this-stores-)
- [`QueueError: busyTimeout must be an integer of at least 0, not …`](#queueerror-busytimeout-must-be-an-integer-of-at-least-0-not-)
- [`QueueError: The queue store is closed`](#queueerror-the-queue-store-is-closed)

**The PostgreSQL store** (`@bumail/queue/postgres`)

- [`QueueError: A PostgreSQL queue store needs sql: a Bun.SQL client or a postgres:// URL`](#queueerror-a-postgresql-queue-store-needs-sql-a-bunsql-client-or-a-postgres-url)
- [`QueueError: sql is a … client; the queue needs a PostgreSQL one`](#queueerror-sql-is-a--client-the-queue-needs-a-postgresql-one)
- [`QueueError: tablePrefix must be lowercase letters, digits and underscores, starting with a letter or an underscore, at most 40 characters, not …`](#queueerror-tableprefix-must-be-lowercase-letters-digits-and-underscores-starting-with-a-letter-or-an-underscore-at-most-40-characters-not-)
- [`QueueError: The URL in sql cannot be opened: …`](#queueerror-the-url-in-sql-cannot-be-opened-)
- [`QueueError: The PostgreSQL queue cannot be set up: …`](#queueerror-the-postgresql-queue-cannot-be-set-up-)
- [`QueueError: The database is at schema version …, newer than this store's …`](#queueerror-the-database-is-at-schema-version--newer-than-this-stores-), and [`QueueError: The queue store is closed`](#queueerror-the-queue-store-is-closed), as for `bun:sqlite`

**The Redis store** (`@bumail/queue/redis`)

- [`QueueError: A Redis queue store needs client, a Bun.RedisClient, or url, a redis:// URL`](#queueerror-a-redis-queue-store-needs-client-a-bunredisclient-or-url-a-redis-url)
- [`QueueError: A Redis queue store takes client or url, not both`](#queueerror-a-redis-queue-store-takes-client-or-url-not-both)
- [`QueueError: keyPrefix must be lowercase letters, digits, '_', ':', '.' and '-', starting with a letter, at most 40 characters, not …`](#queueerror-keyprefix-must-be-lowercase-letters-digits-_---and---starting-with-a-letter-at-most-40-characters-not-)
- [`QueueError: The URL in url cannot be opened: …`](#queueerror-the-url-in-url-cannot-be-opened-)
- [`QueueError: The Redis queue cannot be set up: …`](#queueerror-the-redis-queue-cannot-be-set-up-)
- [`QueueError: The key …schema does not hold a layout version: is the prefix another application's?`](#queueerror-the-key-schema-does-not-hold-a-layout-version-is-the-prefix-another-applications)
- [`QueueError: The database is at schema version …, newer than this store's …`](#queueerror-the-database-is-at-schema-version--newer-than-this-stores-), and [`QueueError: The queue store is closed`](#queueerror-the-queue-store-is-closed), as for `bun:sqlite`

**The MongoDB store** (`@bumail/queue/mongo`)

- [`QueueError: A MongoDB queue store needs db: a Db of the mongodb driver, or an object of its shape`](#queueerror-a-mongodb-queue-store-needs-db-a-db-of-the-mongodb-driver-or-an-object-of-its-shape)
- [`QueueError: A MongoDB queue store takes db, not url: give it client.db() of a MongoClient of yours`](#queueerror-a-mongodb-queue-store-takes-db-not-url-give-it-clientdb-of-a-mongoclient-of-yours)
- [`QueueError: collectionPrefix must be lowercase letters, digits and underscores, starting with a letter or an underscore, at most 40 characters, not …`](#queueerror-collectionprefix-must-be-lowercase-letters-digits-and-underscores-starting-with-a-letter-or-an-underscore-at-most-40-characters-not-)
- [`QueueError: db cannot give the queue's collections: …`](#queueerror-db-cannot-give-the-queues-collections-)
- [`QueueError: The MongoDB queue cannot be set up: …`](#queueerror-the-mongodb-queue-cannot-be-set-up-)
- [`QueueError: The collection …schema does not hold a layout version: is the prefix another application's?`](#queueerror-the-collection-schema-does-not-hold-a-layout-version-is-the-prefix-another-applications)
- [`QueueError: The collection …schema holds a sequence that is not a number`](#queueerror-the-collection-schema-holds-a-sequence-that-is-not-a-number)
- [`QueueError: The database is at schema version …, newer than this store's …`](#queueerror-the-database-is-at-schema-version--newer-than-this-stores-), and [`QueueError: The queue store is closed`](#queueerror-the-queue-store-is-closed), as for `bun:sqlite`

**Listing** (`list`)

- [`QueueError: limit must be an integer from 1 to 1000, not …`](#queueerror-limit-must-be-an-integer-from-1-to-1000-not-)
- [`QueueError: offset must be an integer of at least 0, not …`](#queueerror-offset-must-be-an-integer-of-at-least-0-not-)

**A store's own checks** (a store of your own, called directly)

- [`QueueError: … must be a finite number`, `owner must be a non-empty string`, and the others](#a-stores-own-checks)
- [`QueueError: A reply is an object with a text`](#queueerror-a-reply-is-an-object-with-a-text)
- [`QueueError: reply.status must be a string`](#queueerror-replystatus-must-be-a-string)
- [`QueueError: reply.host must be a string`](#queueerror-replyhost-must-be-a-string)
- [`QueueError: … holds a NUL or a lone surrogate, which a store cannot keep`](#queueerror--holds-a-nul-or-a-lone-surrogate-which-a-store-cannot-keep)

**Delivery**

- [A recipient stays `deferred` with `4.4.1` or `4.4.2`](#a-recipient-stays-deferred-with-441-or-442)
- [Every delivery fails at once with `5.7.1`, or with a reply naming your IP or EHLO name](#every-delivery-fails-at-once-with-571-or-with-a-reply-naming-your-ip-or-ehlo-name)
- [A recipient fails with `5.1.3`, `The address is not one SMTP can carry`](#a-recipient-fails-with-513-the-address-is-not-one-smtp-can-carry)
- [Every recipient fails with `5.1.7`, `The sender's address is not one SMTP can carry`](#every-recipient-fails-with-517-the-senders-address-is-not-one-smtp-can-carry)
- [`retryNow` returns `false` for an item that is in the queue](#retrynow-returns-false-for-an-item-that-is-in-the-queue)

## Enqueuing

### `QueueError: The message is larger than the limit of … bytes`

**Code:** `MESSAGE_TOO_BIG`.
**When:** `enqueue`, with a message past `limits.maxMessageSize` (25 MiB
by default). A stream is read only up to that bound, then cancelled.
**Fix:** refuse the message earlier — an SMTP server's `maxMessageSize`
at or below the queue's — or raise the limit:

```ts
createQueue({ store, hostname, resolver, limits: { maxMessageSize: 50 * 1024 * 1024 } });
```

### `QueueError: The message has … recipients; the limit is …`

**Code:** `TOO_MANY_RECIPIENTS`.
**When:** `enqueue`, with more distinct recipients than
`limits.maxRecipients` (100, RFC 5321 §4.5.3.1.8's least).
**Fix:** enqueue the message in several batches, or raise the limit.

### `QueueError: The queue holds … items, its limit`

**Code:** `QUEUE_FULL`.
**When:** `enqueue`, with `limits.maxItems` set and the store holding
that many items. DSNs bypass the limit.
**Why:** deliveries fall behind what is enqueued: a destination that
defers everything, a route that fails, no worker running.
**Fix:** answer the submitter with a temporary failure (a 452 in SMTP),
look at `queue.list()` and the `deferred` events, and check a worker
called `start()`.
**On MongoDB:** an add that lost its place to other adds 32 times in a
row is refused so too, with a count that may be below the limit; and an
instance given a lower `limits.maxItems` than the others refuses adds
they would take. Give every instance the same `limits.maxItems` (the
guide's [`limits.maxItems`](guide.md#limitsmaxitems)).

### `QueueError: … must be an address, local@domain, not "…"`

**Code:** `INVALID`.
**When:** `from`, a recipient, or `dsn.from` is not `local@domain`, is
longer than 254 characters, has a local part over 64, or holds a space,
a control character (CR and LF included) or an angle bracket — or is not
an address by RFC 5321's grammar, which `sendMail` would refuse at
delivery: `a(b)@example.com`, `a,b@example.com`, `"x@example.com`,
`a@b@example.com`, `a..b@example.com`, `a@example.com,`, `a@-example`.
Check one yourself with `@bumail/smtp/client`'s `isMailbox`.
**Fix:** give the bare address, without brackets or a display name:

```ts
await queue.enqueue(message, { from: 'mary@example.net', to: ['joe@example.com'] });
```

For a bounce of your own, the null sender is `from: ''`.

### `QueueError: to must hold one recipient or more`

**Code:** `INVALID`. `to` is an empty array, or not an array nor a
string. Give one address or more.

### `QueueError: The envelope is an object: { from, to }`

**Code:** `INVALID`. `enqueue`'s second argument is missing.

### `QueueError: The message is a Uint8Array, a string or a ReadableStream<Uint8Array>`

**Code:** `INVALID`. Give the whole message; a `Blob` is
`new Uint8Array(await blob.arrayBuffer())` or `blob.stream()`.

### `QueueError: The message stream must give Uint8Array chunks`

**Code:** `INVALID`. A stream of strings: pipe it through a
`TextEncoderStream` first.

### `QueueError: The message has a bare CR or LF at byte …: every line must end in CRLF`

**Code:** `INVALID`.
**When:** `enqueue`, with a CR not followed by an LF, or an LF not after
a CR — often a message written with `\n` line ends.
**Why:** `sendMail` refuses such a message (`BARE_LINE_BREAK`, against
SMTP smuggling), which would fail every recipient at delivery.
**Fix:** write the message with CRLF before you sign and enqueue it:

```ts
const message = text.replace(/\r?\n/g, '\r\n');
```

## Creating the queue

### `QueueError: The 'mx' route needs a resolver, such as @bumail/dns's nodeResolver()`

**Code:** `INVALID`.
**When:** `route` is `'mx'` (the default) or a `routes` entry is, with no
`resolver`.
**Fix:**

```ts
import { nodeResolver } from '@bumail/dns';
createQueue({ store, hostname, resolver: nodeResolver() });
```

or route everything through a smarthost (`route: { host, port, auth }`).

### `QueueError: hostname must be this server's public host name, not …`

**Code:** `INVALID`. `hostname` is missing, or not a host name
(`mail.example.net`): no space, no address literal.

### `QueueError: route must be 'mx' or a smarthost with a host`

**Code:** `INVALID`, also as `routes["…"] must be …`. A smarthost needs
`host`, a name or an address with no space or slash:
`{ host: 'smtp.provider.example', port: 587 }`.

### `QueueError: route.auth needs tls: 'required', the default with auth: with tls: '…' the password would go to a server whose certificate is not checked`

**Code:** `INVALID`, also as `routes["…"].auth needs …`.
**When:** a smarthost with `auth` and `tls: 'opportunistic'` or
`tls: 'none'`.
**Why:** credentials go only over TLS whose certificate checked out, as
`sendMail` requires; there is no way out for a test server here.
**Fix:** leave `tls` out (it is `'required'` with `auth`), and give the
server's CA with `ca` if its certificate is not publicly trusted:

```ts
route: { host: 'smtp.provider.example', port: 587, auth: { username, password } },
```

### `QueueError: route.auth.username must be a non-empty string`, and the other smarthost options

**Code:** `INVALID`, also under `routes["…"].`: `auth.password must be a
non-empty string`, `auth.mechanism must be 'PLAIN' or 'LOGIN', not …`,
`port must be an integer from 1 to 65535, not …`, `tls must be
'opportunistic', 'required' or 'none', not …`, `secure must be true or
false, not …`, and `secure is TLS from the first byte: it cannot go with
tls: 'none'`. The same checks `sendMail` makes, made once by
`createQueue` rather than at every delivery. `mxPort` and `mxTls` are
checked the same way.

### `QueueError: timeouts.… must be a number of seconds above 0 and at most 2147483, not …`

**Code:** `INVALID`, also as `deadline must be …` or `timeouts must be
an object of seconds`. Timeouts are seconds,
as `sendMail` takes them, not milliseconds: `timeouts: { connect: 30 }`.

### `QueueError: store must be a QueueStore, such as MemoryQueueStore`

**Code:** `INVALID`. Give `new MemoryQueueStore()` (from
`@bumail/queue/memory`), `SqliteQueueStore.open({ directory })` (from
`@bumail/queue/sqlite`), or a store of your own.

### `QueueError: … must be an integer of at least …, not …`

**Code:** `INVALID`, also as `… must be an integer from … to …, not …`
or `… must be a number from … to …, not …`. A number option out of its range:
`concurrency`, `perDomain`, `leaseMs` (from 1000 to 6442450941),
`pollInterval` (at most 2147483647, the longest a timer waits),
`retry.*` (`retry.max` at least `retry.first`, `retry.jitter` from 0 to
1), `dsn.delayAfter`, `limits.*` (`limits.maxReplyText` from 64 to
900). Times are milliseconds.

### `QueueError: dsn.returnContent must be 'headers' or 'full', not …`

**Code:** `INVALID`.

### `QueueError: createQueue() takes an options object`

**Code:** `INVALID`.

### `QueueError: owner must be a non-empty string`

**Code:** `INVALID`, also as
[`owner holds a NUL or a lone surrogate, which a store cannot keep`](#queueerror--holds-a-nul-or-a-lone-surrogate-which-a-store-cannot-keep).
Leave `owner` out for a random one, or give
each worker its own name.

## The `error` event

### `QueueError: The lease on … was lost before its outcome was recorded; another worker will try it again`

**Code:** `LEASE_LOST`.
**When:** a delivery took longer than its lease, and another worker
claimed the item meanwhile. The outcome of this attempt is not recorded,
so the recipients it reached may get the message twice.
**Why:** the lease is renewed every third of `leaseMs`; it is lost when
the process stalled longer than that, or the store could not be reached.
**Fix:** a longer `leaseMs`, or find what stalled the process.

### `QueueError: The lease on … was lost while it was delivered`

**Code:** `LEASE_LOST`. A renewal was refused while the item was still in
the store, held by another worker or by none (another worker took it and
let go of it): the same cause as above, seen sooner. A renewal that finds the item gone
says nothing: the outcome, once the sessions end, tells a cancel from a
lease lost (below).

### `QueueError: The lease on … expired before its outcome was recorded, and the item is gone: lost to another worker that finished it, the message then sent twice, or cancelled`

**Code:** `LEASE_LOST`.
**When:** a delivery ran past its lease's expiry — no renewal reached the
store in time — and, when it tried to record its outcome, the item was no
longer in the store. No `delivered`, `deferred` or `failed` event and no
DSN come from this attempt.
**Why:** past its expiry, another worker may claim the item, deliver it
and drop it; but a `cancel` drops it too, and the store keeps no record of
which happened. The worker cannot tell them apart, so it says both rather
than report outcomes nobody recorded. When another worker took it, the
recipients both reached got the message twice; that worker's events tell
what it delivered.
**Fix:** as for the lease lost above: a longer `leaseMs`, or find what
stalled the process — an event loop blocked, a store out of reach. A
cancel under a lease that still held is told as before: its outcomes on
the events, with no error and no DSN.

When the instances' clocks are out of step, one whose clock runs ahead
can claim the item while this worker's own clock says the lease still
holds. If it finishes and drops the item between two of this worker's
renewals, no renewal saw it taken and the expiry has not passed by this
clock: the attempt reads as a cancel, its outcomes told on the events
with no error. Keep the machines on NTP; the 10-minute `leaseMs` leaves
room for seconds of skew.

### `QueueError: The lease on … was lost while it was delivered, and the item is gone: finished by the worker that took it, the message then sent twice, or cancelled`

**Code:** `LEASE_LOST`, after
[`The lease on … was lost while it was delivered`](#queueerror-the-lease-on--was-lost-while-it-was-delivered).
**When:** a renewal was refused while the item was still in the store,
held by another worker or by none, and when this worker tried to record
its outcome the item was gone. No outcome event and no DSN come from this
attempt.
**Why:** another worker claimed the item once this one's lease had
expired by its own clock — this worker stalled, or the instances' clocks
disagree (an instance whose clock runs ahead sees leases expire early) —
and has most likely finished and dropped it, the recipients both reached
getting the message twice. A `cancel` after the renewal drops it too, and
the store keeps no record of which happened, so the message names both.
**Fix:** a longer `leaseMs`, find what stalled the process, and keep the
machines on NTP.

### `SmtpError: sendMail(): …` (`INVALID_OPTION`), with recipients deferred as `4.3.5`

**When:** `sendMail` refused the options of a session — the route, the
timeouts, `hostname` as EHLO — though `createQueue` took them.
**Why:** a configuration only `sendMail` can check, or a `send` of your
own that refuses its options. It is the route's fault, not the
recipient's: the recipients are deferred as `4.3.5` (system incorrectly
configured), not failed, so no DSN goes out for it until
`retry.giveUpAfter` (5 days by default), when they fail as `4.4.7` with a
DSN like any deferred recipient.
**Fix:** read the message, fix the option, restart: the deferred items
go out on their next attempt, or at once with `retryNow`.

### `SQLiteError: database is locked`, or another store error, during a delivery

**When:** the `error` event, with the item's `id`, while it is delivered.
**Why:** a lease renewal failed: the database busy past `busyTimeout`,
or the store unreachable. The next renewal, a third of `leaseMs` later,
tries again; only a renewal that finds the lease taken stops (as
`LEASE_LOST`).
**Fix:** a longer `busyTimeout` when several processes write a lot; a
store that keeps failing will lose the lease once it expires.

### `PostgresError: …`, or a connection error, during a delivery

**When:** the `error` event, with the item's `id`, while it is delivered,
on `@bumail/queue/postgres`.
**Why:** a lease renewal failed: the database restarted, a connection
dropped, or the server refused one past its `max_connections`. As on
`bun:sqlite`, the next renewal tries again, and only a lease taken by
another instance stops them. A claim that fails the same way rejects
`deliverDue()`, or is told on `error` under `start()`, which tries again
at its next pass. An outcome that cannot be recorded is told on `error`
with the item's `id`; the item stays as it was, and is claimed again once
its lease expires — its recipients may then get the message twice.
**Fix:** check the database is up and reachable; when the server counts
too many connections, give each instance's client a smaller `max` (see
the guide's Pool size) or raise `max_connections`.

### `RedisError: …` during a delivery: `Connection closed`, `OOM command not allowed …`, `READONLY …`

**When:** the `error` event, with the item's `id`, while it is delivered,
on `@bumail/queue/redis`. A call of yours — `enqueue`, `list`, `get`,
`retryNow`, `cancel` — rejects with the same `RedisError` for the same
reasons: an `enqueue` refused with `OOM …` kept nothing.
**Why:** a lease renewal failed. `Connection closed`: Redis restarted,
or the connection dropped, while the command was on its way; a command
sent while the client is reconnecting waits instead. `Max reconnection
attempts reached` or `Connection has failed`: Redis is out of reach, and
`Bun.RedisClient` gave up reconnecting (20 tries by default). `OOM
command not allowed when used memory > 'maxmemory'`: Redis is full and
refuses writes. `READONLY You can't write against a read only replica`:
the client reaches a replica, or a primary that was demoted by a
failover. As on PostgreSQL, the next renewal tries again, only a lease
taken by another instance stops them, a claim that fails rejects
`deliverDue()` or is told on `error` under `start()`, and an outcome
that cannot be recorded leaves the item to be claimed again once its
lease expires — its recipients may then get the message twice.
**Fix:** check Redis is up and that the URL names the primary (through
your provider's endpoint or Sentinel's, which follows a failover). For
`OOM`, give Redis more `maxmemory`, or drain the queue; keep
`maxmemory-policy noeviction` (the guide's [Redis](guide.md#redis)), or
Redis drops queue items to make room instead of refusing.

### `MongoServerSelectionError: …`, `MongoNotConnectedError: …` or another driver error during a delivery

**When:** the `error` event, with the item's `id`, while it is delivered,
on `@bumail/queue/mongo`. A call of yours — `enqueue`, `list`, `get`,
`retryNow`, `cancel` — rejects with the same error for the same
reasons. The store passes the driver's errors on as they are; only the
first call's are wrapped (`The MongoDB queue cannot be set up: …`).
**Why:** a lease renewal failed. `MongoServerSelectionError: Server
selection timed out after … ms` or `connect ECONNREFUSED …`: no server
the store may use — the primary, since it reads and writes there only —
answered within the client's `serverSelectionTimeoutMS` (30 seconds by
default): it is down, or a replica set is electing a new one, or has no
majority left to elect one. `MongoNotConnectedError: Client must be
connected before running operations`: your code closed the client while
the queue still ran. A write that waits rather than fails: a replica
set that cannot get a majority to acknowledge it (the store asks `w:
'majority'`), such as a primary, a secondary and an arbiter with the
secondary down, holds it until it can, or until the client's
`timeoutMS`, when you set one. As on PostgreSQL, the next renewal tries again, only a
lease taken by another instance stops them, a claim that fails rejects
`deliverDue()` or is told on `error` under `start()`, and an outcome
that cannot be recorded leaves the item to be claimed again once its
lease expires — its recipients may then get the message twice.
**Fix:** check the server or the replica set is up and has a primary
and a majority; stop the queue (`await queue.stop()`) before closing the
client; give the client a `timeoutMS` so a write that waits for a
majority fails rather than hangs. The guide's
[Durability and failover](guide.md#durability-and-failover) says what a
failover can cost.

## The `bun:sqlite` store

### `QueueError: A SQLite queue store needs a directory`

**Code:** `INVALID`. `SqliteQueueStore.open({ directory })`.

### `QueueError: The queue at "…" cannot be opened: …`

**Code:** `INVALID`. The directory cannot be made or written, or
`queue.sqlite` is not a database (`file is not a database`). Check the
path and its owner. A directory the store makes is 0700; one that
already exists keeps its mode, so make it 0700 yourself unless a group
should read the queue.

### `QueueError: The database is at schema version …, newer than this store's …`

**Code:** `INVALID`. A newer version of the package wrote the database
(`queue.sqlite`, on PostgreSQL the prefix's tables, on Redis the
prefix's keys, whose layout version is `<prefix>schema`, on MongoDB the
prefix's collections, whose layout version is the `layout` document of
`<prefix>schema`): upgrade this one.

### `QueueError: busyTimeout must be an integer of at least 0, not …`

**Code:** `INVALID`. Milliseconds a write waits for another process.

### `QueueError: The queue store is closed`

**Code:** `CLOSED`. The store was used after `close()`: call
`queue.stop()` first, then `store.close()`. The PostgreSQL, Redis and
MongoDB stores say the same.

## The PostgreSQL store

### `QueueError: A PostgreSQL queue store needs sql: a Bun.SQL client or a postgres:// URL`

**Code:** `INVALID`.
**When:** `PostgresQueueStore.open` without `sql`, or with a string that
is not a `postgres://` or `postgresql://` URL, or an object without
`unsafe`, `begin` and `close`. The message never repeats the URL, which
may hold a password.
**Fix:**

```ts
PostgresQueueStore.open({ sql: 'postgres://bumail:secret@db.internal:5432/mail' });
// or a client of yours, sized as you need:
PostgresQueueStore.open({ sql: new Bun.SQL({ url, max: 10 }) });
```

### `QueueError: sql is a … client; the queue needs a PostgreSQL one`

**Code:** `INVALID`. A `Bun.SQL` client made for SQLite or MySQL
(`adapter: 'sqlite'`, a `mysql://` URL). For SQLite, use
`@bumail/queue/sqlite`; otherwise give a PostgreSQL client.

### `QueueError: tablePrefix must be lowercase letters, digits and underscores, starting with a letter or an underscore, at most 40 characters, not …`

**Code:** `INVALID`.
**Why:** the prefix is written into every statement, never bound as a
value, so anything that is not a plain name is refused — and 40
characters keep the longest name built on it within PostgreSQL's 63.
**Fix:** `tablePrefix: 'mail_queue_'`. To put the tables in another
schema, set the connection's `search_path` rather than a dotted prefix.

### `QueueError: The URL in sql cannot be opened: …`

**Code:** `INVALID`.
**When:** `PostgresQueueStore.open` with a URL `Bun.SQL` refuses before
connecting, such as a `sslmode` it does not know. The rest is Bun's
reason (`The argument 'sslmode' must be one of: disable, allow, prefer,
require, verify-ca, verify-full. Received '…'`); the URL is never
repeated, and the password is masked should the reason name it.
**Fix:** correct the parameter: `?sslmode=require`, or `verify-full` to
check the server's certificate.

### `QueueError: The PostgreSQL queue cannot be set up: …`

**Code:** `INVALID`.
**When:** the first call on a store, or `migrate()`, when the tables
cannot be made or brought up to date. The rest of the message is the
database's: `Failed to connect`, `password authentication failed for
user "…"`, `permission denied for schema public`.
**Why:** the database is out of reach, the credentials are wrong, or the
tables are missing or behind and the role may not create them: a role
without `CREATE` can use tables that are current, never make them.
**Fix:** check the URL and that the server answers. For `permission
denied`, run `migrate()` once with an owner's role — on a new database,
and after an upgrade that adds a migration — and keep the workers on
their narrower role (the guide's [Migrations](guide.md#migrations)); or
give the role `CREATE` on the schema. The next call tries again: nothing is left half made,
since a migration is one transaction.

## The Redis store

### `QueueError: A Redis queue store needs client, a Bun.RedisClient, or url, a redis:// URL`

**Code:** `INVALID`.
**When:** `RedisQueueStore.open` with neither `client` nor `url`, a
`url` that is not a URL of a scheme `Bun.RedisClient` takes (`redis://`,
`rediss://`, `valkey://`, `valkeys://`, `redis+tls://`, `redis+unix://`,
`redis+tls+unix://`), or a `client` without `send`, `getBuffer` and
`close`. The message never repeats the URL, which may hold a password.
**Fix:**

```ts
RedisQueueStore.open({ url: 'rediss://bumail:secret@cache.internal:6380/0' });
// or a client of yours, configured as you need:
RedisQueueStore.open({ client: new Bun.RedisClient(url, { connectionTimeout: 5000 }) });
```

### `QueueError: A Redis queue store takes client or url, not both`

**Code:** `INVALID`. Give one: `client` for a client you configure and
close, `url` for one the store opens and closes.

### `QueueError: keyPrefix must be lowercase letters, digits, '_', ':', '.' and '-', starting with a letter, at most 40 characters, not …`

**Code:** `INVALID`.
**Why:** the prefix starts every key the store writes. Anything Redis or
a `SCAN MATCH` reads specially is refused: `{` (a Cluster hash tag), `*`,
`?`, `[` and `\` (glob characters), spaces and control characters.
**Fix:** `keyPrefix: 'mail:queue:'`. Give each queue in one Redis
database its own prefix.

### `QueueError: The URL in url cannot be opened: …`

**Code:** `INVALID`.
**When:** `RedisQueueStore.open` with a URL `Bun.RedisClient` refuses
before connecting, such as a database that is not a number (`Invalid
database number in Redis URL: "…"`). The URL is never repeated, and the
password is masked should the reason name it.
**Fix:** correct the URL: the database is the path, `/0` to `/15` on a
default Redis.

### `QueueError: The Redis queue cannot be set up: …`

**Code:** `INVALID`.
**When:** the first call on a store, which reads the layout version of
its keys (`<prefix>schema`), writing it on a new queue. The rest of the
message is Redis's or Bun's: `Max reconnection attempts reached` (out of
reach), `WRONGPASS invalid username-password pair or user is disabled.`,
`ERR DB index is out of range`, `NOPERM …` (an ACL user without
`EVALSHA`, `EVAL` or the keys).
**Why:** the server is out of reach, the credentials or the database are
wrong, or the user may not run scripts. With `Bun.RedisClient`'s
defaults an unreachable server takes about half a minute of reconnecting
before the call fails.
**Fix:** check the URL and that Redis answers. An ACL user needs the
commands the store sends and those its scripts call, on the keys under
its prefix, and nothing else (the guide's [Redis](guide.md#redis) has
the `ACL SETUSER` line). The next call tries again.

### `QueueError: The key …schema does not hold a layout version: is the prefix another application's?`

**Code:** `INVALID`.
**When:** the first call on a store whose `<prefix>schema` key holds
something other than a whole number of at least 1.
**Why:** the store keeps its layout version there; anything else means
another application, or a hand, wrote under the same prefix.
**Fix:** give the queue a `keyPrefix` of its own. Nothing was written.

## The MongoDB store

### `QueueError: A MongoDB queue store needs db: a Db of the mongodb driver, or an object of its shape`

**Code:** `INVALID`.
**When:** `MongoQueueStore.open` without `db`, or with something that has
no `collection` method: a connection string, a `MongoClient` rather than
its `db()`, a collection. The message never repeats what was given,
which may be a URL holding a password.
**Why:** the store opens no connection of its own — the package depends
on no driver — so it takes a database from a client of yours.
**Fix:**

```ts
import { MongoQueueStore } from '@bumail/queue/mongo';
import { MongoClient } from 'mongodb';

const client = new MongoClient('mongodb://bumail:secret@db.internal:27017/?replicaSet=rs0');
MongoQueueStore.open({ db: client.db('mail') });
```

### `QueueError: A MongoDB queue store takes db, not url: give it client.db() of a MongoClient of yours`

**Code:** `INVALID`.
**When:** `MongoQueueStore.open` given `url`, alone or beside `db`, as
the Redis and PostgreSQL stores take one. The URL is never repeated.
**Why:** the package has no MongoDB driver to open a client with: the
application opens it, and gives the store its database.
**Fix:** `MongoQueueStore.open({ db: new MongoClient(url).db('mail') })`,
and close that client yourself.

### `QueueError: collectionPrefix must be lowercase letters, digits and underscores, starting with a letter or an underscore, at most 40 characters, not …`

**Code:** `INVALID`.
**Why:** the prefix starts the name of each of the queue's three
collections. Anything MongoDB reads in a collection's name is refused —
`$`, `.` (and so `system.`), a NUL — with spaces, capitals and anything
not ASCII, as for the PostgreSQL store's `tablePrefix`.
**Fix:** `collectionPrefix: 'mail_queue_'`. Give each queue in one
database its own prefix; to keep the queue in another database, give
the store that `client.db('…')`.

### `QueueError: db cannot give the queue's collections: …`

**Code:** `INVALID`.
**When:** `MongoQueueStore.open`, when `db.collection(name, options)`
throws: an object of your own shape that refuses the options the store
gives, or a driver that refuses the name. The rest is its reason, the
client's password masked should it name it.
**Fix:** a `Db` of the `mongodb` driver, 6 or later; an object of your
own must take the options of `MongoQueueCollectionOptions`.

### `QueueError: The MongoDB queue cannot be set up: …`

**Code:** `INVALID`.
**When:** the first call on a store, which reads the layout version in
`<prefix>schema` and, on a new queue, makes the indexes and writes it.
The rest of the message is the driver's: `connect ECONNREFUSED …` or
`Server selection timed out after 30000 ms` (out of reach),
`Authentication failed.`, `not authorized on mail to execute command {
createIndexes: "bumail_queue_items", … }` (a user who may not create an
index, on a new queue). The client's password is masked wherever it
appears, as `…` — inside other words too, when it is a short one.
**Why:** the server is out of reach, the credentials are wrong, or the
queue is new, or behind after an upgrade, and the user may not make its
indexes: a user with `find`, `insert`, `update` and `remove` on the
queue's collections runs a queue that is set up, never sets one up.
**Fix:** check the URL and that the server answers. For `not
authorized`, make the first call once with a user that has `readWrite`
on the database — on a new queue, and after an upgrade that adds a
migration — and keep the workers on their narrower role (the guide's
[Permissions](guide.md#permissions)). The next call tries again: each
migration is safe to run twice.

### `QueueError: The collection …schema does not hold a layout version: is the prefix another application's?`

**Code:** `INVALID`.
**When:** the first call on a store whose `<prefix>schema` collection
has a `layout` document without a whole `version` of at least 1.
**Why:** the store keeps its layout version there; anything else means
another application, or a hand, wrote under the same prefix.
**Fix:** give the queue a `collectionPrefix` of its own. Nothing was
written: no index is made before the version is read.

### `QueueError: The collection …schema holds a sequence that is not a number`

**Code:** `INVALID`.
**When:** `add`, when the `seq` document of `<prefix>schema`, the
counter that orders items equally due, holds a number that is not whole
once incremented. One that holds no number at all is refused by MongoDB
itself, as a `MongoServerError: … Cannot apply $inc to a value of
non-numeric type`.
**Why:** a hand, or another application, wrote it.
**Fix:** set it back to a whole number at least as high as the highest
`seq` of the items: `db.bumail_queue_schema.updateOne({ _id: 'seq' },
{ $set: { n: db.bumail_queue_items.find().sort({ seq: -1 }).limit(1).next()?.seq ?? 0 } })`
in `mongosh`. Nothing was stored by the add refused.

## Listing

### `QueueError: limit must be an integer from 1 to 1000, not …`

**Code:** `INVALID`. `queue.list()` (and a store's `list`) gives at most
1000 items a page: page through with `offset`.

```ts
for (let offset = 0; ; offset += 1000) {
	const page = await queue.list({ offset, limit: 1000 });
	if (page.length === 0) break;
}
```

### `QueueError: offset must be an integer of at least 0, not …`

**Code:** `INVALID`. `offset` counts items from the first due, from 0.

## A store's own checks

**Code:** `INVALID`, from a store called directly with what the queue
never gives it. Each message names what is wrong:

- `QueueError: … must be a finite number` (`createdAt`, `now`,
  `nextAttemptAt`)
- `QueueError: owner must be a non-empty string`
- `QueueError: leaseMs must be a positive number`
- `QueueError: maxItems must be an integer of at least 1, not …`
- `QueueError: A new item is an object`
- `QueueError: from must be a string`
- `QueueError: to must be a non-empty array of addresses`
- `QueueError: message must be a Uint8Array`
- `QueueError: A claim is an object`
- `QueueError: An attempt result is an object`
- `QueueError: attempts must be an integer of at least 0`
- `QueueError: delayNotified must be true or false`
- `QueueError: recipients must be an array of { address, status:
  delivered, deferred or failed }`
- [`QueueError: A reply is an object with a text`](#queueerror-a-reply-is-an-object-with-a-text),
  [`reply.status must be a string`](#queueerror-replystatus-must-be-a-string),
  [`reply.host must be a string`](#queueerror-replyhost-must-be-a-string)
- [`QueueError: … holds a NUL or a lone surrogate, which a store cannot
  keep`](#queueerror--holds-a-nul-or-a-lone-surrogate-which-a-store-cannot-keep)

A list's `offset` and `limit` are checked as under [Listing](#listing).

### `QueueError: A reply is an object with a text`

**Code:** `INVALID`.
**When:** `complete` called directly with a recipient whose `reply` is
not an object, or has no string `text`.
**Why:** a reply is a `Diagnostic`, `{ code?, status?, text, host? }`:
`text` is what a DSN and the events show, so every store needs it. The
queue's own outcomes always have one.
**Fix:** give the text, even for a reply with no code:

```ts
await store.complete(id, owner, {
	...result,
	recipients: [{ address, status: 'deferred', reply: { status: '4.4.1', text: 'No answer' } }],
});
```

### `QueueError: reply.status must be a string`

**Code:** `INVALID`.
**When:** `complete` called directly with a `reply.status` that is
neither left out nor a string — often the reply code given as a number.
**Why:** `status` is the enhanced status code, `x.y.z` (RFC 3463), kept
as text; the reply code goes in `code`.
**Fix:** `reply: { code: 451, status: '4.3.0', text: 'Try later' }`, or
leave `status` out.

### `QueueError: reply.host must be a string`

**Code:** `INVALID`.
**When:** `complete` called directly with a `reply.host` that is neither
left out nor a string, such as an address object from a socket.
**Why:** `host` is the name or address the attempt was for, kept as text.
**Fix:** give it as text — `host: 'mx1.example.com'` or
`host: '192.0.2.1'` — or leave it out.

### `QueueError: … holds a NUL or a lone surrogate, which a store cannot keep`

**Code:** `INVALID`. The … is `from`, `A recipient`, `owner`,
`reply.text`, `reply.status` or `reply.host`.
**When:** `add`, `complete`, or any call that takes an `owner`, called
directly with a text holding U+0000 or half of a surrogate pair — a string cut in the
middle of an emoji, say. `createQueue` refuses such an `owner` the same
way.
**Why:** PostgreSQL cannot keep a NUL in text, and no UTF-8 encoding can
carry a lone surrogate (`Bun.RedisClient` would write one as U+FFFD
without a word), so every store refuses them alike — whichever
store you give it, the same text is kept or refused. The queue's own
replies never hold one: it cuts a reply's text only between whole
characters.
**Fix:** drop the NULs and cut text on whole characters before you give
it to the store:

```ts
const clean = text.replaceAll('\0', '').toWellFormed();
```

## Delivery

### A recipient stays `deferred` with `4.4.1` or `4.4.2`

**When:** the `deferred` event's `reply` has no `code`, a `status` of
`4.4.1` (no answer) or `4.4.2` (connection lost or timed out), and a
text such as `Could not connect to …`.
**Why:** usually outbound port 25 is blocked by your network or your
cloud provider.
**Fix:** route through a smarthost on port 587 or 465:

```ts
createQueue({ store, hostname, route: { host: 'smtp.provider.example', port: 587, auth } });
```

### Every delivery fails at once with `5.7.1`, or with a reply naming your IP or EHLO name

**Why:** the receiving server refused your server itself: no reverse
DNS, a `hostname` that does not match it, an IP on a blocklist, or a
message that fails SPF, DKIM or DMARC.
**Fix:** give `hostname` the name your IP's PTR record holds, publish SPF
and DKIM for your domain, and sign every message before you enqueue it.

### A recipient fails with `5.1.3`, `The address is not one SMTP can carry`

**When:** an item a store holds has a recipient `sendMail` would refuse:
written there by other code, since `enqueue` refuses it.
**Why:** it fails alone, so the session for its domain still goes ahead
for the other recipients.
**Fix:** enqueue through `queue.enqueue`, or check each address with
`@bumail/smtp/client`'s `isMailbox` before a store of your own keeps it.

### Every recipient fails with `5.1.7`, `The sender's address is not one SMTP can carry`

**When:** an item a store holds has a sender (`from`) that is neither
`''` nor one `isMailbox` takes: written there by other code, since
`enqueue` refuses it.
**Why:** no session can carry it, so every recipient fails at once
rather than be deferred until `retry.giveUpAfter`. No session is opened
and no `perDomain` slot is taken, so the item never waits behind a busy
domain, and its recipients fail even while `stop()` runs. The failure DSN goes
to that same address, so it fails in turn, as `5.1.3`, and causes no
other.
**Fix:** enqueue through `queue.enqueue`, or check the sender with
`@bumail/smtp/client`'s `isMailbox` (or let it be `''`) before a store of
your own keeps it.

### `retryNow` returns `false` for an item that is in the queue

**Why:** a worker is delivering it: its lease is held. That attempt's
outcome sets the next one, so `retryNow` changes nothing.
**Fix:** call it again once the attempt is over (the `deferred` event).
