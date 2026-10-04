# Roadmap

What `@bumail/store` gives a mail server, and what is coming. This page is
a direction, not a commitment: the version something shipped in is the
only number on it.

## Now

Nothing in progress: the next entry is picked from Next. The PostgreSQL
store is merged (see Shipped).

## Next

- **Message bytes outside PostgreSQL** — the PostgreSQL store keeps
  them as `bytea` in the database; once the repository's blob store
  lands (put, get and delete by account and hash, on the disk or in
  S3), it can keep them there instead, its rows naming them.
- **Searching and sorting** what IMAP's `SEARCH` and JMAP's `Email/query`
  need, which `@bumail/imap` and `@bumail/jmap` do on their own today.
- **The contract's specs, exported**, so a store written outside this
  package can hold itself to them.
- **Uploaded blobs** — content stored before it is a message, as JMAP's
  upload and `Email/import` need.

## Later

- **Quotas** per account (RFC 9208), counted by the store.
- **Shared mailboxes** and access rights (RFC 4314).

## Not planned

- **A runtime dependency.** The memory store needs none, the
  `bun:sqlite` store uses Bun's own SQLite, and the PostgreSQL store
  Bun's own `Bun.sql`.
- **Parsing messages in the store.** A store keeps bytes; `@bumail/mime`
  reads them.

## Shipped

### Unreleased — merged, not yet published

- **A PostgreSQL store**, as `@bumail/store/postgres`, on Bun's own
  `Bun.sql`, for a mail server that runs as several instances sharing
  one store: `PostgresMailStore.open({ sql })` takes a `Bun.SQL` client,
  or a `postgres://` URL, and needs no driver. Every write locks its
  account's row first, so modseqs and UIDs are given once each, in
  order, from any instance, and a client following the changes misses
  none; `migrate()` makes the tables, and a role with no `CREATE` runs
  the store once they are made. Message bytes are `bytea`, once per
  distinct bytes in an account. The changes and the account's pages are
  cut in the database. Held to the same contract specs as the memory and
  `bun:sqlite` stores, to specs of two instances writing at once, and to
  random histories compared with the memory store's answers.

### 0.3.0

- **Keywords keep the case they were stored with** — `$Forwarded`,
  `$MDNSent`, `NonJunk` — in the memory and the SQLite stores alike, and
  still compare without case (RFC 9051 §2.3.2): a message never holds two
  that differ only by case. Serve it with `@bumail/imap` 0.1.1 or later.

### 0.2.0

- **A `bun:sqlite` store**, as `@bumail/store/sqlite` — the same contract
  on disk, held to the same specs: `SqliteMailStore.open({ directory })`
  and `close()`. One process opens a database at a time; every write is
  flushed to disk before it is acknowledged; message content is kept as
  files addressed by their hash, read lazily; directories are 0700 and
  files 0600; what a crash leaves behind is swept on open, and the schema
  migrates itself, refusing a newer one.
- **How long a content `Blob` stays valid**, stated by the contract:
  until its message leaves the account.

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
