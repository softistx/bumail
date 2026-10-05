# Guide

- [Verifying a message](#verifying-a-message)
- [Reading a result](#reading-a-result)
- [Limits](#limits)
- [Signing a message](#signing-a-message)
- [Keys](#keys)
- [Publishing the key](#publishing-the-key)
- [Writing the DNS records](#writing-the-dns-records), and [comparing one with what is published](#comparing-a-record-with-what-is-published)
- [Choosing a canonicalisation](#choosing-a-canonicalisation)
- [Body lengths (`l=`)](#body-lengths-l)
- [Checking SPF](#checking-spf)
- [Checking DMARC](#checking-dmarc)
- [Writing Authentication-Results](#writing-authentication-results)
- [Writing specs](#writing-specs)

## Verifying a message

`verifyDkim` takes the message as it was received, whole, header and body:
bytes, a string, or a `ReadableStream<Uint8Array>`. It also takes a
`Resolver` to look keys up with.

```ts
import { verifyDkim } from '@bumail/auth';
import { cachedResolver, nodeResolver } from '@bumail/dns';

const resolver = cachedResolver(nodeResolver({ timeout: 3000 }));

// In an SMTP server's DATA hook, with the bytes it received:
const results = await verifyDkim(bytes, { resolver });
const passed = results.filter((r) => r.result === 'pass').map((r) => r.domain);
```

It follows RFC 6376 §6 for each signature, in this order:

1. The tags are read and checked. A tag given twice, a required tag
   missing (`v a b bh d h s`), a value that cannot be, or an `h=` without
   From is a `permerror`. Tags it does not know (`z=`, or any future
   tag) are ignored. A message with more From fields than `h=` lists is
   `policy`: one From is not signed, and a reader may be shown it.
2. The clock is checked. An `x=` in the past or a `t=` in the future,
   beyond `clockSkew`, is `neutral`.
3. The key is looked up at `<s>._domainkey.<d>`. The lookup starts at
   once, so it runs while the body streams. Its key tags are read:
   `v=DKIM1` first if present; `k=` must match the algorithm; an empty
   `p=` means the key was revoked; `h=` must allow sha256; `s=` must
   allow email; `t=y` is testing; `t=s` is strict.
4. The body is canonicalised and hashed. Each canonicalisation and `l=`
   gets one hasher, and they all share the one pass over the stream. The
   hash is compared with `bh=`.
5. The signed header fields are picked bottom-up, as `h=` lists them.
   They are canonicalised and followed by the signature's own field with
   `b=` emptied. Then `b=` is verified: RSASSA-PKCS1-v1_5 over SHA-256,
   or Ed25519 over the SHA-256 of that data.

### Streams

A stream is read only as far as the header needs before the key lookups
start. Then the body flows through the hashers chunk by chunk, so a 50 MB
message never sits in memory. If the stream fails partway through, every
signature still in progress gives a `temperror`
("the message could not be read: …"). If it fails before the header is
complete, no signature was read yet: you get one `temperror` for the
whole message, with no `domain` or other signature field.

```ts
const file = Bun.file('/var/spool/bumail/incoming/1a2b.eml');
const results = await verifyDkim(file.stream(), { resolver });
```

### Line ends

Over SMTP a message ends its lines with CRLF. On disk it is often LF.
`verifyDkim` reads a bare LF as CRLF, in the header and in the body, so
both forms verify the same. A CR not followed by LF is a content byte, as
the RFC says.

## Reading a result

| `result` | means | do |
| --- | --- | --- |
| `pass` | the signature verified: `domain` vouches for this message | use `domain` in DMARC, reputation, `Authentication-Results` |
| `fail` | the body or a signed field changed since it was signed, or the signature is not the key's | treat as unsigned; DMARC decides what that costs |
| `neutral` | the signature expired, or is dated in the future | treat as unsigned |
| `temperror` | the key could not be fetched now (DNS `TEMPORARY` or `TIMEOUT`), or the stream broke | defer the message with a 4xx, or treat as unsigned |
| `permerror` | the signature or its key cannot be valid: bad tags, no key, revoked key, rsa-sha1, a key too short | treat as unsigned |
| `policy` | a limit refused it (`maxHeaderBytes`, `maxSignatures`, `maxSignedHeaders`, `minRsaBits`, `rejectBodyLength`), or the message has a From the signature does not cover | treat as unsigned |
| `none` | the message carries no DKIM-Signature | — |

Each result carries what the signature said, as far as it could be read:

```ts
const [first] = await verifyDkim(message, { resolver });
first.domain; // 'example.com'          d=
first.selector; // 'mail2026'           s=
first.identity; // '@example.com'       i=, or '@' + d= when absent
first.algorithm; // 'ed25519-sha256'    a=
first.signature; // 'dGhpcyBpcyBu…'     b=, for Authentication-Results' header.b
first.signedHeaders; // ['from', 'to', 'subject', 'date', 'message-id', 'from']
first.timestamp; // 1528637909          t=
first.testing; // true when the key says t=y
```

`reason` is the exact text [troubleshooting](troubleshooting.md) lists.
It is meant for logs and for an `Authentication-Results` comment, not for
code to match on: match on `result`.

## Limits

Every limit has a default that suits a public MX:

```ts
await verifyDkim(message, {
	resolver,
	clockSkew: 300, // seconds of tolerance on t= and x=
	maxHeaderBytes: 262_144, // beyond: one policy, nothing else read
	maxSignatures: 10, // the 11th and later: policy, never looked up
	maxSignedHeaders: 64, // a longer h=: policy
	minRsaBits: 1024, // raise to 2048 to refuse 1024-bit keys as policy
	rejectBodyLength: false, // true: any l= is policy
	now: Date.now, // the clock, in milliseconds
});
```

`maxSignatures` bounds the DNS queries one message can cause, and
`maxSignedHeaders` bounds the work of one signature. An option out of
range throws `AuthError` `INVALID_OPTION`, since that is the caller's
error, not the message's.

## Signing a message

```ts
import { importDkimPrivateKey, signDkim } from '@bumail/auth';

const privateKey = await importDkimPrivateKey(pem);
const signature = await signDkim(message, {
	domain: 'example.com',
	selector: 'mail2026',
	privateKey,
	expiresIn: 7 * 24 * 3600, // x= a week after t=; none by default
});
await queue.put(signature + message);
```

Sign the message exactly as it will be sent: after every header the
server adds and before nothing else changes it. The result is the field
to put on top. It comes folded at 78 columns, `b=` last, ending in CRLF:

```
DKIM-Signature: v=1; a=ed25519-sha256; c=relaxed/relaxed; d=example.com;
 s=mail2026; t=1700000000; x=1700604800; h=from: to: subject: date:
 message-id: from: subject: date: to: message-id;
 bh=2jUSOH9NhtVGCQWNr9BrIAPreKQjO6Sn7XIkfJVOzv8=; b=
 1ioBu7kSJ0R9+vw+8VToCZ/2cRI3JI/H84uJC2zOGv0ejQCz7yD1PLdJ2zLDcwLXziIBPjFQ
 Sk32dyyUHAfUBQ==
```

### Which fields are signed

By default, every field of `RECOMMENDED_HEADERS` the message has: From,
Reply-To, Subject, Date, To, Cc, Message-ID, the Resent-* fields,
In-Reply-To, References and the List-* fields (RFC 6376 §5.4.1), and
MIME-Version and Content-Type, which say how the body is read. Each one
is listed once per instance.

Then From, Subject, Date, To, Cc, Reply-To, Message-ID, Content-Type and
MIME-Version are listed once more each, when the message has them.
Listing a field one more time than the message has it is *over-signing*
(§5.4.2): the extra entry signs "no further From". A From, Subject, To or
Date added in transit then breaks the signature, instead of being shown
to the reader above the signed one. A field the message does not have is
not over-signed.

```
h=from: to: subject: date: message-id: from: subject: date: to: message-id
```

`headers` replaces the list, written into `h=` in order and lowercased:

```ts
await signDkim(message, {
	domain: 'example.com',
	selector: 'mail2026',
	privateKey,
	headers: ['from', 'from', 'subject', 'subject', 'date', 'to', 'mime-version', 'content-type'],
});
```

It must include `from`. A name the message does not have is still
allowed: it signs that the field is absent. Each name must be a bare
field name: printable ASCII, without white space, `:` or `;`, which
would end the name or the tag. Anything else throws `AuthError`
`INVALID_OPTION` before the message is read.

### When signing fails

`signDkim` throws `AuthError`. Every failure to read the message is
`INVALID_MESSAGE`: no From field, a header past `maxHeaderBytes`, or a
stream that fails, header or body ("the message could not be read: …").
The stream's own error is kept as `cause`:

```ts
import { AuthError, signDkim } from '@bumail/auth';

try {
	await signDkim(Bun.file(path).stream(), options);
} catch (error) {
	if (error instanceof AuthError && error.code === 'INVALID_MESSAGE') {
		console.error(error.message, error.cause);
	}
}
```

A field `@bumail/mime` cannot fold, such as a header name longer than
998 characters, is `INVALID_OPTION`, with the `MimeError` as `cause`.

### Identity

`identity` writes `i=`, the user or agent the domain signs for. It must
be an address in the domain or in one of its subdomains, the part after the
`@` a domain name, and the whole printable ASCII without `;`. The signer so
refuses every identity a verifier would call `malformed i=`. If you leave it
out, a verifier takes it as `@` and the domain.

## Keys

`importDkimPrivateKey` reads the forms keys come in:

```ts
// openssl genrsa -out dkim.private 2048, or opendkim-genkey: PKCS #1
await importDkimPrivateKey('-----BEGIN RSA PRIVATE KEY-----\n…');
// openssl genpkey -algorithm ed25519, or any PKCS #8 export
await importDkimPrivateKey('-----BEGIN PRIVATE KEY-----\n…');
// a bare base64 Ed25519 key of 32 bytes, as RFC 8463 prints one
await importDkimPrivateKey('nWGxne/9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A=');
```

The key it returns cannot be exported. `signDkim` also takes a
`CryptoKey` you imported or generated yourself. An RSA key needs
`{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }`, an Ed25519 key needs
`{ name: 'Ed25519' }`, and either needs the `sign` usage.

Use RSA with 2048 bits. Add Ed25519 beside it if you like: not every
receiver verifies Ed25519 yet. Two signatures, one per algorithm, under
two selectors are fine, and a verifier passes the message on either.

```ts
const rsa = await signDkim(message, { domain, selector: 'rsa2026', privateKey: rsaKey });
const ed = await signDkim(message, { domain, selector: 'ed2026', privateKey: edKey });
const signed = ed + rsa + message;
```

## Publishing the key

The public key goes in a TXT record at `<selector>._domainkey.<domain>`.
Web Crypto can make the pair and the record:

```ts
const pair = (await crypto.subtle.generateKey(
	{ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
	true,
	['sign', 'verify'],
)) as CryptoKeyPair;
const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
console.log(`mail2026._domainkey.example.com TXT "v=DKIM1; k=rsa; p=${spki.toBase64()}"`);
// For Ed25519: generateKey({ name: 'Ed25519' }, …), exportKey('raw', …), and k=ed25519.
```

`dkimRecord({ publicKey: spki })` writes that value for you, checked: see
[Writing the DNS records](#writing-the-dns-records).

A 2048-bit key is longer than the 255 characters one TXT string can hold.
Split it into several quoted strings in the zone: the DNS joins them, and
`@bumail/dns` hands the joined text over. To retire a key, publish
`v=DKIM1; p=` (empty). Mail signed with it then gives
`permerror` "key revoked (empty p=)", instead of a lookup that might
still find a cached key.

## Writing the DNS records

`spfRecord`, `dmarcRecord` and `dkimRecord` write the text of the three
TXT records a sending domain publishes. Each is the inverse of the parser
that reads it, and each validates, so a record that comes out is one that
`checkSpf`, `checkDmarc` and `verifyDkim` read as written. They return the
text only: `@bumail/dns`'s `formatZone` turns it into zone-file lines, with
a long value split into strings.

```ts
import { dkimRecord, dmarcRecord, spfRecord } from '@bumail/auth';
import { formatZone } from '@bumail/dns';

const zone = formatZone([
	{ name: 'example.com', type: 'TXT', value: spfRecord({ mx: true }) },
	{ name: '_dmarc.example.com', type: 'TXT', value: dmarcRecord({ p: 'none', rua: 'postmaster@example.com' }) },
	{ name: 'mail2026._domainkey.example.com', type: 'TXT', value: dkimRecord({ publicKey: spki }) },
]);
```

**`spfRecord`** puts the mechanisms in a fixed order (`a`, `mx`, the
`include:`s, the `ip4:`s, the `ip6:`s) and ends with `all`, `-all` unless
you pass `~all`, `?all` or `+all`. An `ip4` or `ip6` entry is an address or
a network (`192.0.2.0/24`), checked as the version it names. `a`, `mx` and
each `include` cost a DNS lookup, and RFC 7208 §4.6.4 allows ten: a record
over it is refused here, where a receiver would answer `permerror`. A
domain that sends through a provider adds the provider's `include`.

**`dmarcRecord`** needs `p` (`none`, `quarantine` or `reject`). `sp`,
`adkim`, `aspf`, `pct`, `rua` and `ruf` are written when given, except at
their defaults (`adkim=r`, `aspf=r`, `pct=100`), which are left out. A
report destination is an address, written as `mailto:`, or a URI, with an
optional `!10m` size; a comma, a semicolon or a space in it would end the
tag, so it is refused. Several destinations are an array.

```ts
dmarcRecord({ p: 'none', rua: ['postmaster@example.com', 'https://reports.example/rua!10m'] });
// 'v=DMARC1; p=none; rua=mailto:postmaster@example.com,https://reports.example/rua!10m'
```

A destination in another domain than the one that publishes the record
only gets reports once that domain says it agrees (RFC 7489 §7.1): that is
for the receiving domain to publish.

**`dkimRecord`** takes the public key as base64 or as bytes: for RSA, the
SubjectPublicKeyInfo `crypto.subtle.exportKey('spki', …)` gives; for
Ed25519, the 32 raw bytes. `keyType` is `'rsa'` unless you say
`'ed25519'`, and an Ed25519 key of another length is refused. For RSA it
checks the structure shallowly: a DER SEQUENCE holding the rsaEncryption
OID, so a random string, a private key or a bare PKCS #1 key is refused. It
does not import the key: one that is well-shaped but no key still comes
back from `verifyDkim` as `permerror` `key p= is not an rsa public key`.
`testing: true` adds `t=y`, and an empty `publicKey` writes
`v=DKIM1; p=`, a revoked key.

### Comparing a record with what is published

`sameSpfRecord`, `sameDmarcRecord` and `sameDkimRecord` say whether two
texts are the same record **as the receiver reads it**, which is how to
check that the DNS holds what you wrote. For SPF, white space, case, a
leading `+` and default CIDR lengths (`mx/32`) do not matter. For DMARC,
white space, the case of tag names and `s`/`r`, and default tags
(`adkim=r`, `pct=100`) do not. For DKIM, `sameDkimRecord` ignores white
space, an implied `k=rsa` and the order of tags, but **not case**: a key is
base64, and `V=DKIM1` is not a key record. A record split into several
strings compares the same only once the resolver joins the strings, as
`@bumail/dns` does; the functions take the joined text.

```ts
import { sameDkimRecord, sameDmarcRecord, sameSpfRecord } from '@bumail/auth';

sameSpfRecord('v=spf1 mx -all', 'V=SPF1  +mx  -ALL'); // true
sameSpfRecord('v=spf1 mx -all', 'v=spf1 mx ~all'); // false
sameDmarcRecord('v=DMARC1; p=none', 'v=DMARC1;p=none;adkim=r;pct=100'); // true
sameDkimRecord('v=DKIM1; k=rsa; p=QUJD', 'v=DKIM1; p=QUJD'); // true
```

The order of an SPF record's terms matters, since the first to match
decides. A text the parser cannot read is the same as nothing, so `false`,
even against itself. An SPF record with two copies, or a DMARC one with
two, is for you to look for: each of those is a `permerror` for a receiver.

## Choosing a canonicalisation

`relaxed/relaxed`, the default, survives what forwarders commonly do:
re-folding header lines, changing header name case, trailing white space,
and blank lines at the end. `simple` signs the bytes as they are, and any
of those changes breaks it. Pick `simple` only for mail that goes
straight to the receiver.

## Body lengths (`l=`)

A signature may say it covers only the first `l=` octets of the
canonical body. The verifier honours it, as the RFC says, and reports what
it means:

```ts
const [r] = await verifyDkim(message, { resolver });
if (r.result === 'pass' && r.unsignedBodyLength) {
	// r.bodyLength octets were signed; r.unsignedBodyLength more were not,
	// and anyone could have written them.
}
```

A mailing list can append its footer without breaking the signature. So
can anyone else append anything. Set `rejectBodyLength: true` to answer
`policy` for every `l=`. An `l=` longer than the body is a `permerror`
(§3.5: it "MUST NOT be larger").

## Checking SPF

SPF (RFC 7208) answers one question: may this IP address send mail for
this domain? Ask it once the client has given MAIL FROM, with the
client's address, the envelope sender and the EHLO name:

```ts
import { checkSpf } from '@bumail/auth';
import { cachedResolver, nodeResolver } from '@bumail/dns';

const resolver = cachedResolver(nodeResolver());

const spf = await checkSpf(
	{ ip: session.remoteAddress, mailFrom: 'joe@example.com', helo: 'mail.example.com' },
	{ resolver, receiver: 'mx.example.net' },
);
if (spf.result === 'temperror') reply(451, '4.4.3 SPF check failed, try again later');
```

The check follows `check_host()` (§4): it fetches the domain's one
`v=spf1` TXT record, tries its mechanisms in order — `all`, `include`,
`a`, `mx`, `ptr`, `ip4`, `ip6`, `exists`, with the `+ - ~ ?` qualifiers
and the `a/24//64` CIDR forms — then follows `redirect=`, and otherwise
answers `neutral`. The whole record is parsed before anything is looked
up, so a syntax error anywhere is a `permerror`.

### Which identity

| input | checked |
| --- | --- |
| `mailFrom: 'joe@example.com'` | `example.com`, `<sender>` = `joe@example.com` |
| `mailFrom: '@example.com'` | `example.com`, `<sender>` = `postmaster@example.com` (§4.3) |
| `mailFrom: ''` or `'<>'` (a bounce) | the HELO name, `<sender>` = `postmaster@<helo>` (§2.4) |
| `identity: 'helo'` | the HELO name alone, whatever MAIL FROM is (§2.3) |

A domain that cannot have a record — a single label such as
`localhost`, an address literal such as `[192.0.2.1]`, an empty label, a
label past 63 characters — is `none` at once, with no lookup (§4.3). The
client `ip` may be IPv4 or IPv6; an IPv4-mapped IPv6 address
(`::ffff:192.0.2.1`, as a dual-stack listener reports an IPv4 peer) is
checked as IPv4, so it matches `ip4:` and never `ip6:` (§5).

### Reading an SPF result

| `result` | means | do |
| --- | --- | --- |
| `pass` | the domain lists this IP | use `domain` in DMARC, reputation, `Authentication-Results` |
| `fail` | the domain says this IP may not send for it (`-all`) | DMARC decides; on its own, reject or mark |
| `softfail` | "probably not" (`~all`) | accept, and count it against the message |
| `neutral` | the domain says nothing about this IP (`?all`, or no mechanism matched) | as `none` |
| `none` | no SPF record, or no domain to check | — |
| `temperror` | the DNS gave no answer, or the check passed `timeout` | 451, so the sender retries |
| `permerror` | the record is broken, or passed a limit | treat as `none`, or as `fail` if local policy says so |

`mechanism` is the term that decided, as written in the record that held
it: the `include:` at the top for a match inside one, or the target's own
term after a `redirect=`. `lookups` counts the DNS-querying terms
evaluated. `explanation` is set on `fail` only, when the record that
failed has an `exp=` and its text could be had (§6.2): the `exp=` of an
included record is never used, and one whose lookup or macros fail is
left out without changing the result. Like DKIM's, `reason` is for logs:
match on `result`.

### Limits

RFC 7208 §4.6.4 bounds the work a record can cause, and every one is
applied, across every `include` and `redirect`:

- **10 DNS-querying terms** (`include`, `a`, `mx`, `ptr`, `exists`,
  `redirect`). The 11th is a `permerror`, so an include loop
  (`a` includes `b` includes `a`) stops there. Terms are counted as they
  are evaluated: a record that matches early never reaches its later ones.
- **2 void lookups**: a lookup by `a`, `mx`, `ptr` or `exists` that
  finds no such name, or no record. The 3rd is a `permerror`. The `exp=`
  lookup is never counted, nor a name the resolver refused before any
  query (see below).
- **10 MX names per `mx`**: more is a `permerror`. **10 PTR names per
  `ptr`**: the rest are ignored.
- **`timeout`**, 20 000 ms by default, the least §4.6.4 recommends, and
  at most 2 147 483 647 ms, what a timer can wait: past it the check is
  `temperror`. The resolver is not told to stop; the
  check stops waiting for it.
- **Macro expansion is bounded.** A name longer than 253 characters
  loses labels on the left (§7.3). An expansion past 8 192 characters is
  a macro bomb: it becomes a name no lookup finds, or no explanation.
  Each macro value is split once per check, however many macros use it.
- **A local part past 64 octets, or a HELO name past 255** (RFC 5321's
  limits) expands to a name no lookup finds, like a macro bomb. The check
  still runs and gives its result: answering `none` instead would let a
  forger dodge a domain's `-all` with a long local part, and expanding it
  would be worse, since §7.3's truncation from the left drops the forger's
  label and can land on a name the domain publishes, a `pass`. A
  forwarder's SRS address can be longer than 64 octets; local-part
  macros then never match it, which is the safe side to err on.

`%{p}`, the client's validated name, looks the PTR record up once per
check, and shares it with `ptr`. RFC 7208 discourages both; they cost
DNS queries that are not among the ten.

### Names the DNS layer refuses

`@bumail/dns` checks every name with `normalizeName` before it asks the
DNS, and refuses one holding a character no host name holds: `+`, `=`,
`@`, `%`, `:`, `/` or a space. Bun's `node:dns` refuses them too, so a
resolver on it could not send such a query either. RFC 7208 allows them
in a name built by a macro, so such a name **never matches**: the term
reads as no records, and is not counted as a void lookup, since nothing
was looked up. It happens with:

- `%{l}` or `%{s}` for a sender like `bob+news@example.com`, an SRS
  (`SRS0=…=…@`) or BATV (`prvs=…=…@`) address;
- an uppercase macro (`%{L}`, `%{S}`) whose value holds anything outside
  RFC 3986's unreserved set, which URL escaping writes as `%XX`;
- a target written with `:` or `/`, as the test suite's
  `a:foo:bar/baz.example.com`.

A wire-level resolver able to query any name is on `@bumail/dns`'
roadmap.

### How it compares with the RFC 7208 test suite

The OpenSPF test suite (pyspf's `rfc7208-tests.yml`, committed beside
the specs under the Python Software Foundation licence, in
`src/spf/rfc7208-tests.LICENSE`) runs on every `bun test`. 197 of its 203 cases agree; where
the suite accepts several results, any of them counts. The other six:

- **`a-colon-domain`, `a-colon-domain-ip4mapped`, `mx-colon-domain`,
  `mx-colon-domain-ip4mapped`**: the suite expects `a:foo:bar/baz.example.com`
  to be looked up. `@bumail/dns` refuses a name holding `:` or `/`
  before any query (see [Names the DNS layer refuses](#names-the-dns-layer-refuses)),
  so the mechanism does not match.
- **`macro-mania-in-domain`**: the same, for a name holding spaces and
  `%` built from `%%`, `%_` and `%-`.
- **`v-macro-ip6`**: the result is right; only the case of the
  explanation differs. The suite writes the `%{ir}` nibbles of an IPv6
  address in uppercase, as its input was written. This writes them in
  lowercase, as the RFC's own example (§7.4) does.

## Checking DMARC

DMARC (RFC 7489) asks the question DKIM and SPF leave open: does the
domain a reader sees in From vouch for this message? It takes the From
domain, finds that domain's policy in the DNS, and checks whether a
DKIM signature or the SPF check that passed is *aligned* with From. Ask
it once the message is in, with what `verifyDkim` and `checkSpf` gave:

```ts
import { checkDmarc, checkSpf, verifyDkim } from '@bumail/auth';
import { cachedResolver, nodeResolver } from '@bumail/dns';

const resolver = cachedResolver(nodeResolver());

const dkim = await verifyDkim(message, { resolver });
const spf = { result: await checkSpf(session, { resolver }), identity: 'mailfrom' as const };
const dmarc = await checkDmarc({ message, dkim, spf }, { resolver, timeout: 10_000 });

switch (dmarc.disposition) {
	case 'reject': return reply(550, '5.7.1 Rejected by DMARC policy');
	case 'quarantine': folder = 'Junk'; break;
}
if (dmarc.result === 'temperror') return reply(451, '4.7.0 Try again later');
```

### What it is given

| input | what it is |
| --- | --- |
| `message` | the message, as `verifyDkim` takes it: bytes, a string or a stream. Only the header is read, for From |
| `dkim` | every result `verifyDkim` gave for the same message |
| `spf` | `{ result, identity }`: what `checkSpf` gave, and `'mailfrom'` or `'helo'` for the identity it checked. Leave it out when SPF was not checked |

**Why the message, and not a parsed From.** DMARC must see every From
field: a message with two is the classic way around a domain's
`p=reject`, since a reader may be shown either one, and a parsed value
cannot tell you there was a second. `checkDmarc` reads the header
itself, the fields through `@bumail/mime`'s `parseHeaderBlock` and the
From value through a strict reader of its own (below), from the same
bytes DKIM verified. A stream is read
up to its blank line and then cancelled, so give both functions the
same bytes rather than the same stream.

The From domain is lowercased and, for an IDN, written in its A-labels
(§6.6.1), as every domain in the result is.

### When From cannot be evaluated

§6.6.1 leaves these to the receiver, and says how they are "typically"
handled. `checkDmarc` answers `permerror` with `disposition: 'reject'`,
`policy: 'none'` and `domain: ''`, and looks nothing up:

| the message | `reason` |
| --- | --- |
| has no From field | `the message has no From header` |
| has two or more From fields | `the message has more than one From header` |
| has one From with several addresses | `From holds more than one address` |
| has an empty From | `From holds no address` |
| has a From that is not exactly one mailbox | `From does not parse as one mailbox` |
| has a From that is a group (`undisclosed-recipients:;`) | `From holds a group, not a mailbox` |
| has a From whose domain is not a name (`a@[192.0.2.1]`) | `the From domain "…" is not a domain name` |
| has a header past `maxHeaderBytes` | `the header is larger than maxHeaderBytes (…)` |

**From is read strictly.** `@bumail/mime`'s `parseAddressList` leaves
out what it cannot read, which is right for showing an address and
wrong for DMARC: a reader and the check could then take different
authors from one field. So the From value must be exactly one RFC 5322
mailbox — `a@example.com`, `<a@example.com>` or `Name <a@example.com>`,
with comments and folding anywhere between tokens — and anything else
is `permerror`: an address in an unquoted display name, two angle
addresses, text after the `>`, something left unterminated, a control
character. The domain is always the address's own; a display name is
never read, so `"a@good.example" <x@evil.example>` is evaluated for
`evil.example`, whose owner signs and publishes for it. Flag such a
display name in your own policy if you want to. A group, even an empty
one, is refused too: what a reader is shown is the group's name, which
no policy protects. A message stream that fails
before its header ends is `temperror` (`the message could not be
read: …`), `domain: ''`, `disposition: 'none'`.

### Policy discovery

1. The TXT records at `_dmarc.<From domain>` are fetched, and those that
   do not start with `v=DMARC1` dropped (§6.6.3).
2. If none is left, the same at `_dmarc.<organizational domain>`, when
   it differs from the From domain.
3. No record: `none`. Two or more: `permerror` (`more than one DMARC
   record at …`), with no policy.
4. A record whose `p=` is missing or not `none`, `quarantine` or
   `reject`, or whose `sp=` is not one of the three, is read as `p=none`
   when its `rua=` holds a URI that parses; otherwise it is `permerror`
   (§6.6.3 step 6).

A temporary DNS failure (`TEMPORARY`, `TIMEOUT`, or anything a resolver
throws that is not a `DnsError`) ends discovery with `temperror`, and
with no fallback: the organizational domain's policy might be milder
than the one the DNS did not return. `NOT_FOUND`, and a name
`@bumail/dns` refuses to look up (`_dmarc.` with a From domain of 247
characters or more), read as no record. `timeout` bounds both lookups
together, 20 000 ms by default and at most 2 147 483 647 ms.

The policy that applies is `p=` for the domain the record was found at,
and `sp=` (or `p=` without one) for a subdomain that fell back to its
organizational domain's record. A record published on the subdomain
itself applies its `p=`; its `sp=` is ignored, as §6.3 says.

### The record

Read leniently, as §6.3 asks: unknown tags are ignored, a tag given
twice keeps its first value, tag names and policy values ignore case,
and a value written wrong takes its default. `v=DMARC1` must be first,
in that case.

| tag | in `record` | default |
| --- | --- | --- |
| `p`, `sp` | `p`, `sp`; absent when missing or invalid, and `invalidSp` when `sp=` is written wrong | — |
| `adkim`, `aspf` | `'r'` or `'s'` | `'r'` |
| `pct` | 0 to 100 | 100 |
| `rua`, `ruf` | `[{ uri, maxSize? }]`, the URIs that parse; `!10m` is `maxSize: 10485760` | `[]` |
| `fo` | `['0']`, `['1', 'd', 's']`… | `['0']` |
| `rf` | `['afrf']` | `['afrf']` |
| `ri` | seconds | 86 400 |

**No report is sent.** `rua` and `ruf` are there for an app that sends
aggregate or failure reports itself; the package will, later (see the
roadmap). §7.1's check that a third party agreed to receive reports is
not made either.

### Alignment

A passing DKIM signature aligns when its `d=` matches the From domain;
SPF aligns when it passed for a domain that matches. Strict (`adkim=s`,
`aspf=s`) is an exact match; relaxed, the default, is the same
organizational domain (§3.1). `alignedDkim` is the `d=` of the first
signature that aligns, `alignedSpf` the SPF domain.

| From | DKIM `d=` or SPF domain | strict | relaxed |
| --- | --- | --- | --- |
| `example.com` | `example.com` | aligned | aligned |
| `news.example.com` | `example.com` | — | aligned |
| `example.com` | `bounces.example.com` | — | aligned |
| `a.example.com` | `b.example.com` | — | aligned |
| `example.com` | `example.net` | — | — |
| `example.com` | `com` | — | — |
| `example.co.uk` | `other.co.uk` | — | — |
| `bob.github.io` | `alice.github.io` | — | — |

SPF counts only for `identity: 'mailfrom'`. `checkSpf` checks the HELO
name in its place for a bounce, which RFC 7489 §3.1.2 allows; a check
made with `identity: 'helo'` is not DMARC's.

### The result

| `result` | means | `disposition` |
| --- | --- | --- |
| `pass` | a DKIM signature or SPF check passed and aligned | `none` |
| `fail` | none did | the policy if `sampled`; else `reject` → `quarantine`, `quarantine` → `none` (§6.6.4) |
| `none` | no DMARC record | `none` |
| `temperror` | the record could not be had, the message could not be read, or no aligned pass and an aligned check had a temporary error (§6.6.2) | `none`: answer 451 |
| `permerror` | two records, a record with no usable policy | `none` |
| `permerror` | From cannot be evaluated (see above) | `reject` |

A temporary error counts only on an identifier aligned with From: a
forger who signs with a domain whose DNS they make time out still gets
`fail`. `sampled` is drawn for every message with a record, through
`random()`: `random() * 100 < pct`. `pct=100` and `pct=0` draw nothing.
Pass `random` in specs to choose.

Final disposition is always the receiver's (§6.7): a known forwarder,
or a mailing list that breaks DKIM, may deserve an exception.

### The organizational domain

RFC 7489 §3.2 defines the organizational domain with a public suffix
list. The package embeds a snapshot of the
[Public Suffix List](https://publicsuffix.org), both its ICANN and its
private sections, as a compact trie of every rule past one label:
76 KB, a third of the list's text, decoded once on first use. The
private section matters to DMARC: without it, `alice.github.io` and
`bob.github.io` would share an organizational domain, and one tenant
could align with the other's From.

`PSL_VERSION` names the snapshot, for your logs. `organizationalDomain(domain)` is exported: the domain's public suffix
and one label more, in A-labels, or `undefined` when the domain is
itself a public suffix. A public suffix stands for itself in alignment,
so `d=com` aligns with nothing but `com` (§3.1.1).

The snapshot ages with the package. To use a fresher list, or the one
your platform already keeps, pass your own:

```ts
const dmarc = await checkDmarc(input, {
	resolver,
	organizationalDomain: (domain) => myPsl.registrableDomain(domain) ?? undefined,
});
```

Your function gets a lowercase name in A-labels. An answer that is
neither that name nor one of its parents is ignored, and the name
stands for itself: no function can send the lookup to another domain's
policy.

The repository refreshes the snapshot with
`bun run scripts/refresh-psl.ts`, released as a patch. RFC 9091's
public suffix domains and DMARCbis' DNS tree walk, which replaces the
list with lookups, are on the roadmap.

## Writing Authentication-Results

RFC 8601's `Authentication-Results` field tells the rest of your system
— a filter, the mail client — what was checked and what came of it.
Write it once, with everything this receiver checked:

```ts
import { formatAuthenticationResults } from '@bumail/auth';

const field = formatAuthenticationResults('mx.example.org', { dkim, spf, dmarc });
await store(field + message);
```

```
Authentication-Results: mx.example.org; dkim=pass header.d=example.com
 header.s=sel header.b="kbV+/mUa"; spf=pass smtp.mailfrom=bounces.example.com;
 dmarc=pass header.from=news.example.com
```

| method | properties |
| --- | --- |
| `dkim=` | one per `verifyDkim` result: `header.d` (`d=`), `header.s` (`s=`), `header.b` (the first 8 characters of `b=`, RFC 6008), each when the signature had it |
| `spf=` | `smtp.mailfrom`, or `smtp.helo` for `identity: 'helo'`: the domain checked |
| `dmarc=` | `header.from`: the From domain, when there was one |

Each argument may be left out; with none, the field is `authserv-id;
none` (RFC 8601 Appendix B.2). The result is folded at 78 columns by
`@bumail/mime`'s `foldHeader` and ends with CRLF.

**Values are written so none can end a result or add a line.** A token
is written as it is; anything else (`header.b`'s `/` and `=`, a `;`, a
space, a non-ASCII domain) is a quoted-string, its `"` and `\`
escaped (§2.2). A value holding a control character (CR and LF among
them), or longer than 255 characters, is left out with its property: a
MAIL FROM domain checkSpf could not read can hold anything. An
`authservId` that cannot be written, or a result word that is not one
of the method's, is an `AuthError`.

Before you add yours, remove any `Authentication-Results` field already
on the message that names your `authserv-id`: a sender can forge one
that says `dmarc=pass` (RFC 8601 §5).

## Writing specs

Give `verifyDkim` a `fixtureResolver` from `@bumail/dns`, and no spec
ever leaves the machine:

```ts
import { signDkim, verifyDkim } from '@bumail/auth';
import { fixtureResolver } from '@bumail/dns';

const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
const p = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)).toBase64();
const resolver = fixtureResolver({
	'sel._domainkey.example.com': { txt: [`v=DKIM1; k=ed25519; p=${p}`] },
	'down._domainkey.example.com': { txt: 'TEMPORARY' }, // temperror
});

const signature = await signDkim(message, { domain: 'example.com', selector: 'sel', privateKey: pair.privateKey, now: () => 0 });
const [result] = await verifyDkim(signature + message, { resolver, now: () => 0 });
// result.result === 'pass'
```

Pass the same `now` to both, so a spec does not depend on the date.
`fixtureResolver(...).queries` counts the key lookups, if a spec needs to
show that a limit stopped them.

SPF is specified the same way, a record per name:

```ts
const resolver = fixtureResolver({
	'example.com': { txt: ['v=spf1 mx include:_spf.example.net -all'], mx: [{ exchange: 'mx.example.com', priority: 10 }] },
	'mx.example.com': { a: ['192.0.2.25'] },
	'_spf.example.net': { txt: 'TIMEOUT' }, // temperror
});
const spf = await checkSpf({ ip: '192.0.2.25', mailFrom: 'joe@example.com', helo: 'mx.example.com' }, { resolver });
// spf.result === 'pass', spf.lookups === 1: the include was never reached
```

DMARC needs only a record at `_dmarc.<domain>`; give `random` to choose
whether `pct` samples:

```ts
const resolver = fixtureResolver({
	'_dmarc.example.com': { txt: ['v=DMARC1; p=reject; pct=50'] },
	'_dmarc.down.example': { txt: 'TEMPORARY' }, // temperror
});
const message = 'From: joe@news.example.com\r\nSubject: hi\r\n\r\nHello\r\n';
const dmarc = await checkDmarc({ message, dkim: [] }, { resolver, random: () => 0.9 });
// dmarc.result === 'fail', policyDomain === 'example.com', sampled === false, disposition === 'quarantine'
```
