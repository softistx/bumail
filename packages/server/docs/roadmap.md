# Roadmap

What `@bumail/server` gives someone running a mail server, and what is
coming. This page is a direction, not a commitment. The package is
private until it serves mail: nothing here is on npm yet.

## Now

- **The configuration, read and checked** (merged, not published): one
  TOML file, the environment overriding only URLs and secrets, every
  problem listed at once and none repeating a secret, and `bumail
  check-config`. `bumail serve` checks the file, then says serving is
  not implemented yet.

## Next

In this order, each its own step:

- **Domains, users and aliases**, in a SQLite directory on the volume,
  managed by the command: `bumail domain`, `bumail user`, `bumail alias`.
  Passwords hashed with argon2id, a verify for an unknown user as slow as
  for a known one, and a limit per address. An alias points to a local
  user only: forwarding out would make the server a relay.
- **Receiving mail and reading it**: SMTP on 25 (MX, never AUTH there)
  delivering into the store, and IMAP on 993, with certificates from
  files. Inbound DMARC enforced by default: `p=reject` refused during the
  session, `p=quarantine` to Junk.
- **Sending mail**: submission on 465 and 587, authenticated and over
  TLS only, DKIM-signed (RSA-2048 keys, `bumail dkim`), through the queue
  by MX or the smarthost.
- **JMAP over HTTPS on 443, a health check on loopback, and a clean
  start and stop.**
- **Certificates reloaded without a restart**, then **from ACME**
  (HTTP-01 on port 80, ECDSA P-256 keys), through a separate
  `@bumail/acme` package.
- **The DNS records a domain needs**, written by `bumail dns`: MX, SPF,
  DKIM and DMARC, as a zone file or plain records.
- **A Docker image**: the server, its ports and one volume for
  everything it keeps.

## Later

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
