# Roadmap

What bumail is building toward: a mail server native to Bun — SMTP in and
out, DKIM / SPF / DMARC, mailboxes read over IMAP, then JMAP — as `@bumail/*` packages
with no runtime dependency, and a server app on
[alxia](https://github.com/softistx/alxia) that wires them together.

No dates. Each entry says what someone running or embedding the server gets.

## Now

- **`@bumail/imap`, IMAP4rev2** (RFC 9051), for the mail clients that do
  not speak JMAP. Its first slice — login only over TLS, LIST with
  special-use, SELECT, FETCH, STORE, COPY, MOVE, EXPUNGE, SEARCH, APPEND
  and IDLE, serving any `@bumail/store` — is published in 0.1.0.
  CONDSTORE, QRESYNC, UIDPLUS and BINARY follow.
- **`@bumail/auth`, DKIM, SPF and DMARC** — DKIM signing and verifying
  (RFC 6376) is published in 0.1.0, SPF checking (RFC 7208) in 0.2.0.
  DMARC (RFC 7489) evaluation with its policy and disposition, and the
  `Authentication-Results` header (RFC 8601), are merged, not yet
  published. Everything looks up through `@bumail/dns` and answers in
  RFC 8601's words. DMARC reports and ARC follow in the same package.

## Next

- **`@bumail/smtp`, connection reuse** — several messages to one
  destination over one session, for the queue to deliver in batches.
- **A blob store, apart from the mailbox store** — message bytes kept
  apart from their metadata, behind one small contract: put as a stream,
  get and delete, by account and hash. Three answers: the disk through
  `Bun.file`, S3 through `@nxgt/s3`, and GridFS through
  `@nxgt/mongo/gridfs`. Each mailbox store keeps its bytes in whichever
  the operator picks.
- **`@bumail/store-postgres`** — the store contract on PostgreSQL, for a
  server that runs on several machines: peers on `@nxgt/drizzle` and
  `drizzle-orm`, with message bytes on S3 or the disk. It runs the same
  contract specs as the memory store. It comes before MongoDB.
- **`@bumail/store-mongo`** — the store contract on MongoDB: peers on
  `@nxgt/mongo`, `mongodb` and `zod`, with message bytes on GridFS or S3,
  at the operator's choice. It needs a replica set, since UIDs and modseqs
  are allotted in transactions. The same contract specs again.
- **`@bumail/queue`** — outbound mail with retries and back-off, a deferred
  and a failed state, bounces and delivery status notifications (RFC 3464).
  A contract with a memory and a `bun:sqlite` answer, like the store.
- **`@bumail/jmap`** — mailbox access over JMAP (RFC 8620 core, RFC 8621
  mail), as an alxia app. IMAP comes first, in Now, since real mail
  clients speak IMAP; JMAP is HTTP and JSON, so alxia gives it routing,
  validation and its typed client for free.
- **The server app** — SMTP on 25 and submission on 587,
  the queue, and the store served over IMAP and JMAP, wired together; an admin API for domains,
  accounts, aliases and DKIM keys; health and metrics. It starts once
  `@alxia/core` is on npm: it consumes alxia's published packages, not a
  link to its working tree, so bumail's CI never depends on another
  repository's checkout.

## Later

- **Sieve** filtering (RFC 5228) at delivery.
- **Spam scoring hooks and greylisting** — hooks a scorer plugs into, and
  greylisting on the queue's store; no classifier of our own.
- **MTA-STS (RFC 8461) and TLS-RPT (RFC 8460)** for outbound TLS policy.
- **ARC** (RFC 8617), for forwarded mail that keeps its authentication.
- **Rate limits per sender**, on submission.
- **Webhooks** on delivery, bounce and inbound mail.
- **A transport for `@nxgt/mail`**, so an app that sends with it can hand
  mail to a bumail server's queue directly.

## Not planned

- **POP3** — JMAP and IMAP cover every client worth supporting, and POP3
  would be a third access protocol to secure and test.
- **A webmail interface** — bumail is the server; a client builds on JMAP.
- **DANE** (RFC 7672) — it needs DNSSEC validation, which `node:dns` does
  not give; MTA-STS covers outbound TLS policy instead.
- **A built-in spam classifier** — scoring stays behind a hook, so the
  choice of scorer is the operator's.
- **Relaying without authentication** — not even as an option.

## Shipped

### Unreleased — merged, not yet published

- **`@bumail/auth`, DMARC and `Authentication-Results`** — `checkDmarc`:
  the From domain's policy, found there or at its organizational domain
  (an embedded Public Suffix List), DKIM and SPF aligned with From, `pct`
  and the disposition; a message whose author cannot be told for certain
  (no From, several, or one that does not parse) gets `permerror` with
  disposition `reject`. `formatAuthenticationResults` writes the three results as one field.

### Published since 0.1.0

- **`@bumail/store` on `bun:sqlite`**, as `@bumail/store/sqlite` — the same
  contract on disk, held to the same specs, with message bodies as blobs on
  disk addressed by their hash. One process per database, and every write
  flushed to disk before it is acknowledged.
- **`@bumail/auth`, SPF** — `checkSpf`, RFC 7208's `check_host()` for the
  client IP and the MAIL FROM or HELO domain: every mechanism, `redirect=`,
  `exp=`, the macros, the lookup limits and a timeout, never a throw for a
  record.
- **`@bumail/smtp`, the client**, as `@bumail/smtp/client` — `sendMail`
  delivers one message to a smarthost, a submission server or a domain's
  MX hosts (looked up through `@bumail/dns` or any resolver of that
  shape, with the null MX honoured): STARTTLS, opportunistic or required,
  implicit TLS, AUTH only once the certificate checked out, PIPELINING, SIZE, 8BITMIME and SMTPUTF8, the
  message streamed and dot-stuffed, a bare line break refused. Every
  failure says whether it is temporary, for the queue to come; every reply
  and every wait is bounded against a hostile server. *Kept in the same
  package as the server, on its own subpath*: both share the grammar.
- **`@bumail/imap`, the first slice** — IMAP4rev2 (RFC 9051) on
  `Bun.listen`, serving any `@bumail/store`: STARTTLS and implicit TLS,
  login only once encrypted, LIST with special-use, SELECT, FETCH, STORE,
  COPY, MOVE, EXPUNGE, SEARCH, APPEND and IDLE, with every command and
  hang-up bounded.

### 0.1.0 — published

- **`@bumail/auth`, DKIM** — signing and verifying (RFC 6376):
  rsa-sha256 and ed25519-sha256 (RFC 8463) through Web Crypto, simple and
  relaxed canonicalisation, a streamed body, key lookups through
  `@bumail/dns`, results in RFC 8601's words.

- **`@bumail/mime`** — read and write e-mail messages. RFC 5322 headers,
  encoded-words (RFC 2047) and parameter continuations (RFC 2231),
  multipart, base64 and quoted-printable, any charset `TextDecoder` knows,
  and a streaming parser that walks a large message without holding it in
  memory. Its specs are the RFCs' own examples.
- **`@bumail/smtp`, the server** — RFC 5321 on `Bun.listen`: EHLO with
  PIPELINING, SIZE, 8BITMIME, SMTPUTF8 and ENHANCEDSTATUSCODES; STARTTLS and
  implicit TLS; AUTH PLAIN and LOGIN, offered only once encrypted; hooks for
  connect, MAIL FROM, RCPT TO and DATA where the app accepts or refuses;
  size limits and timeouts. Delivery goes through the `onData` hook — into
  `@bumail/store`, or wherever the app keeps mail — and the server
  **refuses to relay without AUTH** in every default.
- **`@bumail/store`, its contract and memory store** — accounts,
  mailboxes with the IANA roles and a subscription, messages with one id
  across mailboxes, a thread and a UID in each, flags, and the changes
  since a modseq, for the account or one mailbox, behind one interface,
  every call scoped to one account. It is where the SMTP server's
  `onData` delivers.
- **`@bumail/dns`** — the DNS answers the other packages need (MX, TXT,
  A, AAAA, PTR) behind one small interface: `node:dns` in production, a
  fixture in specs, with a cache that honours TTLs. *Its own package*:
  SPF, DKIM, DMARC, the SMTP client and MTA-STS all query DNS, and each
  spec needs a deterministic answer instead of the Internet.
