# Roadmap

What bumail is building toward: a mail server native to Bun — SMTP in and
out, DKIM / SPF / DMARC, mailboxes read over JMAP — as `@bumail/*` packages
with no runtime dependency, and a server app on
[alxia](https://github.com/softistx/alxia) that wires them together.

No dates. Each entry says what someone running or embedding the server gets.

## Now

- **`@bumail/dns`** — in progress: the DNS answers the other packages
  need (MX, TXT, A, AAAA, PTR) behind one small interface: `node:dns` in
  production, a fixture in specs, with a cache that honours TTLs. *Its own
  package*: SPF, DKIM, DMARC, the SMTP client and MTA-STS all query DNS,
  and each spec needs a deterministic answer instead of the Internet.

## Next

- **`@bumail/auth`** — DKIM signing and verifying (RSA-SHA256 and Ed25519
  through Web Crypto, relaxed and simple canonicalisation), SPF (RFC 7208,
  with its ten-lookup limit), DMARC (RFC 7489) evaluation and its policy,
  and the `Authentication-Results` header.
- **`@bumail/smtp`, the client** — outbound delivery: MX lookup through
  `@bumail/dns`, opportunistic STARTTLS, connection reuse per destination.
  *Kept in the same package as the server, on its own subpath*: both share
  the command and reply grammar.
- **`@bumail/store` on `bun:sqlite`** — the same contract on disk, message
  bodies as blobs on disk addressed by their hash.
- **`@bumail/queue`** — outbound mail with retries and back-off, a deferred
  and a failed state, bounces and delivery status notifications (RFC 3464).
  A contract with a memory and a `bun:sqlite` answer, like the store.
- **`@bumail/jmap`** — mailbox access over JMAP (RFC 8620 core, RFC 8621
  mail), as an alxia app. *JMAP before IMAP*: it is HTTP and JSON, so alxia
  gives it routing, validation and its typed client for free.
- **The server app** — SMTP on 25 and submission on 587,
  the queue, the store and JMAP wired together; an admin API for domains,
  accounts, aliases and DKIM keys; health and metrics. It starts once
  `@alxia/core` is on npm: it consumes alxia's published packages, not a
  link to its working tree, so bumail's CI never depends on another
  repository's checkout.

## Later

- **IMAP4rev2** (RFC 9051), for the mail clients that do not speak JMAP.
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

### Merged, not yet published

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
  since a modseq, behind one interface, every call scoped to one account.
  It is where the SMTP server's `onData` delivers.
