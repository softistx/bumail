# Guide

- [Verifying a message](#verifying-a-message)
- [Reading a result](#reading-a-result)
- [Limits](#limits)
- [Signing a message](#signing-a-message)
- [Keys](#keys)
- [Publishing the key](#publishing-the-key)
- [Choosing a canonicalisation](#choosing-a-canonicalisation)
- [Body lengths (`l=`)](#body-lengths-l)
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

`headers` replaces the list, written into `h=` as given:

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
be an address in the domain or in one of its subdomains, and the part after
the `@` a domain name; the signer and the verifier check it the same way. If
you leave it out, a verifier takes it as `@` and the domain.

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

A 2048-bit key is longer than the 255 characters one TXT string can hold.
Split it into several quoted strings in the zone: the DNS joins them, and
`@bumail/dns` hands the joined text over. To retire a key, publish
`v=DKIM1; p=` (empty). Mail signed with it then gives
`permerror` "key revoked (empty p=)", instead of a lookup that might
still find a cached key.

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
