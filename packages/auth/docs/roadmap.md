# Roadmap

What `@bumail/auth` gives a mail server, and what is coming. This page is a
direction, not a commitment: the version something shipped in is the only
number on it.

## Now

- **DMARC** (RFC 7489): the policy record and its organisational-domain
  fallback, relaxed and strict alignment of the DKIM `d=` and SPF domains
  with From, and the disposition a receiver applies.

## Next

- **The `Authentication-Results` header** (RFC 8601): DKIM, SPF and DMARC
  results written as one field, `header.d`, `header.b` and `smtp.mailfrom`
  included, and read back with its `authserv-id` checked.

## Later

- **ARC** (RFC 8617), so forwarded mail keeps its authentication: the
  chain sealed and verified with the DKIM code already here.
- **A key-rotation helper**: generating a key pair and the TXT record to
  publish, for the server app's admin API.

## Not planned

- **rsa-sha1, and RSA keys under 1024 bits.** RFC 8301 forbids both. They
  come back as `permerror`, and the signer cannot make them.
- **Signing with `l=`.** A body length lets anyone append to a signed
  message. The verifier honours it and reports it, but the signer never
  writes it.
- **The SPF record type (99).** RFC 7208 §3.1 retired it: only TXT
  records are read.
- **A runtime dependency.** Web Crypto and `Bun.CryptoHasher` are the
  platform's.

## Shipped

### Unreleased: merged, not yet published

- **SPF** (RFC 7208): `checkSpf`, RFC 7208's `check_host()` for the client
  IP and the MAIL FROM domain, or the HELO name for a bounce or on its own.
  It covers every mechanism and qualifier, `redirect=` and `exp=`, the
  macros, the ten-lookup, two-void-lookup and ten-name limits, and a
  timeout, over the same injected `Resolver`. Every result word comes
  back, never a throw for a record. It agrees with 197 of the 203 cases
  of the OpenSPF test suite, which runs with the specs.
- **DKIM** (RFC 6376): verifying every signature on a message and signing
  outbound mail, with rsa-sha256 and ed25519-sha256 (RFC 8463) through Web
  Crypto, simple and relaxed canonicalisation, a streamed body, key lookups
  through `@bumail/dns`, and results in RFC 8601's words. The signer
  over-signs the fields a reader sees, and the verifier answers `policy`
  for a From the signature does not cover. This is the package's first
  release.
