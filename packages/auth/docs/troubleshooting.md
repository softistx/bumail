# Troubleshooting

Three kinds of entry. **Errors** are what a call throws: an `AuthError`,
headed by its message and listed under its `code`; one that wraps
another error keeps it as `cause`. **Result reasons** are
what `verifyDkim`, `checkSpf` and `checkDmarc` give back in `reason`.
None of them throws for a message or a record, so everything wrong with
one comes back this way. Entries are listed under their `result`,
DKIM's, then [SPF's](#spf-result-reasons), then
[DMARC's](#dmarc-result-reasons). **[SPF traps](#spf-traps)** are
results that come back without a reason of their own. The parts shown
as … vary.

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

#### `AuthError: spfRecord(): …`

**When**: `spfRecord` could not write the record. The message says why:
`ip4 "…" is not an IPv4 address, or a network such as 192.0.2.0/24` (and
`ip6`), `include "…" is not a domain name`, `include must be an array of
strings` (the same for `ip4` and `ip6`), `all must be one of -all, ~all,
?all, +all, not …`, `a, mx and include make … DNS lookups, more than the 10
RFC 7208 §4.6.4 allows`, or `options must be an object`.

**Fix**: give addresses and domains as arrays of strings, and keep the
lookups to ten: drop an `include`, or list the provider's addresses as
`ip4`, which cost none.

```ts
spfRecord({ mx: true, ip4: ['192.0.2.0/24'], all: '~all' });
```

#### `AuthError: dmarcRecord(): …`

**When**: `dmarcRecord` could not write the record: `p must be one of
none, quarantine, reject, not …` (also `sp`), `adkim must be 'r' or 's',
not …` (also `aspf`), `pct must be an integer from 0 to 100, not …`,
`rua "…" is not an address or a URI (a "!10m" size may end it) without a
comma, a semicolon or a space` (also `ruf`), `rua must be an address, a
URI, or a non-empty array`, `rua must hold addresses or URIs, as strings`.

**Fix**: pass `p` always, one destination per array item, and an address
or a `mailto:` URI. A destination holding a comma or a semicolon would
end the tag early, so it is refused rather than written.

```ts
dmarcRecord({ p: 'quarantine', rua: ['postmaster@example.com'] });
```

#### `AuthError: dkimRecord(): …`

**When**: `dkimRecord` could not write the record: `publicKey is not
base64`, `an ed25519 publicKey is 32 bytes, not …`, `keyType must be 'rsa'
or 'ed25519', not …`, `publicKey must be a base64 string or bytes`.

**Fix**: pass the public key, not the private one: for RSA the
SubjectPublicKeyInfo as base64 or bytes, for Ed25519 the 32 raw bytes
(`crypto.subtle.exportKey('raw', …)`).

```ts
const spki = new Uint8Array(await crypto.subtle.exportKey('spki', publicKey));
dkimRecord({ publicKey: spki });
```

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

#### `AuthError: checkSpf(): resolver must be a Resolver`

**When**: `checkSpf` was called without a `resolver`, or with something
that has no `txt` method. **Fix**: pass one from `@bumail/dns`:
`checkSpf(session, { resolver: cachedResolver(nodeResolver()) })`.

#### `AuthError: checkSpf(): ip must be a string`

**When**: `ip` is missing, or not a string: a number, or an address
object such as `socket.address()` returns. **Fix**: pass the address as
text, `'192.0.2.10'` or `'2001:db8::1'`, such as `socket.remoteAddress`.

#### `AuthError: checkSpf(): ip "…" is not an IPv4 or IPv6 address`

**When**: `ip` is not an address: a host name, an IPv4 address with a
leading zero or a part past 255 (`192.0.2.300`), or an IPv6 address with
a zone (`fe80::1%en0`). **Fix**: pass the client's address as the socket
reports it, such as `socket.remoteAddress`; an IPv4-mapped IPv6 address
is fine, and is checked as IPv4.

#### `AuthError: checkSpf(): mailFrom must be a string`, `AuthError: checkSpf(): helo must be a string`

**When**: `mailFrom` or `helo` is missing or not a string. **Fix**: pass
`''` for a bounce's null sender, and the EHLO argument as it was given,
even if it is not a domain: a bad one gives `none`, not an error.

#### `AuthError: checkSpf(): timeout must be a positive integer of milliseconds, not …`

**When**: `timeout` is zero, negative or not a whole number. **Fix**:
leave it out for 20 000 ms, the least RFC 7208 §4.6.4 recommends.

#### `AuthError: checkSpf(): timeout must be at most 2147483647 ms, not …`

**When**: `timeout` is past 2^31 − 1 ms (about 24.8 days), the longest
delay `setTimeout` takes: a longer one fires after 1 ms, and every check
would be `temperror`. **Fix**: leave it out for 20 000 ms; a check that
should never time out still wants a bound the DNS can meet.

#### `AuthError: checkSpf(): identity must be 'mailfrom' or 'helo', not …`

**When**: `identity` is anything else. **Fix**: leave it out to check
MAIL FROM, or pass `'helo'` to check the HELO name on its own.

#### `AuthError: checkDmarc(): resolver must be a Resolver`

**When**: `checkDmarc` was called without a `resolver`, or with
something that has no `txt` method. **Fix**: pass the one `verifyDkim`
and `checkSpf` use: `{ resolver: cachedResolver(nodeResolver()) }`.

#### `AuthError: checkDmarc(): message must be a Uint8Array, a string or a ReadableStream`

**When**: `message` is missing, or is a parsed object. **Fix**: pass the
message as you passed it to `verifyDkim`, as bytes or a string. Only its
header is read.

#### `AuthError: checkDmarc(): dkim must be the array verifyDkim returned`

**When**: `dkim` is missing, or is one result rather than the array.
**Fix**: pass `await verifyDkim(message, { resolver })` whole; pass `[]`
when DKIM was not checked.

#### `AuthError: checkDmarc(): spf.result must be what checkSpf returned`

**When**: `spf` was given as the `SpfResult` itself, or without its
`result`. **Fix**: wrap it with the identity it was checked for:
`spf: { result: await checkSpf(session, { resolver }), identity: 'mailfrom' }`.
Leave `spf` out when SPF was not checked.

#### `AuthError: checkDmarc(): spf.identity must be 'mailfrom' or 'helo', not …`

**When**: `identity` is missing or misspelled. **Fix**: `'mailfrom'` for
`checkSpf`'s default (bounces included), `'helo'` when you passed it
`identity: 'helo'`.

#### `AuthError: checkDmarc(): organizationalDomain must be a function`, `AuthError: checkDmarc(): random must be a function`

**When**: either option was given a value rather than a function.
**Fix**: `organizationalDomain: (domain) => …` returning the
organizational domain or `undefined`; `random: () => 0.5` returning a
number in [0, 1). Leave them out for the embedded Public Suffix List and
`Math.random`.

#### `AuthError: checkDmarc(): timeout must be a positive integer of milliseconds, not …`

**When**: `timeout` is zero, negative, fractional or not a number.
**Fix**: a whole number of milliseconds, such as `10_000`, or leave it
out for 20 000.

#### `AuthError: checkDmarc(): timeout must be at most 2147483647 ms, not …`

**When**: `timeout` is past what `setTimeout` can wait (about 24.8 days);
a longer delay would fire at once. **Fix**: a smaller value.

#### `AuthError: checkDmarc(): maxHeaderBytes must be an integer of at least 1, not …`

**When**: `maxHeaderBytes` is not a whole number of at least 1. **Fix**:
pass the one you give `verifyDkim`, or leave it out for 256 KiB.

#### `AuthError: formatAuthenticationResults(): authservId must be 1 to 255 characters with no control character, such as the host name`

**When**: the `authservId` is empty, not a string, longer than 255
characters, or holds a control character such as a line break. **Fix**:
your receiving host's name, such as `mx.example.org`.

#### `AuthError: formatAuthenticationResults(): results must be an object of dkim, spf and dmarc`

**When**: the second argument is missing or not an object. **Fix**:
`formatAuthenticationResults(id, { dkim, spf, dmarc })`, or `{}` for
`none`.

#### `AuthError: formatAuthenticationResults(): dkim must be the array verifyDkim returned`

**When**: `dkim` is one result rather than the array. **Fix**: pass
`verifyDkim`'s result whole.

#### `AuthError: formatAuthenticationResults(): … result … is not one of …`

**When**: a `dkim`, `spf` or `dmarc` entry has a `result` that is not a
word of that method, such as a hand-built object, or `spf` given as the
`SpfResult` rather than `{ result, identity }`. **Fix**: pass what
`verifyDkim`, `checkSpf` (wrapped as for `checkDmarc`) and `checkDmarc`
returned. The words are checked so no value can add a result.

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

What `verifyDkim` gives back. [SPF's](#spf-result-reasons) follow.

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

## SPF result reasons

What `checkSpf` gives back. A `permerror` or `temperror` met inside an
`include:` or a `redirect=` comes back with the reason it had there, so
the domain named in it may be another domain than the one checked.

### none

#### `no SPF record at …`

The domain has no TXT record starting with `v=spf1`, or does not exist.
Nothing to fix on your side: the domain publishes no policy.

#### `"…" is not a domain SPF can check`

The MAIL FROM domain (or the HELO name, for a bounce or
`identity: 'helo'`) cannot have a record: a single label such as
`localhost`, an address literal such as `[192.0.2.1]`, an empty label
(`a..example`), a label past 63 characters, or characters no host name
holds (RFC 7208 §4.3). Nothing was looked up.

### pass, fail, softfail, neutral

#### `matched …`

The mechanism named, as written in the record, matched the client; its
qualifier gave the result (`+` pass, `-` fail, `~` softfail, `?`
neutral). It is also in `mechanism`.

#### `no mechanism matched (default neutral)`

No mechanism matched, and the record has no `redirect=`: the result is
`neutral` (§4.7). The domain's record should end with an `all`.

### permerror

#### `more than one SPF record at …`

The domain publishes two or more TXT records starting with `v=spf1`
(§4.5). Its owner must merge them into one.

#### `the SPF record at … holds a non-ASCII character`

The record holds a byte outside ASCII, often a byte-order mark or a
typographic dash pasted in from a document (§3.1). Its owner must retype
it.

#### `syntax error in the SPF record at …: …`

The record does not parse (§4.6). Every term is checked before any is
evaluated, so an error anywhere gives this, even past an `all`. What
follows the colon says which term:

- `unknown mechanism …`: a term that is no mechanism (`moo`, `redirect:…`
  written with a colon, a modifier name not starting with a letter).
- `malformed …`: `all` with something after it (`-all.`, `all:x`).
- `ip4 has no network in …`, `ip6 has no network in …`: `ip4` or `ip6`
  with no `:` address.
- `bad ip4 network in …`, `bad ip6 network in …`: not an address, such as
  `ip4:1.2.3`, `ip4:1.2.3.4:25` or `ip6::CAFE::BABE`.
- `bad CIDR length in …`: past 32 (IPv4) or 128 (IPv6), with a leading
  zero (`/032`), or `a/24/64` where `a/24//64` was meant.
- `an empty domain-spec`: `a:`, `include:`, `exists:`, `ptr:`.
- `"…" is not a domain-spec`: a target that does not end in a top label
  or a macro (§7.1), such as `a:museum`, `a:192.0.2.1` (use `ip4:`),
  `a:example.-com`, or `include:x.example.com/24` (`include` takes no
  CIDR).
- `exp= appears twice`, `redirect= appears twice` (§6).
- `exp=: …`, `redirect=: …`: the modifier's target has one of the errors
  here.
- `unknown macro %{…}`, `macro %{…} keeps zero parts`,
  `malformed macro %{…}`, `a "%" that starts no macro in "…"`: a macro
  that is not §7.1's. `%{c}`, `%{r}` and `%{t}` are allowed only in an
  explanation; a literal `%` is written `%%`.
- `character "…" in "…"`: a control character in a term. Terms are
  separated by spaces only (§4.6.1).

#### `include:… has no SPF record`

An `include:` names a domain with no SPF record, or one that does not
exist (§5.2 makes this a `permerror`, not a non-match).

#### `redirect=… has no SPF record`

The `redirect=` target has no SPF record (§6.1).

#### `more than 10 DNS-querying terms (include, a, mx, ptr, exists, redirect)`

Evaluating the record, its includes and its redirects took an 11th term
that queries the DNS (§4.6.4). Loops end here too. The domain's owner
must flatten the record: replace includes by the `ip4:` and `ip6:` they
resolve to. `lookups` says 11.

#### `more than 2 void lookups (no such name, or no record)`

A third lookup by `a`, `mx`, `ptr` or `exists` found no such name, or no
record (§4.6.4). The record names hosts that no longer exist.

#### `more than 10 MX records for …`

An `mx` mechanism names a domain with more than ten MX records
(§4.6.4). Its owner should list the servers with `ip4:` and `ip6:`.

### temperror

#### `DNS lookup failed: … for …`

The DNS gave no answer for the query named (`TEMPORARY` or `TIMEOUT`), or
the resolver threw something that is not a `DnsError`, whose text is
given instead. Answer the MAIL FROM with a 451 so the sender retries
later.
A reason that reads `DNS lookup failed: DnsError: …` means two copies of
`@bumail/dns` are installed: dedupe the peer.

#### `the check took longer than its timeout (… ms)`

The whole check, every lookup included, passed `timeout`. A slow or
unreachable DNS server is the usual cause. Raise `timeout` only if
yours is slow; the RFC asks for at least 20 seconds, the default.

## DMARC result reasons

What `checkDmarc` gives back. Every reason about the message itself
(From, the header, the stream) comes with an empty `domain`; those of
them under `permerror` come with `disposition: 'reject'`. Every other
reason but a `fail` comes with `disposition: 'none'`.

### pass

#### `aligned DKIM pass for d=…`

A DKIM signature passed, and its `d=` is aligned with the From domain
(§3.1.1). It is also in `alignedDkim`.

#### `aligned SPF pass for …`

SPF passed for the MAIL FROM domain named, and no DKIM signature
aligned; the domain is aligned with From (§3.1.2). It is also in
`alignedSpf`, which is set too when DKIM aligned as well.

### fail

#### `no aligned DKIM or SPF pass`

Neither a passing DKIM signature nor a passing SPF check is aligned with
From. Forwarding and mailing lists cause this for honest mail: SPF fails
from the forwarder's IP, and a list that changes the subject or body
breaks DKIM. `disposition` says what the domain asks; whether to follow
it is yours (§6.7).

### none

#### `no DMARC record at _dmarc.…`, `no DMARC record at _dmarc.… or _dmarc.…`

The From domain, and its organizational domain when it differs, have no
TXT record starting with `v=DMARC1`. The domain publishes no policy. A
record that starts with anything else, such as `v=DMARC1x` or a
lowercase `v=dmarc1`, is not a DMARC record (§6.6.3).

### temperror

#### `DNS lookup failed: … for TXT _dmarc.…`

The DNS gave no answer for the record (`TEMPORARY` or `TIMEOUT`), or the
resolver threw something that is not a `DnsError`, whose text is given
instead. A failure at the From domain is not followed by the
organizational domain's lookup. A reason that reads
`DNS lookup failed: DnsError: …` means the resolver comes from another
copy of `@bumail/dns` than the one `@bumail/auth` loads, so its
`NOT_FOUND` is not recognised: dedupe the peer (one `@bumail/dns` in
`node_modules`). Answer with a 451 so the sender retries.

#### `the check took longer than its timeout (… ms)`

The record lookups passed `timeout`. The resolver is not told to stop;
the check stops waiting for it.

#### `an aligned DKIM or SPF check had a temporary error`

Nothing aligned passed, and a DKIM signature whose `d=` is aligned with
From, or an SPF check of an aligned domain, came back `temperror`
(§6.6.2): a later attempt may pass. A temporary error on a domain that
is not aligned is not counted, so a forger cannot ask for this.

#### `the message could not be read: …`

The message stream failed before its header ended. The error's text
follows the colon. A stream that stalls without failing gives no
result at all: `timeout` bounds the DNS lookups, not the read, so bound
the read where the message comes in.

### permerror

#### `more than one DMARC record at _dmarc.…`

The domain publishes two or more TXT records starting with `v=DMARC1`
(§6.6.3 step 5). No policy applies; its owner must keep one.

#### `the DMARC record at _dmarc.… has no valid p=, and no rua=`

The record has no `p=`, or one that is not `none`, `quarantine` or
`reject`, and no `rua=` URI that parses (§6.6.3 step 6). With one, the
record would be read as `p=none`. No policy applies.

#### `the DMARC record at _dmarc.… has an invalid sp=, and no rua=`

The same for `sp=`, written with a value that is not one of the three.

#### `the message has no From header`

RFC 5322 requires one From field; this message has none (§6.6.1).
`disposition` is `reject`.

#### `the message has more than one From header`

Two or more From fields, in any case (`From`, `FROM`). A reader may be
shown either one, so a forger adds a second to get around `p=reject`
(§6.6.1). A line that starts after a bare CR or LF counts as a field
too, since some readers break lines there. `disposition` is `reject`.

#### `From holds more than one address`

One From field with several mailboxes (`a@example.com, b@example.net`),
which RFC 5322 allows only with a Sender field and DMARC-protected mail
does not use (§6.6.1). `disposition` is `reject`.

#### `From holds no address`

The From field is empty, or holds only white space or a comment.
`disposition` is `reject`.

#### `From does not parse as one mailbox`

The From field is not exactly one RFC 5322 mailbox — `a@example.com`,
`<a@example.com>` or `Name <a@example.com>` — so a mail client and DMARC
could read different authors from it. DMARC reads From strictly, unlike
`@bumail/mime`'s lenient `parseAddressList`, and refuses: a bare name
with no `@`, an address in an unquoted display name
(`a@good.example <x@evil.example>`), two angle addresses or text after
the `>`, an unclosed `<` or a stray `>` or `)`, an unterminated
quoted-string or comment, two `@` in the address, an obs-route
(`<@relay:a@example.com>`), a `;` or an empty list element, a
backslash outside quotes, a domain with an empty label or a trailing
dot, and a control character or a bare CR or LF. A display name in
quotes, an encoded-word or a comment is fine, and never read as the
author: `"a@good.example" <x@evil.example>` is evaluated for
`evil.example`. `disposition` is `reject`. **Fix**: none on the receiving
side; the sender writes a broken or forged From. To flag a display name
that looks like another domain's address, do it in your own policy, on
the parsed From.

#### `From holds a group, not a mailbox`

From is a group (RFC 6854), empty or not: `undisclosed-recipients:;`,
`example.com:;` or `Team: a@example.com;`. A reader is shown the group's
name, which no domain's policy protects, so DMARC cannot evaluate it.
`disposition` is `reject`.

#### `the From domain "…" is not a domain name`

The address's domain is not a name to look up: an address literal such
as `[192.0.2.1]`, an empty label, a label past 63 characters, or more
than 253 characters in all. `disposition` is `reject`.

#### `the header is larger than maxHeaderBytes (…)`

The header did not end within `maxHeaderBytes`, so its From fields could
not all be read. `disposition` is `reject`; raise `maxHeaderBytes` if
your mail has larger headers.

## SPF traps

### A mechanism with a macro never matches, for some senders

**When**: a term such as `exists:%{l}._spf.%{d}`, `a:%{s}.example` or
`exists:%{L}.example` (an uppercase macro, URL-escaped as `%XX`) never matches for
a sender like `bob+news@example.com`, an SRS (`SRS0=…=…@`) or BATV
(`prvs=…=…@`) address, or a local part with `%`, `:`, `/` or a space.
**Why**: the name it expands to holds a character `normalizeName` refuses
(`+ = @ % : /` or a space). `@bumail/dns` refuses such a name before any
query, as Bun's `node:dns` does, so nothing is asked and the term reads as
no records. It is not counted as a void lookup, since no lookup was made.
**Fix**: none on the receiving side today; a resolver that queries any
name on the wire is on `@bumail/dns`' roadmap. The domain's owner can
avoid local-part macros, which RFC 7208 §7.3 already discourages.

### A local-part or HELO macro never matches when the input is long

**When**: `%{l}` or `%{s}` with a local part past 64 octets, or `%{h}`
with a HELO name past 255 octets, RFC 5321's limits (§4.5.3.1). **Why**:
no SMTP client may send one, so the expansion that holds it is treated
like a macro bomb: a name no lookup finds, or no explanation. The check
itself still runs: an over-long input never turns a `fail` into `none`,
which a forger could otherwise ask for, and is never expanded, since
§7.3's truncation from the left would drop the forger's label and could
land on a name the domain publishes, a `pass`. **Fix**: none needed; an
SRS address past 64 octets is one such input, and local-part macros do
not match it.
