# Roadmap

What `@bumail/acme` gives a server that obtains its own certificates, and
what is coming. This page is a direction, not a commitment: the version
something shipped in is the only number on it.

## Now

Nothing in progress.

## Next

Nothing in this package: the server app is next to use the client, to
obtain its certificates and renew them (see the
[repository's roadmap](https://github.com/softistx/bumail/blob/develop/docs/roadmap.md)).

## Later

- **Renewal information** (ARI, RFC 9773): renewing when the CA suggests,
  from the directory's `renewalInfo` (which `directory()` already reads),
  rather than on a fixed schedule; and the `replaces` of a new order.
- **DNS-01**, through a hook that publishes the TXT record at
  `_acme-challenge.<name>`: the challenge for a server port 80 does not
  reach, and the one that proves a **wildcard name**, which `createCsr`
  then takes.
- **Account key rollover** (`keyChange`, RFC 8555 §7.3.5) and
  **revocation** (`revokeCert`, §7.6). The directory's URLs for both are
  read already; the requests wait, since obtaining a certificate needs
  neither.
- **Account updates and deactivation** (§7.3.2, §7.3.6): a new contact,
  an account closed.
- **External account binding** (§7.3.4), for CAs that ask for one.
- **Alternate chains** (§7.4.2): the `Link: rel="alternate"` chains a CA
  offers beside the default one.
- **Certificate profiles**: the directory's `meta.profiles` (read
  already) chosen in `newOrder`.

## Not planned

- **TLS-ALPN-01** (RFC 8737). It answers on port 443 with a certificate
  chosen by the `acme-tls/1` ALPN protocol, which Bun 1.4.2's TLS cannot
  do.
- **Converting internationalized names.** `createCsr` takes A-labels and
  refuses anything else, rather than choose an IDNA mapping for you; the
  platform's `new URL(…).hostname` converts one.
- **A runtime dependency, or a required peer.** Web Crypto signs; the DER this
  needs is a small writer of its own.

## Shipped

### Unreleased — merged, not yet published

- **The ACME client** (RFC 8555): `AcmeClient` — the directory, kept;
  nonces kept from every answer and fetched by a HEAD when none is left;
  `badNonce` retried with the refusal's nonce, 3 times at most; the
  account created or found (`onlyReturnExisting`); orders,
  authorizations, challenges answered with `{}`, finalize and the PEM
  chain, every fetch a POST-as-GET; polls that follow `Retry-After`
  within an overall time limit and an `AbortSignal`. Every error from the
  CA is an `AcmeError` with its problem document, `RATE_LIMITED` with
  `retryAfter`. Only `https:` URLs (`allowInsecure` for a test CA),
  answers bounded in size, numbers from the CA clamped, and the account
  key in no output. `obtainCertificate` runs the whole HTTP-01 flow and
  always removes the tokens it set; `http01Responder()` serves them to
  `Bun.serve`. Tested against Pebble, which validates HTTP-01 for real.

### 0.1.0

- **The primitives of an ACME client.** A PKCS #10 request for DNS names
  (ECDSA P-256 or RSA, the names in a `subjectAltName`, checked first),
  the flattened JWS of RFC 8555 §6.2 with ES256 and RS256, the JWK
  thumbprint (RFC 7638), key authorizations and the HTTP-01 path, and
  keys generated, written as PKCS #8 PEM that Bun's TLS takes, and read
  back.
