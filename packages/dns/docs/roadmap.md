# Roadmap

What `@bumail/dns` gives a mail server, and what is coming. This page is a
direction, not a commitment: the version something shipped in is the only
number on it.

## Now

- **The resolver interface, on `node:dns`, a fixture and a cache.** MX,
  TXT, A, AAAA and PTR, normalised names, one error type that tells "no
  such record" from "try later", a fixture that can answer with any error
  and counts lookups, and a cache that honours TTLs and never keeps a
  temporary failure.

## Next

- **The lookups SPF, DKIM and DMARC are built from**, once `@bumail/auth`
  starts, if that package shows a need the interface does not meet (for
  example a void-lookup count, RFC 7208 §4.6.4).
- **MX resolution for delivery**: the MX answer with RFC 5321 §5.1's
  fallback to the domain's A and AAAA, and the null MX, in one call, when
  the SMTP client lands.

## Later

- **Real TTLs for MX, TXT and PTR**, if `node:dns` comes to report them, or
  through a small DNS client of our own over UDP and TCP.
- **TLSA and other records** MTA-STS and DANE-adjacent policies read, when
  a package needs them.

## Not planned

- **A runtime dependency.** `node:dns` is the platform's.
- **DNSSEC validation.** `node:dns` does not give it, which is why DANE
  (RFC 7672) is not planned for bumail either.
- **Telling NXDOMAIN from NODATA.** Bun reports both as `ENOTFOUND`, and
  nothing in a mail server needs the difference.

## Shipped

Nothing yet.
