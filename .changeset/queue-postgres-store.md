---
'@bumail/queue': minor
---

Add `@bumail/queue/postgres`: `PostgresQueueStore`, the `QueueStore` contract on PostgreSQL through Bun's own `Bun.sql`, so instances of a server on several machines share one queue with no driver to install. `PostgresQueueStore.open({ sql, tablePrefix? })` takes a `Bun.SQL` client or a `postgres://` URL; a claim is one `UPDATE … RETURNING` whose item a `SELECT … FOR UPDATE SKIP LOCKED` picks, so two instances never take the same item, and a crashed instance's items are claimed again once their leases expire. The tables, the `bun:sqlite` store's with the message as `bytea`, are made by `migrate()` or on first use, once however many instances start together.

A reply's text cut at `limits.maxReplyText` no longer ends inside a surrogate pair, and a lone surrogate in it becomes U+FFFD. The queue now also cleans every reply's `host` as it cleans the text: control characters replaced, a lone surrogate as U+FFFD, cut at 255 characters.

**Breaking for code that calls a `QueueStore` directly** (a store of your own driven by hand, or `MemoryQueueStore` and `SqliteQueueStore` called outside `createQueue`): every store — memory and `bun:sqlite` included, not only PostgreSQL — now refuses, as `INVALID`:

- a reply in `complete`'s recipients that is not an object with a string `text` (`A reply is an object with a text`), or whose `status` or `host` is not a string (`reply.status must be a string`, `reply.host must be a string`);
- a NUL or a lone surrogate in `from`, in any address of `to`, in a recipient's address, in `owner`, or in a reply's `text`, `status` or `host` (`… holds a NUL or a lone surrogate, which a store cannot keep`);

and treats an id holding a NUL or a lone surrogate as unknown. `createQueue` refuses such an `owner` too. What `createQueue` hands a store always passes these checks.
