# Roadmap

What `@bumail/auth` gives a mail server, and what is coming. This page is a
direction, not a commitment: the version something shipped in is the only
number on it.

## Now

- **SPF** (RFC 7208): `check_host()` for the client IP, the HELO name and
  the MAIL FROM domain, with its ten-lookup and two-void-lookup limits,
  macros and every result word, over the same injected `Resolver`.

## Next

- **DMARC** (RFC 7489): the policy record and its organisational-domain
  fallback, relaxed and strict alignment of the DKIM `d=` and SPF domains
  with From, and the disposition a receiver applies.
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
- **A runtime dependency.** Web Crypto and `Bun.CryptoHasher` are the
  platform's.

## Shipped

### Unreleased: merged, not yet published

- **DKIM** (RFC 6376): verifying every signature on a message and signing
  outbound mail, with rsa-sha256 and ed25519-sha256 (RFC 8463) through Web
  Crypto, simple and relaxed canonicalisation, a streamed body, key lookups
  through `@bumail/dns`, and results in RFC 8601's words. The signer
  over-signs the fields a reader sees, and the verifier answers `policy`
  for a From the signature does not cover. This is the package's first
  release.
