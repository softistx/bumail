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
- [`SmtpError: sendMail(): …` (`INVALID_OPTION`), with recipients deferred as `4.3.5`](#smtperror-sendmail--invalid_option-with-recipients-deferred-as-435)
- [`SQLiteError: database is locked`, or another store error, during a delivery](#sqliteerror-database-is-locked-or-another-store-error-during-a-delivery)

**The `bun:sqlite` store** (`@bumail/queue/sqlite`)

- [`QueueError: A SQLite queue store needs a directory`](#queueerror-a-sqlite-queue-store-needs-a-directory)
- [`QueueError: The queue at "…" cannot be opened: …`](#queueerror-the-queue-at--cannot-be-opened-)
- [`QueueError: The database is at schema version …, newer than this store's …`](#queueerror-the-database-is-at-schema-version--newer-than-this-stores-)
- [`QueueError: busyTimeout must be an integer of at least 0, not …`](#queueerror-busytimeout-must-be-an-integer-of-at-least-0-not-)
- [`QueueError: The queue store is closed`](#queueerror-the-queue-store-is-closed)

**Listing** (`list`)

- [`QueueError: limit must be an integer from 1 to 1000, not …`](#queueerror-limit-must-be-an-integer-from-1-to-1000-not-)
- [`QueueError: offset must be an integer of at least 0, not …`](#queueerror-offset-must-be-an-integer-of-at-least-0-not-)

**A store's own checks** (a store of your own, called directly)

- [`QueueError: … must be a finite number`, `owner must be a non-empty string`, and the others](#a-stores-own-checks)

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

**Code:** `INVALID`. Leave `owner` out for a random one, or give each
worker its own name.

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

**Code:** `LEASE_LOST`. A renewal found the lease taken: the same cause as
above, seen sooner.

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

**Code:** `INVALID`. A newer version of the package wrote the database:
upgrade this one.

### `QueueError: busyTimeout must be an integer of at least 0, not …`

**Code:** `INVALID`. Milliseconds a write waits for another process.

### `QueueError: The queue store is closed`

**Code:** `CLOSED`. The store was used after `close()`: call
`queue.stop()` first, then `store.close()`.

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

A list's `offset` and `limit` are checked as under [Listing](#listing).

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
