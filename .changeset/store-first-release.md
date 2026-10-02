---
"@bumail/store": minor
---

The first release of `@bumail/store`: the `MailStore` contract and `MemoryMailStore`, its answer in memory.

- Accounts; mailboxes with the IANA roles (RFC 6154, RFC 8457), a hierarchy through `parentId`, a subscription, `INBOX` case-insensitive.
- Messages with one id and one thread for their life, in one mailbox or several, with a UID in each; content given as bytes or a stream, kept per account, read back as a `Blob`; every message of an account with `listAccountMessages`.
- Flags, keywords in lowercase, and RFC 7162's `unchangedSince`.
- IMAP COPY, MOVE and EXPUNGE, and JMAP's links and destroys; an id already gone is skipped and listed in `notFound`.
- `messageChanges` and `mailboxChanges` since a modseq, paged with `limit`, with the expunged UIDs for QRESYNC; since 0 always gives the whole state.
- Every call all or nothing; nothing returned shared with what the store keeps.
