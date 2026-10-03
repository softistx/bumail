# @bumail/queue

The outbound queue of a mail server: it keeps every message your server
sends to another one, delivers it through `@bumail/smtp/client`, retries
what failed for now, and sends a delivery status notification (RFC 3464)
back when it gives up. Each recipient has its own state, the queue
survives a restart on `bun:sqlite`, and several workers can share one
queue. No runtime dependency: only peers.

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

// The message as it leaves: whole, headers first, CRLF, already DKIM-signed
// (with @bumail/auth's signDkim, say).
const signedMessage = await Bun.file('outgoing.eml').bytes();
const item = await queue.enqueue(signedMessage, {
	from: 'mary@example.net',
	to: ['joe@example.com', 'ann@example.org'],
});
item.recipients; // [{ address: 'joe@example.com', status: 'pending' }, …]

process.on('SIGTERM', () => queue.stop()); // lets deliveries under way end
```

The message is a `Uint8Array`, a string or a `ReadableStream<Uint8Array>`,
with CRLF line ends: a bare CR or LF is refused, as `sendMail` would
refuse it. Every address is checked as one `sendMail` takes
(`@bumail/smtp/client`'s `isMailbox`: an RFC 5321 Mailbox with no source
route, no control character (C0, DEL or C1), no `>`, no U+2028 or U+2029,
no Unicode format character (`\p{Cf}`), no lone surrogate and no IPv4
literal octet above 255), so a bad one is refused at `enqueue`, never at
delivery.
Delivery groups the recipients by domain: one session per domain per
attempt, with STARTTLS when offered.

## Retries and bounces

A 4xx, a connection error or a timeout leaves the recipient `deferred`;
the queue tries it again after 30 minutes, then 1 hour, 2, 4, and every 4
hours, each plus up to 10% of jitter, and gives up after 5 days
(RFC 5321 §4.5.4.1). A 5xx fails the recipient at once.

```ts
import { nodeResolver } from '@bumail/dns';
import { createQueue } from '@bumail/queue';
import { MemoryQueueStore } from '@bumail/queue/memory';

const queue = createQueue({
	store: new MemoryQueueStore(),
	hostname: 'mail.example.net',
	resolver: nodeResolver(),
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
import { createQueue } from '@bumail/queue';
import { MemoryQueueStore } from '@bumail/queue/memory';

const smtpPassword = (await Bun.file('/run/secrets/smtp').text()).trim(); // from your secrets
createQueue({
	store: new MemoryQueueStore(),
	hostname: 'mail.example.net',
	// Port 25 blocked? Everything through a provider's submission port:
	route: {
		host: 'smtp.provider.example',
		port: 587,
		auth: { username: 'mary@example.net', password: smtpPassword },
	},
	// …or only some domains, the rest by MX (which needs the resolver):
	routes: { 'partner.example': { host: 'relay.partner.example' } },
});
```

`route` defaults to `'mx'`: each recipient domain's own mail hosts.
Credentials go only over TLS whose certificate checked out: `createQueue`
refuses `auth` with a `tls` other than `'required'`, and checks the ports,
the TLS modes and the timeouts as `sendMail` would. A route `sendMail`
still refuses (`INVALID_OPTION`) defers its recipients as `4.3.5` and
says so on the `error` event; it does not bounce them until
`retry.giveUpAfter`, when they fail as `4.4.7` with a DSN like any
deferred recipient.

## Several workers

```ts
import { nodeResolver } from '@bumail/dns';
import { createQueue } from '@bumail/queue';
import { SqliteQueueStore } from '@bumail/queue/sqlite';

// In each process, on the same directory: a claim leases an item to one worker.
const queue = createQueue({
	store: SqliteQueueStore.open({ directory: '/var/lib/bumail/queue' }),
	hostname: 'mail.example.net',
	resolver: nodeResolver(),
});
queue.start();
```

A worker claims a due item with a lease, renews it while it delivers, and
lets go of it with the outcome; a renewal that fails is told on `error`
and tried again. If it crashes, another worker claims the item once the
lease expires (`leaseMs`, 10 minutes by default). A directory the store
makes is 0700; one that exists keeps its mode.
`concurrency` (20) bounds the items one worker delivers at once — each
item opens one session per recipient domain — and `perDomain` (2) its
sessions to one recipient domain.

## Events and admin

```ts
// queue: the one created under Usage.
queue.on('delivered', ({ id, recipient, reply }) => console.info({ id, recipient, reply }));
queue.on('deferred', ({ recipient, reply, nextAttemptAt }) => {});
queue.on('failed', ({ recipient, reply }) => {}); // reply: { code?, status?, text, host? }
queue.on('dsn', ({ kind, of, to }) => {});
queue.on('error', ({ error, id }) => console.error(id, error)); // the store, a lost lease, a bad route

const [next] = await queue.list({ limit: 50 }); // the next due first
if (next) await queue.retryNow(next.id); // false while a worker delivers it
if (next) await queue.cancel(next.id); // no DSN
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

```ts
import { nodeResolver } from '@bumail/dns';
import { createQueue } from '@bumail/queue';
import { MemoryQueueStore } from '@bumail/queue/memory';

createQueue({
	store: new MemoryQueueStore(),
	hostname: 'mail.example.net',
	resolver: nodeResolver(),
	limits: { maxMessageSize: 10 * 1024 * 1024, maxRecipients: 50, maxItems: 100_000 },
});
```

Everything is bounded, through `limits`: the message (25 MiB), the
recipients per message (100), the items in the store (none by default),
the reply text kept per recipient (512 characters, control characters
replaced by spaces), and the original a DSN returns (64 KiB, each line cut
at 998 bytes). Nothing a
remote server says reaches a DSN's header fields with a CR, an LF or a
control character in it.

## Traps

- **Bun only.** The store on disk uses `bun:sqlite`, so the package runs
  on Bun 1.4.2 or later, not on Node.
- **It sends what you enqueue, to anyone.** The queue is not a relay
  policy: enqueue only what an authenticated user submitted, or what your
  own server writes, never what an unauthenticated client handed you.

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
