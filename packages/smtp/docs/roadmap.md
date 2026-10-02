# Roadmap

What `@bumail/smtp` gives a mail server, and what is coming. This page is a
direction, not a commitment: the version something shipped in is the only
number on it.

## Now

- **The server** — RFC 5321 on `Bun.listen`: EHLO with PIPELINING, SIZE,
  8BITMIME, SMTPUTF8 and ENHANCEDSTATUSCODES; STARTTLS and implicit TLS;
  AUTH PLAIN and LOGIN, offered only once encrypted; hooks where the app
  accepts or refuses a connection, a sender, a recipient or a message;
  limits on size, recipients, connections, errors and idle time; a
  greeting delay that turns away senders who talk before the 220; a `250`
  only once the app read the whole message; and a refusal of SMTP
  smuggling.

## Next

- **The client, on its own subpath** — outbound delivery: MX lookup,
  opportunistic STARTTLS, connection reuse per destination. In this
  package, beside the server, since both share the command and reply
  grammar.
- **DSN** (RFC 3461) — `RET`, `ENVID`, `NOTIFY` and `ORCPT` accepted and
  handed to the app, so a sender can ask for delivery status
  notifications. Today they are refused with `555 5.5.4`.
- **Delivery into `@bumail/store`**, once that package lands — an `onData`
  ready to use that puts each message in the recipients' mailboxes, instead
  of writing your own.

## Not planned

- **Relaying without AUTH** — not as a default, not as an option. A
  recipient outside `localDomains` takes an authenticated session; an open
  relay is a spam source within hours of going online.
- **AUTH on a clear connection** — the password would cross the network in
  base64. Use STARTTLS or implicit TLS.
