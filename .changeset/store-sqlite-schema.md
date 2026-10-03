---
---

Internal groundwork for a `bun:sqlite` store in `@bumail/store`: its schema and migrations, opening a directory, writing blobs, accounts and mailboxes, kept out of the build. The memory store's mailbox and account checks move into shared modules both stores call; its behaviour and every error are unchanged.
