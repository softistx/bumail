# Roadmap

What `@bumail/imap` gives a mail server, and what is coming. This page is a
direction, not a commitment: the version something shipped in is the only
number on it.

## Now

The second slice:

- **CONDSTORE and QRESYNC** (RFC 7162) — a client that reconnects asks
  for what changed since the modseq it saw, instead of fetching every
  flag again. The store already keeps the modseqs.
- **UIDPLUS** (RFC 4315) — `APPENDUID` and `COPYUID`, so a client knows
  the UID of a message it appended, copied or moved without searching.
- **BINARY** (RFC 3516) — parts decoded by the server, and APPEND of
  8-bit messages.
- **Real clients, tested** — Thunderbird, Apple Mail and a command-line
  client run against the server, and what they trip on fixed.

## Next

- **A ready-made delivery from `@bumail/smtp`** that calls
  `server.notify()`, so new mail reaches IDLE at once without polling.

## Later

- **SEARCHRES** (RFC 5182), **MULTIAPPEND** (RFC 3502), **QUOTA**
  (RFC 9208), **METADATA** (RFC 5464), **COMPRESS=DEFLATE** (RFC 4978).
- **NOTIFY** (RFC 5465) — changes in mailboxes other than the selected one.
- **RENAME INBOX**, which moves its messages to the new mailbox.
- **SEARCH that decodes** base64 and quoted-printable bodies before
  matching.
- **SCRAM-SHA-256** (RFC 7677) beside PLAIN.

## Not planned

- **LOGIN on a clear connection** — not as a default, not as an option.
  The password would cross the network as written.
- **`\Recent`** — RFC 9051 dropped it; it is always 0 for IMAP4rev1
  clients.
- **Shared and other users' namespaces** — NAMESPACE says there are none;
  sharing is the store's question, and JMAP's.

## Shipped

### Unreleased — merged, not yet published

- **The first slice** — what Thunderbird and Apple Mail need to log in,
  list folders, read messages and set flags: STARTTLS and implicit TLS,
  LOGIN and AUTHENTICATE PLAIN only once encrypted, LIST with SPECIAL-USE
  and the LIST-EXTENDED basics, SELECT and EXAMINE, FETCH of envelopes,
  body structures and sections, STORE, COPY, MOVE, EXPUNGE, SEARCH with
  ESEARCH, APPEND streamed into the store, and IDLE. Every input is
  bounded, and a client that stops reading is still cut at its timeout.
