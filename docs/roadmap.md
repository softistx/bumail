# Roadmap

What bumail is building toward: a mail server native to Bun — SMTP in and
out, DKIM / SPF / DMARC, mailboxes read over IMAP, then JMAP — as
`@bumail/*` packages with no runtime dependency, and a server app on
[alxia](https://github.com/softistx/alxia) that wires them together.

No dates. Each entry says what someone running or embedding the server gets.

## Now

- **`@bumail/imap`, the second slice** — the first slice is published in
  0.1.0 (see Shipped). What remains: CONDSTORE and QRESYNC (RFC 7162) for
  quick resync, UIDPLUS (RFC 4315), BINARY (RFC 3516), and interop checked
  with real mail clients. The store already keeps the UIDs, UIDVALIDITY and
  modseqs these need.
- **`@bumail/jmap`, the second slice** — the first slice is published in
  0.1.0 (see Shipped). What remains: queryChanges, push via EventSource,
  then Identity and EmailSubmission through `@bumail/smtp/client`. Any JMAP
  client speaks it; bumail ships no client of its own.
- **The server app, `@bumail/server`** — the packages wired into one
  process, run as the `bumail` command: SMTP on 25 (MX), 465
  (submission over implicit TLS) and 587 (submission with STARTTLS), IMAP
  on 993, JMAP over HTTPS on 443, the queue delivering out, and
  certificates obtained and renewed through ACME (HTTP-01 on port 80).
  **Never an open relay** — mail for a domain it does not host is taken
  only from an authenticated session — and **AUTH only after TLS**, for
  SMTP, IMAP and JMAP alike. Domains, accounts, aliases and DKIM keys
  managed by the command; a health check. It consumes alxia's published
  packages, not a link to its working tree, so bumail's CI never depends
  on another repository's checkout. In progress, and private until it
  serves mail: its configuration — one TOML file, checked whole by
  `bumail check-config`, the environment overriding URLs and secrets
  only — is merged, and so is its directory of domains, users and
  aliases (argon2id passwords, aliases to local users only), managed by
  `bumail domain`, `user` and `alias`; the steps that follow are in
  [its roadmap](../packages/server/docs/roadmap.md).

## Next

- **A Docker image, all in one** — the server app in one container: ports
  25, 465, 587, 993, 443 and 80, and one volume for the mail, the queue and
  the certificates. Its guide says what sending mail from a container
  takes: many cloud hosts and home connections block outbound port 25,
  and receiving servers distrust an address without reverse DNS (a PTR
  record naming the server, whose name resolves back to it). Where port 25
  is closed, or no PTR can be set, the queue sends through a smarthost —
  a relay provider on 587 or 465 — instead.
- **`@bumail/auth`, DMARC reports and ARC** — aggregate and failure
  reports to a domain's `rua=` and `ruf=` (RFC 7489 §7), and ARC
  (RFC 8617), so forwarded mail keeps its authentication. DKIM, SPF and
  DMARC themselves are in Shipped.
- **`@bumail/queue`, MTA-STS (RFC 8461) and TLS-RPT (RFC 8460)** for
  outbound TLS policy; then **DANE** (RFC 7672), once the queue can be
  given a resolver that validates DNSSEC, which `node:dns` does not.
- **Trying it end to end, first with Mailpit, then with a real mail
  client** — Mailpit, a local mail catcher, receives what bumail sends and
  shows each message with its headers (the DKIM signature included), and
  can release a caught message to bumail's MX on port 25. Now that
  submission and IMAP exist, a real mail client (Thunderbird, Apple Mail)
  logs in, sends and reads through bumail itself.
- **The DNS records a domain needs, written for you** — from a domain, its
  MX hosts, its sending IPs and its DKIM keys, the records to publish: MX,
  SPF (`v=spf1 …`), each DKIM key's TXT at `<selector>._domainkey`, DMARC
  at `_dmarc`, and later MTA-STS and TLS-RPT. As a BIND zone file, which
  Cloudflare, Route 53 and most DNS hosts import as is, and as plain
  records (name, type, value, TTL) for a provider's API. Each record value
  comes from the package that reads it — `@bumail/auth` writes the SPF,
  DKIM and DMARC values it would itself accept — and `@bumail/dns` writes
  the zone file. The server app's `bumail dns` prints them per domain.
- **`@bumail/smtp`, connection reuse** — several messages to one
  destination over one session, for the queue to deliver in batches.
- **A blob store, apart from the mailbox store** — message bytes kept
  apart from their metadata, behind one small contract: put as a stream,
  get and delete, by account and hash. Two answers: the disk through
  `Bun.file`, and S3 through `@nxgt/s3`. Each mailbox store keeps its
  bytes in whichever the operator picks; the PostgreSQL store, which
  keeps them in the database today, first.

## Later

- **Sieve** filtering (RFC 5228) at delivery.
- **Spam scoring hooks and greylisting** — hooks a scorer plugs into, and
  greylisting on the queue's store; no classifier of our own.
- **Rate limits per sender**, on submission.
- **Webhooks** on delivery, bounce and inbound mail.
- **A transport for `@nxgt/mail`**, so an app that sends with it can hand
  mail to a bumail server's queue directly.

## Not planned

- **POP3** — JMAP and IMAP cover every client worth supporting, and POP3
  would be a third access protocol to secure and test.
- **A built-in spam classifier** — scoring stays behind a hook, so the
  choice of scorer is the operator's.
- **Relaying without authentication** — not even as an option.
- **MongoDB** — neither for the mail store nor for the queue. Several
  instances already share their mail through the PostgreSQL store, and
  the queue can use that same database, or Redis: a MongoDB store would
  add maintenance and CI cost and nothing a deployment lacks.

## Shipped

### Published

- **`@bumail/store`, a PostgreSQL store**, in store 0.4.0, as
  `@bumail/store/postgres` — the store contract on PostgreSQL through
  Bun's own `Bun.sql`, so it peers on no driver, as the queue's does, for
  a server that runs as several instances sharing its mail. Every write
  locks its account's row first, so modseqs and UIDs are given once each
  and in order from any instance, and a client following the changes
  misses none. Message bytes are kept in the database for now; the blob
  store, under Next above, will let them live on the disk or in S3. Held
  to the same contract specs as the memory and `bun:sqlite` stores.
- **`@bumail/queue`, a Redis store**, in queue 0.3.0, as
  `@bumail/queue/redis` — the `QueueStore` contract on Redis through
  Bun's own `Bun.redis`, so several server instances, on several
  machines, share one queue with no driver to install. Every operation
  that writes is one Lua script, which Redis runs whole, so two instances
  never take the same item, and a crashed instance's items are claimed
  again once their leases expire. One Redis, or a primary with replicas,
  not Cluster; its durability is Redis's, as the queue's guide spells
  out.
- **`@bumail/queue`, a PostgreSQL store**, in queue 0.2.0, as
  `@bumail/queue/postgres` — the `QueueStore` contract on PostgreSQL
  through Bun's own `Bun.sql`, so several server instances, on several
  machines, share one queue with no driver to install. A claim is one
  `UPDATE … RETURNING` whose item a `SELECT … FOR UPDATE SKIP LOCKED`
  picks, so two instances never take the same item, and a crashed
  instance's items are claimed again once their leases expire. Its
  tables, the `bun:sqlite` store's, are made by `migrate()` or on first
  use, under a table prefix.

- **`@bumail/queue`, the first slice**, in queue 0.1.0 — outbound mail
  with each recipient's own state (pending, delivered, deferred, failed,
  with the last reply), delivered one session per domain through
  `@bumail/smtp/client`: by MX, through a smarthost (around a blocked port
  25) or by a route per domain, within a limit of items at once and of
  sessions to one domain. A 4xx, a connection error or a timeout is
  retried with exponential back-off and jitter (RFC 5321 §4.5.4.1: 30
  minutes at first, given up after 5 days); a 5xx fails at once. Delivery
  status notifications (RFC 3464) for a failure and for a delay, never
  about a bounce. A `QueueStore` contract with a memory and a `bun:sqlite`
  answer, like the store, built for several workers from the start: a
  claim leases an item to one worker, and a crashed worker's items are
  claimed again.
- **`@bumail/jmap`, the first slice**, in jmap 0.1.0 — mailbox access over
  JMAP (RFC 8620 core, RFC 8621 mail), as an alxia app on `@alxia/core`
  0.2.1 from npm, serving any `@bumail/store`: the session, the API with
  back-references, Mailbox, Email and Thread, blob download and upload,
  with every limit announced and enforced. IMAP came first, since real
  mail clients speak IMAP; JMAP is HTTP and JSON, so alxia gives it
  routing, validation and its typed client for free.
- **`@bumail/auth`, DMARC and `Authentication-Results`**, in auth 0.3.0 —
  `checkDmarc` (RFC 7489): the From domain's policy, found there or at its
  organizational domain (an embedded Public Suffix List), DKIM and SPF
  aligned with From, `pct` and the disposition; a message whose author
  cannot be told for certain (no From, several, a group, or one that is
  not exactly one mailbox) gets `permerror` with disposition `reject`.
  `formatAuthenticationResults` (RFC 8601) writes the three results as one
  field.
- **`@bumail/imap`, the first slice**, in imap 0.1.0 (0.1.2 now) —
  IMAP4rev2 (RFC 9051) on `Bun.listen`, serving any `@bumail/store`:
  STARTTLS and implicit TLS, login only once encrypted, LIST with
  special-use (RFC 6154), SELECT, FETCH, STORE, COPY, MOVE, EXPUNGE,
  SEARCH, APPEND and IDLE, with every command and hang-up bounded.
- **`@bumail/auth`, SPF**, in auth 0.2.0 — `checkSpf`, RFC 7208's
  `check_host()` for the client IP and the MAIL FROM or HELO domain: every
  mechanism, `redirect=`, `exp=`, the macros, the lookup limits and a
  timeout, never a throw for a record.
- **`@bumail/smtp`, the client**, as `@bumail/smtp/client`, in smtp 0.2.0
  (0.3.0 now) — `sendMail` delivers one message to a smarthost, a submission
  server or a domain's MX hosts (looked up through `@bumail/dns` or any
  resolver of that shape, with the null MX honoured), and `resolveMx` gives
  those hosts in order: STARTTLS, opportunistic or required, implicit TLS,
  AUTH only once the certificate checked out, PIPELINING, SIZE, 8BITMIME and
  SMTPUTF8, the message streamed and dot-stuffed, a bare line break refused.
  Every failure says whether it is temporary, for the queue; every reply and
  every wait is bounded against a hostile server. Since 0.2.1 an address
  with a source route or a control character is refused before it reaches
  the wire, and 0.3.0 exports `isMailbox`, the same check, for code that
  keeps addresses for later. *Kept in the same package as the server, on its
  own subpath*: both share the grammar.
- **`@bumail/store` on `bun:sqlite`**, as `@bumail/store/sqlite`, in store
  0.2.0 (0.4.0 now) — the same contract on disk, held to the same specs,
  with message bodies as blobs on disk addressed by their hash. One
  process per database, and every write flushed to disk before it is
  acknowledged.
- **`@bumail/auth`, DKIM**, in auth 0.1.0 — signing and verifying
  (RFC 6376): rsa-sha256 and ed25519-sha256 (RFC 8463) through Web Crypto,
  simple and relaxed canonicalisation, a streamed body, key lookups through
  `@bumail/dns`, results in RFC 8601's words.
- **`@bumail/mime`**, in mime 0.1.0 (0.1.2 now) — read and write e-mail
  messages. RFC 5322 headers, encoded-words (RFC 2047) and parameter
  continuations (RFC 2231), multipart, base64 and quoted-printable, any
  charset `TextDecoder` knows, and a streaming parser that walks a large
  message without holding it in memory. Its specs are the RFCs' own
  examples.
- **`@bumail/smtp`, the server**, in smtp 0.1.0 (0.3.0 now) — RFC 5321 on
  `Bun.listen`: EHLO with PIPELINING, SIZE, 8BITMIME, SMTPUTF8 and
  ENHANCEDSTATUSCODES; STARTTLS and implicit TLS; AUTH PLAIN and LOGIN,
  offered only once encrypted; hooks for connect, MAIL FROM, RCPT TO and
  DATA where the app accepts or refuses; size limits and timeouts.
  Delivery goes through the `onData` hook — into `@bumail/store`, or
  wherever the app keeps mail — and the server **refuses to relay without
  AUTH** in every default.
- **`@bumail/store`, its contract and memory store**, in store 0.1.0
  (0.4.0 now) — accounts, mailboxes with the IANA roles and a
  subscription, messages with one id across mailboxes, a thread and a UID
  in each, flags, and the changes since a modseq, for the account or one
  mailbox, behind one interface, every call scoped to one account. It is
  where the SMTP server's `onData` delivers.
- **`@bumail/dns`**, in dns 0.1.0 (0.1.1 now) — the DNS answers the other
  packages need (MX, TXT, A, AAAA, PTR) behind one small interface:
  `node:dns` in production, a fixture in specs, with a cache that honours
  TTLs. *Its own package*: SPF, DKIM, DMARC, the SMTP client and MTA-STS
  all query DNS, and each spec needs a deterministic answer instead of the
  Internet.
