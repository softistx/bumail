---
'@bumail/queue': minor
---

Add `@bumail/queue/postgres`: `PostgresQueueStore`, the `QueueStore` contract on PostgreSQL through Bun's own `Bun.sql`, so instances of a server on several machines share one queue with no driver to install. `PostgresQueueStore.open({ sql, tablePrefix? })` takes a `Bun.SQL` client or a `postgres://` URL; a claim is one `UPDATE … RETURNING` whose item a `SELECT … FOR UPDATE SKIP LOCKED` picks, so two instances never take the same item, and a crashed instance's items are claimed again once their leases expire. The tables, the `bun:sqlite` store's with the message as `bytea`, are made by `migrate()` or on first use, once however many instances start together.
