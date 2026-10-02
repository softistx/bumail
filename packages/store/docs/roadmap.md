# Roadmap

What `@bumail/store` gives a mail server, and what is coming. This page is
a direction, not a commitment: the version something shipped in is the
only number on it.

## Now

- **The contract and its memory store** — accounts, mailboxes with roles
  and a hierarchy, messages with UIDs and modseqs, flags, copies and moves,
  and the changes since a modseq, for IMAP and JMAP to sync from.

## Next

- **A `bun:sqlite` store** — the same contract on disk, message content as
  files addressed by their hash, held to the same specs.
- **Searching and sorting** what IMAP's `SEARCH` and JMAP's `Email/query`
  need, once those protocols land.

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
