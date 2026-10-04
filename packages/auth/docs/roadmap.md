# Roadmap

What `@bumail/auth` gives a mail server, and what is coming. This page is a
direction, not a commitment: the version something shipped in is the only
number on it.

## Now

- Nothing in progress: the next entry is picked from Next.

## Next

- **DMARC reports** (RFC 7489 §7): aggregate reports to `rua=` and
  failure reports to `ruf=`, with §7.1's check that a third party agreed
  to receive them. The URIs are already parsed and returned.
- **ARC** (RFC 8617), so forwarded mail keeps its authentication: the
  chain sealed and verified with the DKIM code already here.
- **Reading `Authentication-Results` back**, with its `authserv-id`
  checked, and removing the fields a sender forged with yours.

## Later

- **DMARCbis**: the DNS tree walk that replaces the Public Suffix List
  for the organizational domain, and RFC 9091's policies for public
  suffix domains (`np=`, `psd=`).
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
  platform's, and the Public Suffix List is a snapshot embedded in the
  package, refreshed by a repository script.

## Shipped

### 0.3.0

- **DMARC** (RFC 7489): `checkDmarc` finds the From domain's policy at
  `_dmarc.<domain>` or its organizational domain, aligns the DKIM `d=`
  and SPF domains with From, strict or relaxed, applies `p=`, `sp=` and
  `pct` through an injectable `random`, and gives the disposition. A
  message whose From is missing, doubled, several addresses, a group,
  or not exactly one mailbox is a `permerror` to reject; a display name
  is never read as the author. The organizational domain comes from an
  embedded Public Suffix List snapshot (ICANN and private sections,
  MPL 2.0: the package is `MIT AND MPL-2.0`), replaceable through an
  option; `rua=` and `ruf=` are parsed, not sent
  to. Never a throw for a message, the DNS or a record.
- **`Authentication-Results`** (RFC 8601): `formatAuthenticationResults`
  writes the DKIM, SPF and DMARC results as one folded field, with
  `header.d`, `header.s`, `header.b`, `smtp.mailfrom` or `smtp.helo` and
  `header.from`, every value a token or a quoted-string.

### 0.2.0

- **SPF** (RFC 7208): `checkSpf`, RFC 7208's `check_host()` for the client
  IP and the MAIL FROM domain, or the HELO name for a bounce or on its own.
  It covers every mechanism and qualifier, `redirect=` and `exp=`, the
  macros, the ten-lookup, two-void-lookup and ten-name limits, and a
  timeout, over the same injected `Resolver`. Every result word comes
  back, never a throw for a record. It agrees with 197 of the 203 cases
  of the OpenSPF test suite, which runs with the specs.

### 0.1.0

- **DKIM** (RFC 6376): verifying every signature on a message and signing
  outbound mail, with rsa-sha256 and ed25519-sha256 (RFC 8463) through Web
  Crypto, simple and relaxed canonicalisation, a streamed body, key lookups
  through `@bumail/dns`, and results in RFC 8601's words. The signer
  over-signs the fields a reader sees, and the verifier answers `policy`
  for a From the signature does not cover. The package's first release.
