# Roadmap

What `@bumail/server` gives someone running a mail server, and what is
coming. This page is a direction, not a commitment. The package is
private until it is complete, with its Docker image: nothing here is on
npm yet.

## Now

- **The configuration, read and checked** (merged, not published): one
  TOML file, the environment overriding only URLs and secrets, every
  problem listed at once and none repeating a secret, and `bumail
  check-config`.
- **Domains, users and aliases** (merged, not published), in a SQLite
  directory on the volume, managed by `bumail domain`, `bumail user` and
  `bumail alias`, each change counting at once. Passwords hashed with
  argon2id and never taken from the command line; logins verified a few
  at a time, an unknown user as slow as a known one, and failures
  counted per client. A new user gets its mailboxes in the store;
  removing one keeps its mail unless purged. An alias points to local
  users only.
- **Receiving mail and reading it** (merged, not published): `bumail
  serve` takes mail on 25 for the directory's users and aliases, and
  for nothing else — no AUTH there, so never a relay — with STARTTLS
  offered. SPF, DKIM and DMARC on each message, recorded in
  `Authentication-Results` (a forged one in the server's name removed);
  DMARC enforced by default, `p=reject` refused during the session and
  `p=quarantine` to Junk, or only recorded. Mail served over IMAP on 993
  (and 143 with STARTTLS, off by default), logins counted per client. A
  certificate from files; a clean stop on SIGTERM; a line of log per
  listener and per message, never a secret.

## Next

In this order, each its own step:

- **Sending mail**: submission on 465 and 587, authenticated and over
  TLS only, DKIM-signed (RSA-2048 keys, `bumail dkim`), through the queue
  by MX or the smarthost.
- **JMAP over HTTPS on 443, and a health check on loopback.**
- **Certificates reloaded without a restart**, then **from ACME**
  (HTTP-01 on port 80, ECDSA P-256 keys), through a separate
  `@bumail/acme` package.
- **The DNS records a domain needs**, written by `bumail dns`: MX, SPF,
  DKIM and DMARC, as a zone file or plain records.
- **A Docker image**: the server, its ports and one volume for
  everything it keeps.

## Later

- **A `421` to SMTP clients still connected when the server stops**, as
  RFC 5321 §3.8 suggests, rather than a plain hang-up; it needs a
  stop with a reply in `@bumail/smtp`.
- **Delivery to each recipient on its own**: today a store failure
  part-way through a message for several users answers the whole message
  `451`, and the users reached before it get it twice when it comes
  again.
- **Plus addressing** (`alice+news@example.com` delivered to
  `alice@example.com`), and changing an alias's users in place rather
  than removing and adding it.
- **ACME by DNS-01**, through a hook a DNS provider plugs into, for
  servers whose port 80 is not reachable.

## Not planned

- **Relaying without authentication**: no `relay`, `mynetworks` or
  `trustedNetworks`, in any form.
- **Forwarding aliases** to addresses elsewhere: a server that forwards
  is a relay, and breaks SPF for what it forwards.
- **Settings in the environment beyond URLs and secrets**: one file says
  how the server runs.
- **ACME by TLS-ALPN-01**: Bun's TLS does not expose what it needs.

## Shipped

Nothing published yet.
