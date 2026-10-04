# Roadmap

What `@bumail/acme` gives a server that obtains its own certificates, and
what is coming. This page is a direction, not a commitment: the version
something shipped in is the only number on it.

## Now

Nothing in progress.

## Next

- **The ACME client** (RFC 8555), built on these primitives: the
  directory, nonces (with a retry on `badNonce`), the account (created or
  found again from its key), an order for a set of names, its
  authorizations, HTTP-01 challenges answered through a hook that serves
  the key authorization on port 80, finalize with a CSR, and the
  certificate chain downloaded as PEM. Every request's network reached
  through an option, so its specs run against Pebble, Let's Encrypt's
  test CA, and never the Internet.

## Later

- **DNS-01**, through a hook that publishes the TXT record at
  `_acme-challenge.<name>`: the challenge for a server port 80 does not
  reach, and the one that proves a **wildcard name**, which `createCsr`
  then takes.
- **Account key rollover** (RFC 8555 §7.3.5) and **revocation** (§7.6).
- **External account binding** (§7.3.4), for CAs that ask for one.
- **Renewal information** (ARI, RFC 9773), so a client renews when the CA
  suggests rather than on a fixed schedule.

## Not planned

- **TLS-ALPN-01** (RFC 8737). It answers on port 443 with a certificate
  chosen by the `acme-tls/1` ALPN protocol, which Bun 1.4.2's TLS cannot
  do.
- **Converting internationalized names.** `createCsr` takes A-labels and
  refuses anything else, rather than choose an IDNA mapping for you; the
  platform's `new URL(…).hostname` converts one.
- **A runtime dependency, or a peer.** Web Crypto signs; the DER this
  needs is a small writer of its own.

## Shipped

### Unreleased — merged, not yet published

- **The primitives of an ACME client.** A PKCS #10 request for DNS names
  (ECDSA P-256 or RSA, the names in a `subjectAltName`, checked first),
  the flattened JWS of RFC 8555 §6.2 with ES256 and RS256, the JWK
  thumbprint (RFC 7638), key authorizations and the HTTP-01 path, and
  keys generated, written as PKCS #8 PEM that Bun's TLS takes, and read
  back.
