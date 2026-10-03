# @bumail/auth

Message authentication for a mail server: **DKIM** (RFC 6376), **SPF**
(RFC 7208), **DMARC** (RFC 7489) and the **`Authentication-Results`**
header (RFC 8601). Verify every `DKIM-Signature` on a message, and sign
the mail you send, with rsa-sha256 and ed25519-sha256 (RFC 8463) through
Web Crypto and simple or relaxed canonicalisation. Check whether the
connecting IP may send for the MAIL FROM domain, with RFC 7208's lookup
limits and macros. Find the From domain's DMARC policy, align DKIM and
SPF with From, and get the disposition the policy asks for. Write it all
into one `Authentication-Results` field. Results are in RFC 8601's words.
No dependency: the DNS comes from `@bumail/dns`, header parsing and
folding from `@bumail/mime`.

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
import { cachedResolver, nodeResolver } from '@bumail/dns';

const resolver = cachedResolver(nodeResolver());

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

## Check DMARC

```ts
import { checkDmarc, checkSpf, formatAuthenticationResults, verifyDkim } from '@bumail/auth';
import { cachedResolver, nodeResolver } from '@bumail/dns';

const resolver = cachedResolver(nodeResolver());

// In the SMTP server's DATA hook, with the message as bytes or a string:
const dkim = await verifyDkim(message, { resolver });
const spf = {
	result: await checkSpf({ ip, mailFrom, helo }, { resolver }), // or keep the one from MAIL FROM
	identity: 'mailfrom' as const,
};
const dmarc = await checkDmarc({ message, dkim, spf }, { resolver });
dmarc.result; // 'pass' | 'fail' | 'none' | 'temperror' | 'permerror'
dmarc.disposition; // 'none' | 'quarantine' | 'reject': what the domain asks for this message
dmarc.policy; // the p= (or sp=) that applies; dmarc.policyDomain is where it was found
dmarc.alignedDkim; // 'example.com': the d= that passed and aligned with From
dmarc.record?.rua; // [{ uri: 'mailto:dmarc@example.com' }]: parsed, never sent to

const field = formatAuthenticationResults('mx.example.org', { dkim, spf, dmarc });
// Authentication-Results: mx.example.org; dkim=pass header.d=example.com
//  header.s=sel header.b=EToRSuvU; spf=pass smtp.mailfrom=example.com;
//  dmarc=pass header.from=example.com
const delivered = field + message; // the field ends with CRLF

if (dmarc.disposition === 'reject') reply(550, '5.7.1 Rejected by the sender domain\'s DMARC policy');
if (dmarc.result === 'temperror') reply(451, '4.7.0 DMARC check failed, try again later');
```

`checkDmarc` reads the message's header only, for From. It looks the
policy up at `_dmarc.<From domain>`, and then at the organizational domain
(`_dmarc.example.com` for `news.example.com`). A passing DKIM signature or
SPF check aligned with From makes it `pass`: relaxed alignment (the
default) needs the same organizational domain, strict (`adkim=s`,
`aspf=s`) an exact match. `pct` is applied through `random` (by default
`Math.random`). **`checkDmarc` never throws for what the message, the DNS
or a record holds.** It throws `AuthError` only for an input or option it
cannot take.

The organizational domain comes from a snapshot of the
[Public Suffix List](https://publicsuffix.org) the package embeds, ICANN
and private sections both. Pass `organizationalDomain` to use your own;
`organizationalDomain(domain)` is exported too.

`formatAuthenticationResults` writes one `dkim=` per signature, then
`spf=` and `dmarc=`, folded at 78 columns. Leave out what you did not
check; with nothing, it writes `none`.

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
- **A macro that expands to a name the DNS layer refuses never matches.**
  `exists:%{l}._spf.%{d}` for `bob+news@example.com` builds a name with
  `+`; `@bumail/dns` (like Bun's `node:dns`) refuses `+ = @ % : /` and
  spaces before any query, so the term reads as no records. It costs no
  void lookup. SRS and BATV senders, `%{s}`, and uppercase macros (URL-escaped as
  `%XX`) hit this.
- **Look up through a cache.** One check can make over a hundred queries
  (10 terms, each `mx` or `ptr` with up to 10 names to look up);
  `cachedResolver` shares them between messages.

### DMARC

- **A message `checkDmarc` cannot evaluate is `permerror` with
  `disposition: 'reject'`.** No From, two From fields, or one From with
  two addresses (§6.6.1): a second From is the classic way around a
  `p=reject`, and a reader may be shown either one. Decide what to do
  with these on `reason`.
- **`temperror` is not `fail`.** The DMARC record could not be had, or an
  aligned DKIM or SPF check had a temporary error. `disposition` is
  `none`; answer with a 451 so the sender retries.
- **A temporary error counts only on an aligned identifier.** A forger
  who signs with a domain whose DNS they make time out still gets `fail`.
- **`pct` lets some failing mail through, one step milder.** Not sampled,
  `reject` becomes `quarantine` and `quarantine` becomes `none`
  (§6.6.4). `sampled` says which it was.
- **SPF aligns only for `identity: 'mailfrom'`.** A HELO check is not
  DMARC's (§3.1.2), except the HELO name `checkSpf` checks for a bounce,
  which it does as `mailfrom`.
- **The Public Suffix List is a snapshot.** A suffix added after this
  version of the package is not known: its tenants share one
  organizational domain until you update the package, or pass a fresher
  `organizationalDomain`.
- **No report is sent.** `rua` and `ruf` are parsed and returned; sending
  aggregate and failure reports is on the roadmap.
- **A stream is read up to the header's end, then cancelled.** Pass
  `checkDmarc` and `verifyDkim` the same bytes, not the same stream.
  `timeout` bounds the DNS lookups only: a stream that stalls before
  its blank line stalls the check, as it does `verifyDkim`. Bound the
  read in your SMTP server.

### Authentication-Results

- **Remove the fields already on the message that claim your
  `authserv-id`** before adding yours (RFC 8601 §5): a sender can write
  one that says `dmarc=pass`.
- **A value that holds a control character is left out.** A domain from a
  hostile MAIL FROM can hold anything; the property goes rather than a
  line break. A value that is not a token, such as `header.b`'s base64,
  is quoted.

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
| `CheckSpfOptions` | `resolver` (required), `identity` (`'mailfrom'` or `'helo'`), `timeout` (20 000 ms, at most 2 147 483 647), `receiver` (`%{r}`), `now` |
| `SpfResult` | `result`, `reason`, `domain`, `mechanism`, `explanation`, `lookups` |
| `SpfResultWord` | `'none' \| 'neutral' \| 'pass' \| 'fail' \| 'softfail' \| 'temperror' \| 'permerror'` |
| `checkDmarc(input, options)` | RFC 7489 for a message: `Promise<DmarcResult>` |
| `DmarcInput` | `message` (as `verifyDkim` takes it; only the header is read), `dkim` (`verifyDkim`'s results), `spf` (an `SpfCheck`, optional) |
| `SpfCheck` | `result` (what `checkSpf` gave), `identity` (`'mailfrom'` or `'helo'`) |
| `CheckDmarcOptions` | `resolver` (required), `organizationalDomain` (the embedded PSL), `random` (`Math.random`), `timeout` (20 000 ms, at most 2 147 483 647), `maxHeaderBytes` (256 KiB) |
| `DmarcResult` | `result`, `reason`, `domain` (From), `policyDomain`, `policy`, `disposition`, `alignedDkim`, `alignedSpf`, `sampled`, `record` |
| `DmarcResultWord` | `'pass' \| 'fail' \| 'none' \| 'temperror' \| 'permerror'` |
| `DmarcPolicy` | `'none' \| 'quarantine' \| 'reject'` |
| `DmarcRecord` | `p`, `sp`, `invalidSp`, `adkim`, `aspf`, `pct`, `rua`, `ruf`, `fo`, `rf`, `ri`, defaults filled in |
| `DmarcUri` | `uri`, `maxSize` (bytes, from `!10m`) |
| `organizationalDomain(domain)` | the organizational domain (RFC 7489 §3.2) from the embedded Public Suffix List, in A-labels; `undefined` for a public suffix or a name that cannot be looked up |
| `PSL_VERSION` | the `VERSION` of the embedded Public Suffix List snapshot, such as `2026-10-01_23-02-52_UTC`, for logs |
| `formatAuthenticationResults(authservId, results)` | the `Authentication-Results` field (RFC 8601), folded, CRLF included |
| `AuthenticationResultsInput` | `dkim` (`DkimResult[]`), `spf` (`SpfCheck`), `dmarc` (`DmarcResult`), each optional |
| `AuthError`, `AuthErrorCode` | thrown for an option or input, an `ip`, a message to sign or a key: `INVALID_OPTION`, `INVALID_MESSAGE`, `INVALID_KEY`; `cause` holds a wrapped error |

## Documentation

- [Guide](https://github.com/softistx/bumail/blob/develop/packages/auth/docs/guide.md): verifying, results, signing, keys, limits, SPF, DMARC, `Authentication-Results` and specs
- [Troubleshooting](https://github.com/softistx/bumail/blob/develop/packages/auth/docs/troubleshooting.md): every error and every result reason
- [Roadmap](https://github.com/softistx/bumail/blob/develop/packages/auth/docs/roadmap.md)

## License

MIT. The embedded Public Suffix List snapshot
(`src/dmarc/psl-data.ts`, in `dist/index.js`) is the Mozilla Public
License 2.0's, from [publicsuffix.org](https://publicsuffix.org/list/).
