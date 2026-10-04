---
'@bumail/queue': patch
---

`@bumail/queue/postgres` runs every transaction that writes (claim, renewal, outcome, add, reschedule, cancel, migration) at `READ COMMITTED`, whatever the client's sessions default to: with a client whose `default_transaction_isolation` is `repeatable read` or `serializable`, concurrent writes failed with SQLSTATE 40001, instances migrating together failed, and `limits.maxItems` could let more items in than its limit.

An item whose message the store no longer gives (a Redis key evicted or deleted, a row removed by hand) no longer stays leased and is claimed again at every lease, forever: its pending recipients fail at once as `5.3.0`, `Message unreadable: the queue store holds the item but not its message`, the `error` event gets a `QueueError` of the new code `MESSAGE_UNREADABLE`, and the failure DSN goes to the sender without the original (never for a message from `<>`).

`The PostgreSQL queue cannot be set up: …` and `The Redis queue cannot be set up: …` mask the password should the database's reason repeat it (the URL's, or a given `Bun.SQL` client's). A password under 4 characters is now masked only where a URL holds it (`:…@`), so a reason is no longer garbled by masking a single letter everywhere.
