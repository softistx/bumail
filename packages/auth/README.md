# @bumail/auth

Message authentication for a mail server. This first release is **DKIM**
(RFC 6376) and **SPF** (RFC 7208). Verify every `DKIM-Signature` on a
message, and sign the mail you send, with rsa-sha256 and ed25519-sha256
(RFC 8463) through Web Crypto and simple or relaxed canonicalisation.
Check whether the connecting IP may send for the MAIL FROM domain, with
RFC 7208's lookup limits and macros. Results are in RFC 8601's words.
DMARC and the `Authentication-Results` header come next. No dependency:
the DNS comes from `@bumail/dns`, and header folding from `@bumail/mime`.

**Bun only**, like every `@bumail/*` package: it runs on Bun 1.4.2 or
later.

```sh
bun add @bumail/auth @bumail/dns @bumail/mime
```

## Verify

```ts
import { verifyDkim } from '@bumail/auth';
import { cachedResolver, nodeResolver } from '@bumail/dns';

const resolver = cachedResolver(nodeResolver());

const results = await verifyDkim(message, { resolver }); // bytes, a string, or a ReadableStream
for (const r of results) {
	r.result; // 'pass' | 'fail' | 'neutral' | 'temperror' | 'permerror' | 'policy' | 'none'
	r.reason; // why, for anything but pass: 'body hash did not verify', 'no key at …'
	r.domain; // d=, the domain that signed: what DMARC aligns with From
}
```

You get one result per signature, in header order. A message with no
signature gives one `none`. **`verifyDkim` never throws for a message**:
a malformed tag, a missing key, a DNS failure or a broken stream each come
back as a result. It throws `AuthError` only for an option it cannot take.

The body is streamed once and hashed with bounded memory. Key lookups run
while it streams. A `ReadableStream` straight from the SMTP `DATA` works
as well as bytes.

## Sign

```ts
import { importDkimPrivateKey, signDkim } from '@bumail/auth';

const privateKey = await importDkimPrivateKey(await Bun.file('dkim.private').text());

const signature = await signDkim(message, {
	domain: 'example.com',
	selector: 'mail2026',
	privateKey, // RSA (2048 bits recommended) or Ed25519
});
const signed = signature + message; // the field ends with CRLF
```

By default it signs the fields of RFC 6376 §5.4.1 that the message has,
plus Message-ID, MIME-Version and Content-Type. It then lists From,
Subject, Date, To, Cc, Reply-To, Message-ID, Content-Type and
MIME-Version once more each, when present: this "over-signing" means a
second copy of any of them, added later, breaks the signature. The field
comes folded at 78 columns, with `b=` last, `c=relaxed/relaxed` and a
`t=`. The key
record to publish at `mail2026._domainkey.example.com` is `v=DKIM1;
k=rsa; p=<the base64 SubjectPublicKeyInfo>`, or `k=ed25519; p=<the 32 raw
bytes>`. The [guide](https://github.com/softistx/bumail/blob/develop/packages/auth/docs/guide.md#publishing-the-key)
shows how to make both.

`signDkim` throws `AuthError` for what it cannot sign: an option it
cannot take (`INVALID_OPTION`), a message with no From, a header past
`maxHeaderBytes`, or a stream that fails (`INVALID_MESSAGE`). A wrapped
failure is kept as the error's `cause`.

## Check SPF

```ts
import { checkSpf } from '@bumail/auth';

// In the SMTP server's MAIL FROM hook: the client's IP, the envelope sender, the EHLO name.
const spf = await checkSpf(
	{ ip: '192.0.2.10', mailFrom: 'joe@example.com', helo: 'mail.example.com' },
	{ resolver },
);
spf.result; // 'pass' | 'fail' | 'softfail' | 'neutral' | 'none' | 'temperror' | 'permerror'
spf.reason; // 'matched ip4:192.0.2.0/24', 'no SPF record at example.com', …
spf.domain; // 'example.com': what DMARC aligns with From
spf.mechanism; // the term that decided, as written: '-all', 'include:_spf.example.net'
spf.explanation; // on fail, the domain's exp= text, when it has one
```

A bounce (`mailFrom: ''`) is checked as `postmaster@` the HELO name.
`identity: 'helo'` checks the HELO name on its own. **`checkSpf` never
throws for what the DNS or a record holds**: a broken record, a loop, a
DNS failure or a hostile macro each come back as a result. It throws
`AuthError` only for an option or an `ip` it cannot take.

It follows RFC 7208's `check_host()`, with every mechanism (`ptr`
included, though discouraged), `redirect=`, `exp=` and the macros. It
stops at 10 DNS-querying terms, 2 void lookups and 10 MX or PTR names,
and gives up with `temperror` after `timeout` (20 s). It agrees with 197
of the 203 cases of the OpenSPF RFC 7208 test suite; the
[guide](https://github.com/softistx/bumail/blob/develop/packages/auth/docs/guide.md#checking-spf)
lists the other six.

## Traps

### DKIM

- **`l=` is honoured, and it is a weakness.** A signature with a body
  length covers only that many octets. Anyone can add text after them,
  and the signature still passes. The result carries `bodyLength` and
  `unsignedBodyLength`; set `rejectBodyLength: true` to answer `policy`
  instead. `signDkim` never writes `l=`.
- **`pass` is about the signing domain, not about From.** A signature
  from `d=bulk-mailer.example` passes on mail "From" anyone. Whether that
  domain matches From is DMARC's question.
- **A From the signature does not cover is `policy`.** When the message
  has more From fields than `h=` lists, one of them is unsigned, and a
  reader may be shown that one. A signer that over-signs From gets
  `fail` instead, as RFC 6376 §5.4.2 intends.
- **A header past `maxHeaderBytes` is one `policy`** for the whole
  message, like the other limits: nothing else is read.
- **`testing: true`** (the key says `t=y`) asks you to treat a failure
  like no signature at all.
- **rsa-sha1 and RSA keys under 1024 bits are `permerror`** (RFC 8301).
  `minRsaBits: 2048` answers `policy` for keys between 1024 and 2048 bits.
- **A message stored with LF line ends verifies.** A bare LF is read as
  CRLF, so the stored message hashes as the one sent over SMTP. A CR
  without an LF is content.

### SPF

- **SPF checks the envelope, not From.** `pass` says the IP may send for
  the MAIL FROM (or HELO) domain. The From a reader sees can be anything.
  Whether the two match is DMARC's question.
- **Forwarding breaks SPF.** A message forwarded by another server
  arrives from that server's IP, which the sender's record does not
  list: an honest message gets `fail` or `softfail`. Do not reject on SPF
  alone. DKIM survives forwarding, and DMARC needs only one of the two.
- **`temperror` is not `fail`.** The DNS did not answer. Answer the
  MAIL FROM with a 451 so the sender retries, rather than a 550.
- **`softfail` (`~all`) is a "probably not".** Most domains publish
  `~all`; treat it as suspicious, not as refused.
- **Look up through a cache.** One check can make over a hundred queries
  (10 terms, each `mx` or `ptr` with up to 10 names to look up);
  `cachedResolver` shares them between messages.

## API

| export | what it is |
| --- | --- |
| `verifyDkim(message, options)` | every DKIM-Signature checked: `Promise<DkimResult[]>`, one per signature, or one `none` |
| `VerifyDkimOptions` | `resolver` (required), `now`, `clockSkew` (300 s), `maxHeaderBytes` (256 KiB), `maxSignatures` (10), `maxSignedHeaders` (64), `minRsaBits` (1024), `rejectBodyLength` (false) |
| `DkimResult` | `result`, `reason`, `domain`, `selector`, `identity`, `algorithm`, `signature` (b=), `signedHeaders`, `bodyLength`, `unsignedBodyLength`, `timestamp`, `expires`, `testing` |
| `DkimResultWord` | `'pass' \| 'fail' \| 'neutral' \| 'temperror' \| 'permerror' \| 'policy' \| 'none'` |
| `signDkim(message, options)` | the `DKIM-Signature` field to put on top, CRLF included |
| `SignDkimOptions` | `domain`, `selector`, `privateKey` (required); `algorithm`, `headers`, `canonicalization`, `identity`, `expiresIn`, `now`, `maxHeaderBytes` |
| `RECOMMENDED_HEADERS` | the fields signed by default, when present: RFC 6376 §5.4.1's, Message-ID, MIME-Version and Content-Type |
| `importDkimPrivateKey(text)` | a PEM `RSA PRIVATE KEY` (PKCS #1), a PEM `PRIVATE KEY` (PKCS #8) or a base64 Ed25519 key, as a signing `CryptoKey` |
| `DkimAlgorithm` | `'rsa-sha256' \| 'ed25519-sha256'` |
| `Canonicalization`, `CanonicalizationPair` | `'simple' \| 'relaxed'`, and `'relaxed/relaxed'` and the three others |
| `MessageInput` | `Uint8Array \| string \| ReadableStream<Uint8Array>` |
| `checkSpf(input, options)` | RFC 7208's check_host() for a session: `Promise<SpfResult>` |
| `SpfInput` | `ip` (IPv4 or IPv6; IPv4-mapped is IPv4), `mailFrom` (`''` for a bounce), `helo` |
| `CheckSpfOptions` | `resolver` (required), `identity` (`'mailfrom'` or `'helo'`), `timeout` (20 000 ms), `receiver` (`%{r}`), `now` |
| `SpfResult` | `result`, `reason`, `domain`, `mechanism`, `explanation`, `lookups` |
| `SpfResultWord` | `'none' \| 'neutral' \| 'pass' \| 'fail' \| 'softfail' \| 'temperror' \| 'permerror'` |
| `AuthError`, `AuthErrorCode` | thrown for an option, an `ip`, a message to sign or a key: `INVALID_OPTION`, `INVALID_MESSAGE`, `INVALID_KEY`; `cause` holds a wrapped error |

## Documentation

- [Guide](https://github.com/softistx/bumail/blob/develop/packages/auth/docs/guide.md): verifying, results, signing, keys, limits, SPF and specs
- [Troubleshooting](https://github.com/softistx/bumail/blob/develop/packages/auth/docs/troubleshooting.md): every error and every result reason
- [Roadmap](https://github.com/softistx/bumail/blob/develop/packages/auth/docs/roadmap.md)

## License

MIT
