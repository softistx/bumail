---
"@bumail/store": minor
---

A PostgreSQL store, as `@bumail/store/postgres`: `PostgresMailStore.open({ sql, tablePrefix?, maxTombstones? })` answers the `MailStore` contract on PostgreSQL through Bun's own `Bun.sql`, for a mail server that runs as several instances sharing one store. Every write locks its account's row first, so modseqs and UIDs are given once each and in order from any instance; `migrate()` makes the tables, and a role without `CREATE` runs the store once they are made. Message bytes are kept as `bytea`, once per distinct bytes in an account; the changes and the account's pages are cut in the database. No dependency: `Bun.sql` is Bun's own.
