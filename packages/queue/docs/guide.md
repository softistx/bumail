# Guide

How to send mail out with `@bumail/queue`: what the queue keeps, how it
delivers, when it tries again, what it sends back, and how several
workers share it.

- [The smallest queue](#the-smallest-queue)
- [Enqueuing](#enqueuing)
- [Delivery and routing](#delivery-and-routing)
- [Retries](#retries)
- [Delivery status notifications](#delivery-status-notifications)
- [Several workers, leases and stopping](#several-workers-leases-and-stopping)
- [Events](#events)
- [Admin](#admin)
- [The stores](#the-stores)
- [Testing](#testing)
- [Writing a store](#writing-a-store)
- [Options](#options)

## The smallest queue

```ts
import { nodeResolver } from '@bumail/dns';
import { createQueue } from '@bumail/queue';
import { MemoryQueueStore } from '@bumail/queue/memory';

const queue = createQueue({
	store: new MemoryQueueStore(),
	hostname: 'mail.example.net',
	resolver: nodeResolver(),
});
queue.start();
await queue.enqueue('From: mary@example.net\r\nTo: joe@example.com\r\nSubject: Hi\r\n\r\nHello\r\n', {
	from: 'mary@example.net',
	to: 'joe@example.com',
});
```

`hostname` is your server's public name. The queue gives it in EHLO, as
the Reporting-MTA of its DSNs, and in their default From
(`postmaster@<hostname>`). Mail hosts check it against your IP's reverse
DNS, so give the name your PTR record holds.

## Enqueuing

```ts
const item = await queue.enqueue(message, { from: 'mary@example.net', to: ['joe@example.com'] });
```

- **The message** is a `Uint8Array`, a string (encoded as UTF-8) or a
  `ReadableStream<Uint8Array>`, read to its end but never past
  `limits.maxMessageSize`. It is sent as it is: sign it with DKIM
  (`@bumail/auth`'s `signDkim`) before you enqueue it, and give it CRLF
  line ends.
- **The envelope** is `{ from, to }`. `from` is the reverse-path, or `''`
  for the null sender of a bounce you write yourself. `to` is one address
  or an array. Each recipient is kept once: two addresses that differ
  only in the case of their domain are one.
- **What comes back** is the item: an `id`, every recipient `pending`,
  `nextAttemptAt` now. `start()` wakes at once to deliver it.

Every address is checked: `local@domain`, 254 characters at most, with no
space, no control character and no angle bracket — nothing that could
break an SMTP command line or a header field.

### Never an open relay

The queue sends whatever it is given, to any domain. Who may send is your
decision, made before `enqueue`: an SMTP server enqueues a message for
another domain only when the session authenticated (`@bumail/smtp`'s
server refuses to relay otherwise), and an app enqueues only for its own
users. Never enqueue what an unauthenticated client submitted.

## Delivery and routing

An attempt delivers every recipient not yet final, grouped by domain: one
SMTP session per domain, through `@bumail/smtp/client`'s `sendMail`. Each
recipient's outcome is recorded with the reply that decided it.

| outcome | status | what happens |
| --- | --- | --- |
| `250` to RCPT and to the final dot | `delivered` | final |
| a `5xx`, to RCPT or to anything that ends the session | `failed` | final, at once; a DSN |
| a `4xx`, a connection error, a timeout, a TLS failure | `deferred` | tried again later |
| a null MX (RFC 7505), a domain that does not exist | `failed` | final; a DSN |

### Routes

```ts
createQueue({
	store,
	hostname: 'mail.example.net',
	resolver: nodeResolver(),
	route: 'mx', // the default
	routes: {
		'partner.example': { host: 'relay.partner.example', port: 25, tls: 'required' },
		'legacy.example': { host: '10.0.0.5', tls: 'none' },
	},
});
```

- `'mx'`: the recipient domain's own mail hosts, by its MX records, its A
  or AAAA when it has none. It needs `resolver`: `@bumail/dns`'s
  `nodeResolver()`, `cachedResolver()` over it, or any object with `mx`,
  `a` and `aaaa` of that shape. `mxPort` (25) and `mxTls`
  (`opportunistic`: STARTTLS when offered, the certificate not checked,
  RFC 7435) apply to it.
- A smarthost, `{ host, port?, secure?, tls?, auth?, ca? }`: every message
  of the route goes to that host. `secure` is TLS from the first byte
  (port 465); `auth` is sent only over TLS whose certificate checked out.
- `routes` maps a recipient domain (compared in lowercase) to its own
  route, over `route`.

### Around a blocked port 25

Many cloud and home networks block outbound port 25. Send everything
through a provider's submission port instead:

```ts
createQueue({
	store,
	hostname: 'mail.example.net',
	route: {
		host: 'smtp.provider.example',
		port: 587,
		auth: { username: 'mary@example.net', password: smtpPassword }, // from your secrets
	},
});
```

No resolver is needed when no route is `'mx'`.

### Timeouts

`timeouts` and `deadline` pass to `sendMail`: each step's timeout in
seconds (RFC 5321 §4.5.3.2's by default) and the whole session's (1800
seconds, DNS included).

## Retries

```ts
createQueue({
	store,
	hostname,
	resolver,
	retry: {
		first: 30 * 60_000, // the first wait, after the first attempt
		factor: 2, // each wait this many times the last
		max: 4 * 3_600_000, // no wait longer than this
		jitter: 0.1, // plus up to a tenth of the wait, at random
		giveUpAfter: 5 * 24 * 3_600_000, // since enqueue
	},
});
```

The defaults follow RFC 5321 §4.5.4.1: "the retry interval SHOULD be at
least 30 minutes", and "the give-up time generally needs to be at least
4-5 days". The waits are 30 minutes, 1 hour, 2, 4, then every 4 hours.
The jitter only adds, so 30 minutes stays a floor, and spreads the
retries of many messages deferred at once.

The last attempt falls on the moment of giving up: a recipient still
deferred then fails, its last reply kept, its status `4.4.7` (RFC 3463:
delivery time expired), and its text `Gave up after N attempts: …`.

The schedule is per message: an attempt tries every recipient not yet
final, and the item's `attempts` counts them.

## Delivery status notifications

The queue writes DSNs (RFC 3464) as a `multipart/report`
(`report-type=delivery-status`, RFC 6522) of three parts: text for a
person, the `message/delivery-status` fields a program reads, and the
original's header fields.

```
Reporting-MTA: dns; mail.example.net
Arrival-Date: Thu, 01 Oct 2026 12:00:00 +0000

Final-Recipient: rfc822; nobody@example.com
Action: failed
Status: 5.1.1
Remote-MTA: dns; mx.example.com
Diagnostic-Code: smtp; 550 No such user here
Last-Attempt-Date: Thu, 01 Oct 2026 12:00:03 +0000
```

- **A failure** sends one DSN for the recipients that failed in that
  attempt, at once.
- **A delay** sends one "delayed" DSN, once per message, after an attempt
  that leaves recipients deferred `dsn.delayAfter` after enqueue (4 hours
  by default; `false` for none). It carries `Will-Retry-Until`.
- **Never about a DSN**: a message from the null sender `<>` causes no
  DSN, failed or delayed. Every DSN is enqueued from `<>`, to the
  original's sender, and delivered like any other item. It bypasses
  `limits.maxItems`, so a full queue still bounces.
- **What it returns**: `dsn.returnContent: 'headers'` (the default)
  returns the original's header fields as `text/rfc822-headers`; `'full'`
  returns the whole message as `message/rfc822` when it fits
  `limits.maxDsnReturn` (64 KiB), its header fields otherwise. Either is
  cut after the last whole line within that bound.
- **Its From** is `Mail Delivery System <postmaster@<hostname>>`, or
  `dsn.from`. It carries `Auto-Submitted: auto-replied` (RFC 3834).

Nothing from outside reaches a header field raw: a reply's text, a host
name and an address have their control characters taken out (CR and LF
included), the `message/delivery-status` part is 7-bit (a UTF-8 address
is written as `utf-8; j\x{F6}rg@…`, RFC 6533), and every field is folded.

## Several workers, leases and stopping

Any number of queues may share one store, in one process or several:

```ts
const store = SqliteQueueStore.open({ directory: '/var/lib/bumail/queue' });
const queue = createQueue({ store, hostname, resolver, owner: `worker-${process.pid}` });
queue.start();
```

- **A claim** takes the next due item — the earliest `nextAttemptAt`, then
  the oldest — and gives it a lease: `{ owner, expiresAt }`. No other
  worker claims it while the lease holds.
- **The lease is renewed** every third of `leaseMs` (10 minutes by
  default) while the item is delivered, and let go of with the outcome.
- **A crashed worker** loses its items when their leases expire: another
  worker claims them then. A worker whose lease was taken meanwhile
  records nothing, and says so on the `error` event (`LEASE_LOST`).
- **`stop()`** claims nothing more, lets every session under way end and
  records its outcome, and gives back what was claimed but not started —
  due at once, no attempt counted — so another worker can take it.

```ts
process.on('SIGTERM', async () => {
	await queue.stop();
	store.close();
});
```

`concurrency` (20) bounds how many items one worker delivers at once;
`perDomain` (2) how many sessions it opens to one recipient domain, so a
slow or greylisting domain does not take every slot. `pollInterval` (5
seconds) is how often `start()` looks for due items; `enqueue` and
`retryNow` wake it at once.

## Events

```ts
const off = queue.on('deferred', (event) => {
	event.id; // the item
	event.from; // its sender, '' for a DSN
	event.recipient;
	event.reply; // { code?: 451, status?: '4.3.0', text, host? }
	event.attempts;
	event.nextAttemptAt;
});
off(); // stops listening
```

| event | payload |
| --- | --- |
| `delivered` | `{ id, from, recipient, reply?, attempts }` |
| `deferred` | the same, and `nextAttemptAt` |
| `failed` | the same as `delivered` |
| `dsn` | `{ kind: 'delayed' \| 'failed', id, of, to, recipients }`: `id` is the DSN's own item, `of` the item it reports on |
| `error` | `{ error, id? }`: a store that failed, a DSN that could not be enqueued, a lease lost |

Events come once the outcome is recorded. A listener that throws is
ignored. `reply.code` is absent when no server answered: a connection
error, a timeout, the DNS.

## Admin

```ts
await queue.list({ offset: 0, limit: 100 }); // the next due first
await queue.get(id); // undefined once done or cancelled
await queue.retryNow(id); // due now; false when there is no such item
await queue.cancel(id); // dropped, with no DSN; the item as it stood
```

An item is dropped from the store once every recipient is `delivered` or
`failed`: `list` shows what is still to do. Use the events to keep a
history. `retryNow` on an item being delivered leaves that attempt alone:
its outcome sets the next attempt.

## The stores

### `MemoryQueueStore`

```ts
import { MemoryQueueStore } from '@bumail/queue/memory';
const store = new MemoryQueueStore();
```

For specs and trials: the queue is lost on a restart.

### `SqliteQueueStore`

```ts
import { SqliteQueueStore } from '@bumail/queue/sqlite';

const store = SqliteQueueStore.open({ directory: '/var/lib/bumail/queue', busyTimeout: 5000 });
// …
store.close(); // closing twice is fine
```

- **One file**, `queue.sqlite`, in `directory`, created if need be; the
  directory is made 0700 and the files 0600.
- **Durable**: WAL, `synchronous = FULL`, and on macOS `fullfsync`: every
  write is on disk before it is acknowledged.
- **Shared by several processes of one machine**: unlike
  `@bumail/store`'s database, the queue's is not locked to one process. A
  claim is a single `UPDATE … RETURNING`, so two processes never take the
  same item; a writer waits up to `busyTimeout` milliseconds for another.
  Not on a network file system: SQLite's locks do not hold there. For
  several machines, a server database is on the roadmap.
- **Messages in a table of their own**, `messages`, dropped with their
  item in the same transaction. A queue holds a message for days at most
  and never shares one between items, so content addressing (as
  `@bumail/store` does on disk) would buy nothing, and a table keeps the
  add and the drop atomic with no file to sweep after a crash.
- **Migrations** run on open, in one transaction; a database written by a
  newer version is refused.

## Testing

Inject the clock and the sender, and call `deliverDue()` by hand: no
timer, no network.

```ts
import { SmtpError } from '@bumail/smtp/client';
import { createQueue, type Sender } from '@bumail/queue';
import { MemoryQueueStore } from '@bumail/queue/memory';

let now = Date.UTC(2026, 0, 1);
let calls = 0;
const send: Sender = async (_message, options) => {
	if (calls++ === 0) {
		throw new SmtpError('REFUSED', 'busy', { reply: { code: 451, text: 'Try later' } });
	}
	return {
		accepted: [options.to].flat().map((recipient) => ({ recipient, reply: { code: 250, text: 'OK' } })),
		rejected: [],
		reply: { code: 250, text: 'Queued' },
		host: 'mx.test',
		port: 25,
		tls: false,
		authenticated: false,
	};
};
const queue = createQueue({
	store: new MemoryQueueStore(),
	hostname: 'mail.test',
	route: { host: 'mx.test' },
	clock: { now: () => now },
	send,
	random: () => 0, // no jitter
});
const delivered: string[] = [];
queue.on('delivered', (e) => delivered.push(e.recipient));

await queue.enqueue('Subject: hi\r\n\r\nhello\r\n', { from: 'a@test', to: 'b@test' });
await queue.deliverDue(); // deferred: 451
now += 30 * 60_000;
await queue.deliverDue(); // delivered
```

`deliverDue()` resolves once every item due at that moment, and any DSN
it enqueued meanwhile, has been tried; it resolves with how many items it
claimed.

For an end-to-end spec, run `@bumail/smtp`'s `createSmtpServer` on
`127.0.0.1`, give the queue a `@bumail/dns` `fixtureResolver` whose MX
points at it, and `mxPort` its port.

## Writing a store

A store implements `QueueStore`, throws `QueueError` with the contract's
codes, and keeps its promises:

- `claim` is atomic: two claimers, in any process, never get the same
  item; an item whose lease expired is claimable again.
- `complete` applies the outcome, the schedule and the count, and lets go
  of the lease, in one step and only for the lease's owner; a final
  status is never changed; an item whose every recipient is final is
  dropped with its message.
- Times are given by the caller; the store keeps no clock.
- Nothing it returns is shared with what it keeps.

The contract's specs, `describeQueueStore`, which both stores here run,
are internal for now: a store written outside this package cannot run
them yet.

## Options

| option | type | default | effect |
| --- | --- | --- | --- |
| `store` | `QueueStore` | — | where items are kept |
| `hostname` | `string` | — | EHLO, Reporting-MTA, the DSN's From |
| `route` | `'mx' \| Smarthost` | `'mx'` | the default route |
| `routes` | `Record<string, Route>` | — | a route per recipient domain |
| `resolver` | `MxResolver` | — | needed by `'mx'` |
| `mxPort` | `number` | 25 | the port of MX hosts |
| `mxTls` | `TlsMode` | `opportunistic` | TLS to MX hosts |
| `timeouts`, `deadline` | | `sendMail`'s | passed to `sendMail` |
| `retry` | `RetrySchedule` | 30 min, ×2, 4 h max, 10% jitter, 5 days | see [Retries](#retries) |
| `dsn.from` | `string` | `postmaster@<hostname>` | the DSN's From |
| `dsn.delayAfter` | `number \| false` | 4 hours | the "delayed" DSN |
| `dsn.returnContent` | `'headers' \| 'full'` | `headers` | what a DSN returns |
| `limits.maxMessageSize` | `number` | 25 MiB | `MESSAGE_TOO_BIG` past it |
| `limits.maxRecipients` | `number` | 100 | `TOO_MANY_RECIPIENTS` past it |
| `limits.maxItems` | `number` | none | `QUEUE_FULL` past it |
| `limits.maxReplyText` | `number`, 64–900 | 512 | characters of a reply kept |
| `limits.maxDsnReturn` | `number` | 64 KiB | bytes of the original a DSN returns |
| `concurrency` | `number` | 20 | items at once, per worker |
| `perDomain` | `number` | 2 | sessions at once to one domain, per worker |
| `leaseMs` | `number`, ≥ 1000 | 10 minutes | a claim's lease |
| `pollInterval` | `number` | 5000 | ms between passes of `start()` |
| `owner` | `string` | a random UUID | this worker's name on its leases |
| `clock` | `{ now(): number }` | `Date.now` | the time |
| `send` | `Sender` | `sendMail` | delivers one session |
| `random` | `() => number` | `Math.random` | the jitter |
