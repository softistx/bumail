# Roadmap

What `@bumail/store` gives a mail server, and what is coming. This page is
a direction, not a commitment: the version something shipped in is the
only number on it.

## Now

- **The contract and its memory store** — waiting for the owner's first
  publish. Accounts; mailboxes with the IANA roles, a hierarchy and a
  subscription; messages that keep one id across mailboxes (JMAP's Email),
  a thread, and a UID in each mailbox (IMAP); content given and read as a
  stream, kept per account; every message of an account, a page at a
  time; flags with RFC 7162's conditional store; copies, links and moves
  that skip and name the ids already gone; and the message and mailbox
  changes since a modseq, paged, for IMAP's CONDSTORE and QRESYNC and
  JMAP's `/changes` to sync from.

## Next

- **A `bun:sqlite` store** — the same contract on disk, message content as
  files addressed by their hash, held to the same specs.
- **Searching and sorting** what IMAP's `SEARCH` and JMAP's `Email/query`
  need, once those protocols land.
- **The contract's specs, exported**, so a store written outside this
  package can hold itself to them.
- **Uploaded blobs** — content stored before it is a message, as JMAP's
  upload and `Email/import` need.

## Later

- **Quotas** per account (RFC 9208), counted by the store.
- **Shared mailboxes** and access rights (RFC 4314).

## Not planned

- **A runtime dependency.** The memory store needs none, and the
  `bun:sqlite` store will use Bun's own SQLite.
- **Parsing messages in the store.** A store keeps bytes; `@bumail/mime`
  reads them.

## Shipped

Nothing yet.
