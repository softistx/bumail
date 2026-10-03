---
'@bumail/store': minor
---

Adds `@bumail/store/sqlite`, a `bun:sqlite` answer to the contract: `SqliteMailStore.open({ directory, maxTombstones? })` keeps accounts, mailboxes and messages in one directory, with content as blobs named by their hash, every write flushed to disk before it is acknowledged, and one process per database. The main entry still never imports `bun:sqlite`.
