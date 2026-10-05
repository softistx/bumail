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
  `Authentication-Results` (any not plainly another server's removed);
  DMARC enforced by default, `p=reject` refused during the session and
  `p=quarantine` to Junk, or only recorded. Mail served over IMAP on 993
  (and 143 with STARTTLS, off by default), logins counted per client. A
  certificate from files; a clean stop on SIGTERM; a line of log per
  listener and per message, never a secret. One client holds 10 SMTP
  sessions at most, and the bare `<postmaster>` reaches a mailbox.
- **Sending mail** (merged, not published): submission on 465 and 587,
  logged in over TLS only, a user sending as itself or its aliases
  alone. Mail for a hosted domain straight to its mailbox, the rest
  through the queue on the data volume, by MX or the smarthost, retried
  for days; a failure back to the sender as a DSN in its own mailbox.
  DKIM-signed with a key per domain, made by `bumail dkim`, which
  prints the record to publish.
- **JMAP and the health check** (merged, not published): JMAP on 443 over
  the same store, Basic auth for the directory's users through the same
  failure limiter, HTTPS from the certificate files; or, behind Traefik
  or another reverse proxy that ends TLS, plain HTTP for the proxies
  named in the file, the client read from `X-Forwarded-For` only from
  them, so logins are counted per client. `GET /healthz` on loopback,
  200 or 503 with each part named. The PROXY protocol on the mail
  ports, from the proxies named in the file, off by default.
- **Certificates reloaded without a restart** (merged, not published):
  `bumail serve` looks at `tls.cert` and `tls.key` every
  `tls.pollSeconds` (30 by default) and on SIGHUP, and a renewed pair that
  is valid and complete — a key written before its certificate waits —
  goes to every TLS listener (25 and 587, 465, 993 and 143, and JMAP's
  HTTPS) for new connections, open sessions untouched; one that is not
  keeps the old pair and logs why, once.
- **The DNS records a domain needs, and a check of them** (merged, not
  published): `bumail dns` prints, for every hosted domain or one, the MX,
  SPF (`v=spf1 mx -all`), DKIM, DMARC (`quarantine` once the domain has a DKIM key, strict DKIM alignment) and
  autoconfig SRV records (RFC 6186, RFC 8620), and the host name's A and
  AAAA from `--ip` and `--ip6`, as a zone file DNS hosts import, or as
  JSON. `--check` looks each up in the DNS, parsed as the receivers read them,
  and exits 1 while one is missing, differs or is doubled (5 when the DNS
  gave no answer).

## Next

In this order, each its own step:

- **Certificates from ACME** (HTTP-01 on port 80, ECDSA P-256 keys),
  through the separate `@bumail/acme` package; the reload under Now is
  what applies a renewal.
- **A Docker image**, and a compose file with Traefik: the server, its
  ports and one volume for everything it keeps, the mail ports through
  Traefik's TCP routers, JMAP through its HTTP router.

## Later

- **MTA-STS and TLS-RPT in `bumail dns`**: the `_mta-sts` and `_smtp._tls`
  TXT records, with the policy file the server would serve over HTTPS at
  `mta-sts.<domain>`.
- **SRV and CAA in `bumail dns --check`**, once `@bumail/dns` can look them
  up; they are listed as `unchecked` until then.
- **`bumail dns` with a policy of your own**: `--dmarc <policy>`
  and an SPF `include` for a provider, instead of editing the output.
- **A `421` to SMTP clients still connected when the server stops**, as
  RFC 5321 §3.8 suggests, rather than a plain hang-up; it needs a
  stop with a reply in `@bumail/smtp`.
- **Delivery to each recipient on its own**: today a store failure
  part-way through a message for several users answers the whole message
  `451`, and the users reached before it get it twice when it comes
  again.
- **`postmaster@` every hosted domain** taken without a user or an
  alias of that name, as RFC 5321 §4.5.1 asks, routed as the bare
  `<postmaster>` is.
- **Rate limits per user on submission**, so one stolen password cannot
  send without bound before it is changed.
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
