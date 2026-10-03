# Troubleshooting

Two kinds of entry. **Errors** are what a call throws: an `AuthError`,
headed by its message and listed under its `code`; one that wraps
another error keeps it as `cause`. **Result reasons** are
what `verifyDkim` gives back in `reason`. It never throws for a message,
so everything wrong with one comes back this way. Entries are listed under
their `result`. The parts shown as … vary.

## Errors

### INVALID_OPTION

#### `AuthError: verifyDkim(): resolver must be a Resolver`

**When**: `verifyDkim` was called without a `resolver`, or with something
that has no `txt` method. **Fix**: pass one from `@bumail/dns`:
`verifyDkim(message, { resolver: cachedResolver(nodeResolver()) })`.

#### `AuthError: verifyDkim(): … must be an integer of at least …, not …`

**When**: `clockSkew`, `maxHeaderBytes`, `maxSignatures`,
`maxSignedHeaders` or `minRsaBits` is not a whole number in range.
`minRsaBits` cannot go under 1024, the floor RFC 8301 sets. **Fix**: pass
a whole number, or leave the option out for its default.

#### `AuthError: signDkim(): privateKey must be an RSASSA-PKCS1-v1_5 or Ed25519 CryptoKey, not …`

**When**: the key is not a Web Crypto key of either algorithm, for
example an RSA-PSS or ECDSA key, or not a `CryptoKey` at all. **Fix**:
import it with `importDkimPrivateKey(pem)`, or with
`crypto.subtle.importKey(…, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, …, ['sign'])`.

#### `AuthError: signDkim(): algorithm … does not match the … key`

**When**: `algorithm` says `rsa-sha256` with an Ed25519 key, or the
other way round. **Fix**: leave `algorithm` out: it is taken from the key.

#### `AuthError: signDkim(): the RSA key's hash must be SHA-256, not …`

**When**: the RSA key was imported with another hash, such as `SHA-1`.
**Fix**: import it again with `hash: 'SHA-256'`. rsa-sha1 is not
allowed for signing (RFC 8301).

#### `AuthError: signDkim(): privateKey does not have the sign usage`

**When**: the key was imported with `['verify']` only, or it is the
public half of the pair. **Fix**: pass the private key, imported with
`['sign']`.

#### `AuthError: signDkim(): domain "…" is not a domain name`

**When**: `domain` is empty, has an empty label (`a..b`), or is not a
host name. **Fix**: pass the domain the key is published under, such as
`example.com`. An IDN is fine: it is written as its A-labels.

#### `AuthError: signDkim(): selector "…" is not a selector`

**When**: `selector` is not one or more DNS labels of letters, digits,
hyphens and underscores. **Fix**: use the label the key record is under,
such as `mail2026` for `mail2026._domainkey.example.com`.

#### `AuthError: signDkim(): identity "…" is not an address within …`

**When**: `identity` has no `@`, holds a character `i=` cannot carry
(white space, `;`, anything outside printable ASCII), the part after its
last `@` is not a domain name (`a@x..example.com`, `a@-x.example.com`), or
its domain is neither `domain` nor one of its subdomains. **Fix**: use an address such
as `bounces@mail.example.com`, or leave `identity` out.

#### `AuthError: signDkim(): headers must include from (RFC 6376 §5.4)`

**When**: `headers` was given without `from`. **Fix**: add it, ideally
twice, to over-sign it: `['from', 'from', 'to', 'subject', 'date']`.

#### `AuthError: signDkim(): headers holds a name that is not a header field name`

**When**: an entry of `headers` is empty, is not a string, or holds white
space, a `:`, a `;`, a control character or anything outside ASCII. A
`:` ends a field name, and a `;` would end the `h=` tag. **Fix**: pass
bare field names: `'list-unsubscribe'`.

#### `AuthError: signDkim(): headers must be an array of header field names`

**When**: `headers` is a string or anything else that is not an array.
**Fix**: `headers: ['from', 'to', 'subject']`, or leave it out for the
default.

#### `AuthError: signDkim(): the DKIM-Signature field cannot be written: …`

**When**: `@bumail/mime`'s `foldHeader` refused the field, and its
`MimeError` is the `cause`. In practice, an entry of `headers` (or the
selector, or `identity`) is longer than the 998 characters a header line
may hold (RFC 5322 §2.1.1), so the field cannot be folded. **Fix**: use
the real field names; no field name is that long.

#### `AuthError: signDkim(): canonicalization … is not one of simple|relaxed/simple|relaxed`

**When**: `canonicalization` is not one of the four pairs. **Fix**:
`'relaxed/relaxed'` (the default), `'relaxed/simple'`, `'simple/relaxed'`
or `'simple/simple'`.

#### `AuthError: signDkim(): expiresIn must be an integer of at least 1, not …`

**When**: `expiresIn` is zero, negative, or not a whole number of seconds.
**Fix**: `expiresIn: 7 * 24 * 3600`, or leave it out for no `x=`.

#### `AuthError: signDkim(): maxHeaderBytes must be an integer of at least 1, not …`

**When**: `maxHeaderBytes` is not a positive whole number. **Fix**: leave
it out for 256 KiB.

### INVALID_MESSAGE

#### `AuthError: signDkim(): the message has no From header`

**When**: the message given to sign has no From field. RFC 6376 §5.4
requires From to be signed, and RFC 5322 requires the message to have one.
**Fix**: build the message with its From before signing.

#### `AuthError: signDkim(): the header is larger than maxHeaderBytes (…)`

**When**: no blank line was found within `maxHeaderBytes`. Either the
header is that large, or the message was given without the blank line
between header and body. **Fix**: check the message is complete. Raise
`maxHeaderBytes` only for a header you know is that large.

#### `AuthError: signDkim(): the message could not be read: …`

**When**: the `ReadableStream` given to sign failed, in the header or in
the body, for example a file read that broke or a socket that closed.
The stream's own error follows the colon and is kept as `cause`. No
signature is made from part of a message. **Fix**: look at `cause`, then
sign again once the whole message can be read.

### INVALID_KEY

#### `AuthError: importDkimPrivateKey(): expected a PEM RSA PRIVATE KEY or PRIVATE KEY, or a base64 Ed25519 key of 32 bytes`

**When**: the text has no PEM block it knows, and is not 32 bytes of
base64. A public key, an encrypted key (`ENCRYPTED PRIVATE KEY`) and an
`EC PRIVATE KEY` all land here. **Fix**: pass the private key file.
Decrypt it first with `openssl pkcs8 -in key.pem -out plain.pem`.

#### `AuthError: importDkimPrivateKey(): the … block is not base64`

**When**: the text between the PEM lines is damaged or truncated.
**Fix**: copy the key file again, whole.

#### `AuthError: importDkimPrivateKey(): the key could not be imported as an RSA or Ed25519 private key`

**When**: the PEM decoded, but Web Crypto could not read it as either
kind of key. Perhaps it is an EC or DSA key in PKCS #8, or it is damaged.
**Fix**: generate an RSA or Ed25519 key (see the
[guide](guide.md#keys)).

#### `AuthError: importDkimPrivateKey(): the key must be a string`

**When**: something other than a string was passed, such as a `Bun.file`.
**Fix**: `await Bun.file(path).text()`.

## Result reasons

### none

#### `no DKIM-Signature header`

The message is not signed. Nothing to fix on your side.

### permerror

#### `malformed tag list: an empty tag`, `malformed tag list: "…" has no "="`, `malformed tag list: "…" is not a tag name`

The DKIM-Signature value is not a `tag=value; …` list (RFC 6376 §3.2).
The signer wrote it wrong, or something in transit damaged it.

#### `duplicate tag …=`

A tag appears twice. §3.2 forbids that, since a verifier could not know
which value was signed.

#### `missing required tag …=`

One of `v a b bh d h s` is absent (§3.5).

#### `unsupported version v=…`

`v=` is not `1`.

#### `rsa-sha1 is not accepted (RFC 8301)`

The signer used SHA-1, which RFC 8301 forbids verifiers to accept. The
sender must sign with rsa-sha256.

#### `unsupported algorithm a=…`

`a=` is neither `rsa-sha256` nor `ed25519-sha256`.

#### `unsupported canonicalization c=…`

`c=` is not `simple` or `relaxed`, or a pair of them.

#### `unsupported query method (q= has no dns/txt)`

`q=` names no method this verifier can use. `dns/txt` is the only one
defined.

#### `malformed d=`, `malformed s=`, `malformed i=`, `malformed h=`, `malformed b=`, `malformed bh=`, `malformed l=`, `malformed t=`, `malformed x=`

The tag's value cannot be what §3.5 defines. For example: a domain with
spaces, `b=` that is not base64, `t=` that is not 1 to 12 digits, or
`l=` that is not 1 to 76 digits.

#### `From is not signed (h= has no from)`

§5.4 requires From to be signed. Without it, the signature says nothing
about who the mail is from.

#### `i= is not within d=`

The identity's domain is neither `d=` nor a subdomain of it (§3.5).

#### `x= is not after t=`

The signature expires before it was made.

#### `the message has no From header`

The message has no From field, so no signature on it can cover one.

#### `no key at …`

The DNS answered that there is no TXT record at `<s>._domainkey.<d>`.
The sender has not published the key, or has removed it.

#### `no key: … is not a name to look up`

The selector and domain make a name that cannot be a host name, so it was
never queried.

#### `malformed key record at …`

None of the TXT records at the name reads as a key record. Each one
either fails to parse, has a `v=` other than `DKIM1` or not first, or
has no `p=`. An SPF record published at the selector's name lands here.

#### `key revoked (empty p=)`

The domain revoked the key: `p=` is empty (§3.6.1).

#### `key type k=… does not match a=…`

The record holds an `rsa` key and the signature is ed25519-sha256, or the
other way round. An unknown `k=` also lands here.

#### `key h= does not allow sha256`

The key record restricts its hashes, and sha256 is not among them.

#### `key s= is not for email`

The key record's service types include neither `*` nor `email`.

#### `key p= is not base64`

The key's `p=` value is not valid base64. A TXT record split badly in the
zone often causes this.

#### `key p= is not an rsa public key`, `key p= is not an ed25519 public key`

`p=` decoded, but Web Crypto cannot import it as that kind of key. For
RSA, both a SubjectPublicKeyInfo and a bare RSAPublicKey are tried. For
Ed25519, it must be exactly 32 bytes.

#### `key t=s: i= must be in d= itself, not a subdomain`

The key is strict (`t=s`), and `i=` names a subdomain of `d=`.

#### `RSA key of … bits, under 1024 (RFC 8301)`

The key is too short to be trusted. RFC 8301 forbids verifiers to accept
it.

#### `l= is longer than the canonical body`

`l=` claims more octets than the body has (§3.5: it "MUST NOT be
larger"). The body was cut in transit, or the signature is forged.

### fail

#### `body hash did not verify`

The canonical body does not hash to `bh=`. The body changed after
signing: a footer added, a re-encoding, a line re-wrapped. It also
happens when the signer hashed something other than what it sent.

#### `signature did not verify`

The body is intact, but `b=` does not verify over the signed header
fields with the published key. A signed field changed, a field listed in
`h=` was added, or the key in the DNS is not the one that signed.

### neutral

#### `signature expired (x=)`

The clock is past `x=` plus `clockSkew`.

#### `signature timestamp t= is in the future`

`t=` is ahead of the clock by more than `clockSkew`. Either the sender's
clock or yours is wrong.

### temperror

#### `key lookup failed: … for …`

The DNS gave no answer (`TEMPORARY` or `TIMEOUT`). Try again later: an
SMTP server can answer 451 and let the sender retry.

#### `key lookup failed: …`

The resolver threw something that is not a `DnsError`. Treat it as
temporary, and look at the resolver.

#### `the message could not be read: …`

The message stream failed before its end, for example because the
connection dropped. The stream's own error follows the colon. If it
failed in the body, every signature still in progress gives this, with
its signature fields. If it failed before the header was complete, no
signature was read yet: you get one `temperror` for the whole message,
with no `domain`, `selector` or other signature field.

### policy

#### `the header is larger than maxHeaderBytes (…)`

No blank line was found within `maxHeaderBytes`, so no signature was even
looked for. You get one result for the whole message, as for the other
limits. This is usually a hostile or broken message. Raise
`maxHeaderBytes` only if real mail you receive has larger headers.

#### `the message has a From the signature does not cover`

The message has more From fields than `h=` lists, so at least one From
is not signed, and a reader may be shown that one. It was added after
signing, above or below the signed one. No key is looked up. A signer
that over-signs From (lists it once more than the message has it, as
`signDkim` does by default) gets `fail` "signature did not verify"
instead.

#### `more than … signatures (maxSignatures)`

The message has more signatures than `maxSignatures`. The extra ones are
never looked up.

#### `h= lists more than … header fields`

`h=` is longer than `maxSignedHeaders`. A legitimate signer lists a dozen
or two.

#### `RSA key of … bits, under minRsaBits (…)`

The key is at least 1024 bits, but shorter than the `minRsaBits` you set.

#### `l= body length is refused (rejectBodyLength)`

The signature has `l=`, and `rejectBodyLength` is on.
