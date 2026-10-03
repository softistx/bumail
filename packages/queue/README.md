# @bumail/queue

The outbound queue of a mail server: it keeps every message your server
sends to another one, delivers it through `@bumail/smtp/client`, retries
what failed for now, and sends a delivery status notification (RFC 3464)
back when it gives up. Each recipient has its own state, the queue
survives a restart on `bun:sqlite`, and several workers can share one
queue. No dependency.

**Bun only**: the store on disk uses `bun:sqlite`, so it runs on Bun 1.4.2
or later, not on Node.

**It sends what you enqueue, to anyone.** The queue is not a relay policy:
enqueue only what an authenticated user submitted, or what your own server
writes, never what an unauthenticated client handed you.

## Install

```sh
bun add @bumail/queue @bumail/smtp @bumail/mime
bun add @bumail/dns   # for direct delivery by MX: the resolver
```

`@bumail/smtp` (its client) and `@bumail/mime` (for the DSNs) are required
peers. `@bumail/dns` is optional: any resolver of its shape will do, and a
queue that only uses a smarthost needs none.

## Subpaths

| import | what it gives |
| --- | --- |
| `@bumail/queue` | `createQueue`, the `QueueStore` contract, `QueueError` and the types |
| `@bumail/queue/memory` | `MemoryQueueStore`: in memory, lost on a restart — for specs and trials |
| `@bumail/queue/sqlite` | `SqliteQueueStore`: on disk with `bun:sqlite`, shared by the processes of one machine |

## Usage

```ts
import { nodeResolver } from '@bumail/dns';
import { createQueue } from '@bumail/queue';
import { SqliteQueueStore } from '@bumail/queue/sqlite';

const queue = createQueue({
	store: SqliteQueueStore.open({ directory: '/var/lib/bumail/queue' }),
	hostname: 'mail.example.net', // your public name: EHLO, and the DSN's Reporting-MTA
	resolver: nodeResolver(),
});
queue.start();

// The message as it leaves: whole, headers first, CRLF, already DKIM-signed.
const item = await queue.enqueue(signedMessage, {
	from: 'mary@example.net',
	to: ['joe@example.com', 'ann@example.org'],
});
item.recipients; // [{ address: 'joe@example.com', status: 'pending' }, …]

process.on('SIGTERM', () => queue.stop()); // lets deliveries under way end
```

The message is a `Uint8Array`, a string or a `ReadableStream<Uint8Array>`.
Delivery groups the recipients by domain: one session per domain per
attempt, with STARTTLS when offered.

## Retries and bounces

A 4xx, a connection error or a timeout leaves the recipient `deferred`;
the queue tries it again after 30 minutes, then 1 hour, 2, 4, and every 4
hours, each plus up to 10% of jitter, and gives up after 5 days
(RFC 5321 §4.5.4.1). A 5xx fails the recipient at once.

```ts
const queue = createQueue({
	store,
	hostname: 'mail.example.net',
	resolver,
	retry: { first: 15 * 60_000, giveUpAfter: 3 * 24 * 3_600_000 },
	dsn: { delayAfter: 4 * 3_600_000, returnContent: 'headers' },
});
```

A failed recipient gets a DSN back to the sender, a `multipart/report`
with the original's header fields; a recipient still deferred after
`delayAfter` gets one "delayed" warning. A DSN is enqueued from the null
sender `<>`, and a message from `<>` never causes one.

## Routing

```ts
createQueue({
	store,
	hostname: 'mail.example.net',
	// Port 25 blocked? Everything through a provider's submission port:
	route: {
		host: 'smtp.provider.example',
		port: 587,
		auth: { username: 'mary@example.net', password: smtpPassword }, // from your secrets
	},
	// …or only some domains, the rest by MX (which needs the resolver):
	routes: { 'partner.example': { host: 'relay.partner.example' } },
});
```

`route` defaults to `'mx'`: each recipient domain's own mail hosts.
Credentials go only over TLS whose certificate checked out.

## Several workers

```ts
// In each process, on the same directory: a claim leases an item to one worker.
const queue = createQueue({ store: SqliteQueueStore.open({ directory }), hostname, resolver });
queue.start();
```

A worker claims a due item with a lease, renews it while it delivers, and
lets go of it with the outcome. If it crashes, another worker claims the
item once the lease expires (`leaseMs`, 10 minutes by default).
`concurrency` (20) bounds the items one worker delivers at once,
`perDomain` (2) its sessions to one recipient domain.

## Events and admin

```ts
queue.on('delivered', ({ id, recipient, reply }) => log.info({ id, recipient, reply }));
queue.on('deferred', ({ recipient, reply, nextAttemptAt }) => {});
queue.on('failed', ({ recipient, reply }) => {}); // reply: { code?, status?, text, host? }
queue.on('dsn', ({ kind, of, to }) => {});
queue.on('error', ({ error, id }) => log.error(error)); // the store, a lost lease

await queue.list({ limit: 50 }); // the next due first
await queue.retryNow(item.id);
await queue.cancel(item.id); // no DSN
```

## Testing

```ts
import { createQueue, type Sender } from '@bumail/queue';
import { MemoryQueueStore } from '@bumail/queue/memory';

let now = Date.UTC(2026, 0, 1);
const send: Sender = async (_message, options) => ({
	accepted: [options.to].flat().map((recipient) => ({ recipient, reply: { code: 250, text: 'OK' } })),
	rejected: [],
	reply: { code: 250, text: 'Queued' },
	host: 'mx.test',
	port: 25,
	tls: false,
	authenticated: false,
});
const queue = createQueue({
	store: new MemoryQueueStore(),
	hostname: 'mail.test',
	route: { host: 'mx.test' },
	clock: { now: () => now },
	send,
});
await queue.enqueue('Subject: hi\r\n\r\nhello\r\n', { from: 'a@test', to: 'b@test' });
await queue.deliverDue(); // one pass, by hand: no timer, no network
now += 30 * 60_000;
```

## Limits

Everything is bounded, through `limits`: the message (25 MiB), the
recipients per message (100), the items in the store (none by default),
the reply text kept per recipient (512 characters, control characters
replaced by spaces), and the original a DSN returns (64 KiB). Nothing a
remote server says reaches a DSN's header fields with a CR, an LF or a
control character in it.

## API

| export | |
| --- | --- |
| `createQueue(options)`, `Queue` | the queue: `enqueue`, `deliverDue`, `start`, `stop`, `on`, `list`, `get`, `retryNow`, `cancel`, `owner` |
| `QueueOptions`, `Route`, `Smarthost`, `RetrySchedule`, `DsnOptions`, `QueueLimits`, `Clock`, `Sender` | what `createQueue` takes |
| `MessageSource`, `QueueEnvelope` | what `enqueue` takes |
| `QueueEvents`, `QueueListener`, `RecipientEvent`, `DeferredEvent`, `DsnEvent`, `QueueErrorEvent` | the events |
| `QueueStore` | the contract a store answers: `add`, `get`, `list`, `count`, `readMessage`, `claim`, `renew`, `complete`, `reschedule`, `cancel` |
| `QueueItem`, `RecipientState`, `RecipientStatus`, `FinalStatus`, `Diagnostic`, `Lease` | an item, and where each recipient stands |
| `NewQueueItem`, `AddOptions`, `ClaimRequest`, `AttemptResult`, `RecipientUpdate`, `QueueListOptions` | what a store takes |
| `QueueError`, `QueueErrorCode` | `INVALID`, `MESSAGE_TOO_BIG`, `TOO_MANY_RECIPIENTS`, `QUEUE_FULL`, `CLOSED`, `LEASE_LOST` |
| `MemoryQueueStore` | from `@bumail/queue/memory` |
| `SqliteQueueStore`, `SqliteQueueStoreOptions` | from `@bumail/queue/sqlite`: `SqliteQueueStore.open({ directory, busyTimeout? })`, `close()` |

## Documentation

These pages ship in the package, under `docs/`.

- [Index](https://github.com/softistx/bumail/blob/develop/packages/queue/docs/README.md): the pages, and when to read each.
- [Guide](https://github.com/softistx/bumail/blob/develop/packages/queue/docs/guide.md): enqueuing, delivery and routing, the retry schedule, DSNs, several workers and leases, events and admin, the stores, testing, and writing a store of your own.
- [Troubleshooting](https://github.com/softistx/bumail/blob/develop/packages/queue/docs/troubleshooting.md): every `QueueError`, and what to do about it.
- [Roadmap](https://github.com/softistx/bumail/blob/develop/packages/queue/docs/roadmap.md): what is coming, and what is not planned.
