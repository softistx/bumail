# Roadmap

What `@bumail/dns` gives a mail server, and what is coming. This page is a
direction, not a commitment: the version something shipped in is the only
number on it.

## Now

- **`formatZone`** (next release): the records to publish as BIND
  zone-file lines, names absolute, TXT values split into strings of 255
  bytes.

## Next

- **The lookups DMARC is built from**, if `@bumail/auth` shows a need the
  interface does not meet; SPF needed only the `AbortSignal` and CNAME
  fixture entries below, and the wire-level resolver under Later.
- **MX resolution for delivery**: the MX answer with RFC 5321 §5.1's
  fallback to the domain's A and AAAA, and the null MX, in one call, when
  the SMTP client lands.
- **An `AbortSignal` on `Resolver`**, so a caller that gives up — SPF's
  `timeout` — stops the lookup instead of only no longer waiting for it.
- **CNAME in `fixtureResolver`**, so a spec can serve an alias the way a
  real DNS follows it (the RFC 7208 test suite's zones have a few, which `@bumail/auth`'s
  specs resolve by hand today).

## Later

- **A wire-level resolver** that queries any name the DNS allows, not only
  host names: names `normalizeName` and Bun's `node:dns` refuse, holding
  `+`, `=`, `@`, `%`, `:`, `/` or a space, which SPF macros build from a
  sender's local part (`%{l}` for `bob+news@`, SRS and BATV addresses).
- **Real TTLs for MX, TXT and PTR**, if `node:dns` comes to report them, or
  through a small DNS client of our own over UDP and TCP.
- **SRV and CAA lookups** on `Resolver`, so a tool that checks the DNS
  against what it should hold (`bumail dns --check`) can verify the
  autoconfig and CAA records `formatZone` writes. A new method on the
  interface is a change for every resolver of one's own, so it waits for
  a reason to make one.
- **TLSA and other records** MTA-STS and DANE-adjacent policies read, when
  a package needs them.

## Not planned

- **A runtime dependency.** `node:dns` is the platform's.
- **DNSSEC validation.** `node:dns` does not give it, which is why DANE
  (RFC 7672) is not planned for bumail either.
- **Telling NXDOMAIN from NODATA.** Node's `node:dns` keeps them apart,
  but Bun's reports both as `ENOTFOUND`, and nothing bumail plans now
  needs the difference: RFC 9091's DMARC `np=` defines a non-existent
  domain as NXDOMAIN or NODATA, so it takes either.

## Shipped

### 0.1.1

- **Long names refused before the IDN mapping.** A name of more than 253
  code points once composed is refused at once, so its cost no longer
  grows with the square of its length.

### 0.1.0

- **The resolver interface, on `node:dns`, a fixture and a cache.** MX,
  TXT, A, AAAA and PTR, normalised names that are never swapped for
  another, one error type that tells "no such record" from "try later", a
  fixture that can answer with any error and counts lookups, and a cache
  that honours TTLs, shares identical queries and never keeps a temporary
  failure.
