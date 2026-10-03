# Roadmap

What `@bumail/store` gives a mail server, and what is coming. This page is
a direction, not a commitment: the version something shipped in is the
only number on it.

## Now

Nothing in progress: the next entry is picked from Next.

## Next

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
  `bun:sqlite` store uses Bun's own SQLite.
- **Parsing messages in the store.** A store keeps bytes; `@bumail/mime`
  reads them.

## Shipped

### Unreleased — merged, not yet published

- **A `bun:sqlite` store**, as `@bumail/store/sqlite` — the same contract
  on disk, held to the same specs: `SqliteMailStore.open({ directory })`
  and `close()`. One process opens a database at a time; every write is
  flushed to disk before it is acknowledged; message content is kept as
  files addressed by their hash, read lazily; directories are 0700 and
  files 0600; what a crash leaves behind is swept on open, and the schema
  migrates itself, refusing a newer one.

### 0.1.0

- **The contract and its memory store** — accounts; mailboxes with the
  IANA roles, a hierarchy and a subscription; messages that keep one id
  across mailboxes (JMAP's Email), a thread, and a UID in each mailbox
  (IMAP); content given and read as a stream, kept per account; every call
  scoped to one account, so an id is no key to another's mail; every
  message of an account, a page at a time; flags with RFC 7162's
  conditional store; copies, links and moves that skip and name the ids
  already gone; and the message and mailbox changes since a modseq, paged,
  for the account or one mailbox, for IMAP's CONDSTORE and QRESYNC and
  JMAP's `/changes` to sync from.
