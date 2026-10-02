---
"@bumail/store": minor
---

The first release of `@bumail/store`: the `MailStore` contract and `MemoryMailStore`, its answer in memory.

- Accounts; mailboxes with roles, a hierarchy through `parentId`, `INBOX` case-insensitive.
- Messages with one id for their life, in one mailbox or several, with a UID in each; content given as bytes or a stream, read back as a `Blob`.
- Flags, keywords in lowercase, and RFC 7162's `unchangedSince`.
- IMAP COPY, MOVE and EXPUNGE, and JMAP's links and destroys.
- `messageChanges` and `mailboxChanges` since a modseq, paged with `limit`, with the expunged UIDs for QRESYNC.
- Every call all or nothing; nothing returned shared with what the store keeps.
