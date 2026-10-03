# Roadmap

What `@bumail/smtp` gives a mail server, and what is coming. This page is a
direction, not a commitment: the version something shipped in is the only
number on it.

## Now

Nothing in progress.

## Next

- **Connection reuse in the client** — several messages to one
  destination over one session (`RSET` between them), for a queue that
  delivers in batches. Today each `sendMail` opens its own connection.
- **DSN** (RFC 3461) — `RET`, `ENVID`, `NOTIFY` and `ORCPT` accepted and
  handed to the app, so a sender can ask for delivery status
  notifications. Today they are refused with `555 5.5.4`, and the client
  sends none.
- **Delivery into `@bumail/store`, ready-made** — an `onData` that puts
  each message in its recipients' inboxes, instead of the few lines the
  [guide](guide.md#delivering-into-bumailstore) shows today. The store
  itself has landed; only the helper is to come.

## Not planned

- **Relaying without AUTH** — not as a default, not as an option. A
  recipient outside `localDomains` takes an authenticated session; an open
  relay is a spam source within hours of going online.
- **AUTH on a clear connection** — the password would cross the network in
  base64. Use STARTTLS or implicit TLS.

## Shipped

### Unreleased — merged, not yet published

- **The client, as `@bumail/smtp/client`** — `sendMail(message, options)`
  delivers one message to a host (a smarthost, submission on 587 or 465,
  a local Mailpit) or to a domain's MX hosts by preference, through a
  `Resolver` of `@bumail/dns` (an optional peer), the domain's own address
  without MX, and a null MX refused. STARTTLS opportunistic by default for
  MX, required — the certificate checked — with AUTH; implicit TLS; AUTH
  PLAIN and LOGIN only once encrypted; PIPELINING, SIZE, 8BITMIME and
  SMTPUTF8; the message a string, bytes or a stream, dot-stuffed, a bare
  CR or LF refused. It resolves with each recipient's reply, and rejects
  with an `SmtpError` whose `temporary` tells a retry from a bounce. RFC
  5321's timeouts per step and a deadline; reply lines, replies and their
  total bounded against a hostile server.

- **`hookTimeout` bounded to what a timer can wait.** A value past
  2 147 483 seconds is refused, where it used to fire after a millisecond
  and time every hook out.

### 0.1.0

- **The server** — RFC 5321 on `Bun.listen`: EHLO with PIPELINING, SIZE,
  8BITMIME, SMTPUTF8 and ENHANCEDSTATUSCODES; STARTTLS and implicit TLS;
  AUTH PLAIN and LOGIN, offered only once encrypted; hooks where the app
  accepts or refuses a connection, a sender, a recipient or a message;
  limits on size, recipients, connections, errors and idle time; a
  greeting delay that turns away senders who talk before the 220; a `250`
  only once the app read the whole message; and a refusal of SMTP
  smuggling.
