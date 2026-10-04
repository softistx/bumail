# Troubleshooting

Each entry is headed by the message of the `AcmeError` thrown; its `code`
is the group it is listed under. The parts shown as … vary. A value you
passed is shown quoted and cut to 80 characters when it is a string, and
by its kind (`number`, `bigint`, `null`, `an array`) otherwise. Every
message starts with the function that threw it — for the client, its
method (`newOrder():`), or `AcmeClient:` for its constructor — except
where the `…` at its start names the function and the argument, as
`signJws(): keyPair.privateKey`. `keyAuthorization` throws
`jwkThumbprint`'s messages for its key. Text from the CA, a problem's
`detail`, is shown on one line, its control characters dropped, cut to
300 characters; `error.problem` keeps it to 1024.

The first five groups are about what you passed, and retrying as is
changes nothing; the others are about the CA's answer, or the way to it.

**INVALID_NAME**

- [`AcmeError: createCsr(): a name is a string, not …`](#acmeerror-createcsr-a-name-is-a-string-not-)
- [`AcmeError: createCsr(): "…" holds a space or a control character`](#acmeerror-createcsr--holds-a-space-or-a-control-character)
- [`AcmeError: createCsr(): "…" is not ASCII; give an internationalized name as its A-labels (xn--…)`](#acmeerror-createcsr--is-not-ascii-give-an-internationalized-name-as-its-a-labels-xn--)
- [`AcmeError: createCsr(): "…" is a wildcard name, which this package does not request`](#acmeerror-createcsr--is-a-wildcard-name-which-this-package-does-not-request)
- [`AcmeError: createCsr(): "…" ends with a dot; give the name without it`](#acmeerror-createcsr--ends-with-a-dot-give-the-name-without-it)
- [`AcmeError: createCsr(): "…" is longer than 253 characters`](#acmeerror-createcsr--is-longer-than-253-characters)
- [`AcmeError: createCsr(): "…" has an empty label`](#acmeerror-createcsr--has-an-empty-label)
- [`AcmeError: createCsr(): "…" has a label longer than 63 characters`](#acmeerror-createcsr--has-a-label-longer-than-63-characters)
- [`AcmeError: createCsr(): "…" has a label that is not letters, digits and inner hyphens: "…"`](#acmeerror-createcsr--has-a-label-that-is-not-letters-digits-and-inner-hyphens-)
- [`AcmeError: createCsr(): "…" is a single label; a certificate name has at least two`](#acmeerror-createcsr--is-a-single-label-a-certificate-name-has-at-least-two)
- [`AcmeError: createCsr(): "…" ends in a numeric label, as an IP address does; only DNS names are supported`](#acmeerror-createcsr--ends-in-a-numeric-label-as-an-ip-address-does-only-dns-names-are-supported)

**INVALID_OPTION**

- [`AcmeError: createCsr(): options must be an object`](#acmeerror-createcsr-options-must-be-an-object)
- [`AcmeError: createCsr(): names must be an array of DNS names`](#acmeerror-createcsr-names-must-be-an-array-of-dns-names)
- [`AcmeError: createCsr(): names must hold at least one name`](#acmeerror-createcsr-names-must-hold-at-least-one-name)
- [`AcmeError: createCsr(): names holds … names; at most 100 fit one certificate`](#acmeerror-createcsr-names-holds--names-at-most-100-fit-one-certificate)
- [`AcmeError: createCsr(): "…" is given twice`](#acmeerror-createcsr--is-given-twice)
- [`AcmeError: signJws(): options must be an object`](#acmeerror-signjws-options-must-be-an-object)
- [`AcmeError: signJws(): nonce must be the server's Replay-Nonce, a non-empty base64url string, not …`](#acmeerror-signjws-nonce-must-be-the-servers-replay-nonce-a-non-empty-base64url-string-not-)
- [`AcmeError: signJws(): … must be an https: URL without white space, credentials or a fragment, not …`](#acmeerror-signjws--must-be-an-https-url-without-white-space-credentials-or-a-fragment-not-)
- [`AcmeError: signJws(): payload must be an object or left out for POST-as-GET, not …`](#acmeerror-signjws-payload-must-be-an-object-or-left-out-for-post-as-get-not-)
- [`AcmeError: signJws(): payload cannot be written as JSON: …`](#acmeerror-signjws-payload-cannot-be-written-as-json-)
- [`AcmeError: signJws(): payload does not write a JSON object; its toJSON() returns something else`](#acmeerror-signjws-payload-does-not-write-a-json-object-its-tojson-returns-something-else)
- [`AcmeError: generateKeyPair(): the type is 'P-256' or 'RSA-2048', not …`](#acmeerror-generatekeypair-the-type-is-p-256-or-rsa-2048-not-)
- [`AcmeError: importKeyPairPem(): options must be an object`](#acmeerror-importkeypairpem-options-must-be-an-object)
- [`AcmeError: importKeyPairPem(): extractable must be a boolean`](#acmeerror-importkeypairpem-extractable-must-be-a-boolean)
- [`AcmeError: …: options must be an object`](#acmeerror--options-must-be-an-object)
- [`AcmeError: AcmeClient: allowInsecure must be a boolean`](#acmeerror-acmeclient-allowinsecure-must-be-a-boolean)
- [`AcmeError: …: … must be an https: URL without credentials or a fragment (http: only with allowInsecure), not …`](#acmeerror---must-be-an-https-url-without-credentials-or-a-fragment-http-only-with-allowinsecure-not-)
- [`AcmeError: AcmeClient: fetch must be a function`](#acmeerror-acmeclient-fetch-must-be-a-function)
- [`AcmeError: …: … must be an integer from … to …, not …`](#acmeerror---must-be-an-integer-from--to--not-)
- [`AcmeError: …: signal must be an AbortSignal`](#acmeerror--signal-must-be-an-abortsignal)
- [`AcmeError: newAccount(): contact must be an array of at most 10 mailto: URLs, not …`](#acmeerror-newaccount-contact-must-be-an-array-of-at-most-10-mailto-urls-not-)
- [`AcmeError: newAccount(): a contact is a mailto: URL with one address, not …`](#acmeerror-newaccount-a-contact-is-a-mailto-url-with-one-address-not-)
- [`AcmeError: newAccount(): … must be a boolean`](#acmeerror-newaccount--must-be-a-boolean)
- [`AcmeError: newOrder(): identifiers must be an array of 1 to 100 identifiers, not …`](#acmeerror-neworder-identifiers-must-be-an-array-of-1-to-100-identifiers-not-)
- [`AcmeError: newOrder(): an identifier is { type: 'dns', value: <a name> }, its value printable ASCII of at most 253 characters, not …`](#acmeerror-neworder-an-identifier-is--type-dns-value-a-name--its-value-printable-ascii-of-at-most-253-characters-not-)
- [`AcmeError: finalize(): order must be an order from newOrder() or waitForOrder()`](#acmeerror-finalize-order-must-be-an-order-from-neworder-or-waitfororder)
- [`AcmeError: finalize(): csr must be a Csr from createCsr() or its DER bytes`](#acmeerror-finalize-csr-must-be-a-csr-from-createcsr-or-its-der-bytes)
- [`AcmeError: obtainCertificate(): client must be an AcmeClient`](#acmeerror-obtaincertificate-client-must-be-an-acmeclient)
- [`AcmeError: obtainCertificate(): http01 must be { set(token, keyAuthorization), remove(token) }`](#acmeerror-obtaincertificate-http01-must-be--settoken-keyauthorization-removetoken-)
- [`AcmeError: http01Responder(): the key authorization of a token is "<token>.<thumbprint>", not …`](#acmeerror-http01responder-the-key-authorization-of-a-token-is-tokenthumbprint-not-)
- [`AcmeError: http01Responder(): it already serves 1000 tokens; remove some first`](#acmeerror-http01responder-it-already-serves-1000-tokens-remove-some-first)

**INVALID_KEY**

- [`AcmeError: … must be a CryptoKeyPair ({ publicKey, privateKey })`](#acmeerror--must-be-a-cryptokeypair--publickey-privatekey-)
- [`AcmeError: … must be a CryptoKey`](#acmeerror--must-be-a-cryptokey)
- [`AcmeError: … is …; only ECDSA P-256 and RSASSA-PKCS1-v1_5 with SHA-256 are supported`](#acmeerror--is--only-ecdsa-p-256-and-rsassa-pkcs1-v1_5-with-sha-256-are-supported)
- [`AcmeError: … is an RSA key of … bits; only 2048, 3072 and 4096 are supported`](#acmeerror--is-an-rsa-key-of--bits-only-2048-3072-and-4096-are-supported)
- [`AcmeError: … is an RSA key whose public exponent is not 65537`](#acmeerror--is-an-rsa-key-whose-public-exponent-is-not-65537)
- [`AcmeError: … must be a … key, not a … one`](#acmeerror--must-be-a--key-not-a--one)
- [`AcmeError: …'s public and private keys are not of the same algorithm`](#acmeerror-s-public-and-private-keys-are-not-of-the-same-algorithm)
- [`AcmeError: exportPrivateKeyPem(): the key is not extractable; generate or import it with extractable: true`](#acmeerror-exportprivatekeypem-the-key-is-not-extractable-generate-or-import-it-with-extractable-true)
- [`AcmeError: importKeyPairPem(): the PEM must be a string`](#acmeerror-importkeypairpem-the-pem-must-be-a-string)
- [`AcmeError: importKeyPairPem(): expected a PEM PRIVATE KEY block (PKCS #8)`](#acmeerror-importkeypairpem-expected-a-pem-private-key-block-pkcs-8)
- [`AcmeError: importKeyPairPem(): the PRIVATE KEY is neither an ECDSA P-256 nor an RSA key`](#acmeerror-importkeypairpem-the-private-key-is-neither-an-ecdsa-p-256-nor-an-rsa-key)
- [`AcmeError: jwkThumbprint(): the key must be a public CryptoKey or a JWK object`](#acmeerror-jwkthumbprint-the-key-must-be-a-public-cryptokey-or-a-jwk-object)
- [`AcmeError: … has kty …; only "EC" and "RSA" are supported`](#acmeerror--has-kty--only-ec-and-rsa-are-supported)
- [`AcmeError: … is an EC key on …; only P-256 is supported`](#acmeerror--is-an-ec-key-on--only-p-256-is-supported)
- [`AcmeError: … has no base64url "…" member`](#acmeerror--has-no-base64url--member)
- [`AcmeError: obtainCertificate(): certificateKey is the account key; a certificate needs a key of its own`](#acmeerror-obtaincertificate-certificatekey-is-the-account-key-a-certificate-needs-a-key-of-its-own)

**INVALID_TOKEN**

- [`AcmeError: …: a challenge token is a non-empty base64url string of at most 1024 characters, not …`](#acmeerror--a-challenge-token-is-a-non-empty-base64url-string-of-at-most-1024-characters-not-)

**NO_ACCOUNT**

- [`AcmeError: …: no account yet; call newAccount() first, or give the client its kid`](#acmeerror--no-account-yet-call-newaccount-first-or-give-the-client-its-kid)
- [`AcmeError: obtainCertificate(): the client has no account yet; call newAccount() first, or give the client its kid`](#acmeerror-obtaincertificate-the-client-has-no-account-yet-call-newaccount-first-or-give-the-client-its-kid)

**SERVER_PROBLEM**

- [`AcmeError: …: the CA answered …: …`](#acmeerror--the-ca-answered--)
- [`AcmeError: …: the CA answered … without a problem document`](#acmeerror--the-ca-answered--without-a-problem-document)

**RATE_LIMITED**

- [`AcmeError: …: the CA's rate limit: …`](#acmeerror--the-cas-rate-limit-)

**BAD_RESPONSE**

- [`AcmeError: …: the CA's … must be an https: URL without credentials or a fragment, not …`](#acmeerror--the-cas--must-be-an-https-url-without-credentials-or-a-fragment-not-)
- [`AcmeError: …: the CA's answer is over … bytes`](#acmeerror--the-cas-answer-is-over--bytes)
- [`AcmeError: …: the CA's … is not a JSON object`](#acmeerror--the-cas--is-not-a-json-object)
- [`AcmeError: …: the CA's … has a missing or invalid "…"`](#acmeerror--the-cas--has-a-missing-or-invalid-)
- [`AcmeError: …: the CA answered a redirect (…), which an ACME client does not follow`](#acmeerror--the-ca-answered-a-redirect--which-an-acme-client-does-not-follow)
- [`AcmeError: …: the CA's newNonce answer has no valid Replay-Nonce`](#acmeerror--the-cas-newnonce-answer-has-no-valid-replay-nonce)
- [`AcmeError: certificate(): the CA's answer is not a PEM certificate chain`](#acmeerror-certificate-the-cas-answer-is-not-a-pem-certificate-chain)
- [`AcmeError: certificate(): the CA's chain holds a block that is not an X.509 certificate`](#acmeerror-certificate-the-cas-chain-holds-a-block-that-is-not-an-x509-certificate)
- [`AcmeError: certificate(): the CA's chain is not in order, each certificate issued by the next`](#acmeerror-certificate-the-cas-chain-is-not-in-order-each-certificate-issued-by-the-next)
- [`AcmeError: obtainCertificate(): the CA's order is "valid" but has no "certificate"`](#acmeerror-obtaincertificate-the-cas-order-is-valid-but-has-no-certificate)
- [`AcmeError: obtainCertificate(): the CA's order is for "…", not the names requested`](#acmeerror-obtaincertificate-the-cas-order-is-for--not-the-names-requested)
- [`AcmeError: obtainCertificate(): the CA's order lists … authorizations for … names`](#acmeerror-obtaincertificate-the-cas-order-lists--authorizations-for--names)
- [`AcmeError: obtainCertificate(): the CA's authorization is for "…", not one of the names requested`](#acmeerror-obtaincertificate-the-cas-authorization-is-for--not-one-of-the-names-requested)
- [`AcmeError: obtainCertificate(): the CA's order is "valid" before it was finalized`](#acmeerror-obtaincertificate-the-cas-order-is-valid-before-it-was-finalized)
- [`AcmeError: obtainCertificate(): the CA's certificate is not for certificateKey`](#acmeerror-obtaincertificate-the-cas-certificate-is-not-for-certificatekey)
- [`AcmeError: obtainCertificate(): the CA's certificate expired already, on "…"`](#acmeerror-obtaincertificate-the-cas-certificate-expired-already-on-)
- [`AcmeError: obtainCertificate(): the CA's certificate names "…", not the names requested`](#acmeerror-obtaincertificate-the-cas-certificate-names--not-the-names-requested)

**NETWORK_ERROR**

- [`AcmeError: …: fetch failed: …`](#acmeerror--fetch-failed-)

**TIMEOUT**

- [`AcmeError: …: no answer within … ms`](#acmeerror--no-answer-within--ms)
- [`AcmeError: …: the signal timed out`](#acmeerror--the-signal-timed-out)
- [`AcmeError: …: still … after … ms`](#acmeerror--still--after--ms)
- [`AcmeError: obtainCertificate(): no certificate within … ms`](#acmeerror-obtaincertificate-no-certificate-within--ms)
- [`AcmeError: obtainCertificate(): http01.set(…) did not settle within 10000 ms, so its token may stay served`](#acmeerror-obtaincertificate-http01set-did-not-settle-within-10000-ms-so-its-token-may-stay-served)
- [`AcmeError: obtainCertificate(): http01.remove(…) did not settle within 10000 ms`](#acmeerror-obtaincertificate-http01remove-did-not-settle-within-10000-ms)

**ABORTED**

- [`AcmeError: …: aborted`](#acmeerror--aborted)

**AUTHORIZATION_FAILED**

- [`AcmeError: …: the authorization for … is "…"`](#acmeerror--the-authorization-for--is-)
- [`AcmeError: obtainCertificate(): the authorization for … offers no http-01 challenge`](#acmeerror-obtaincertificate-the-authorization-for--offers-no-http-01-challenge)

**ORDER_FAILED**

- [`AcmeError: …: the order is "invalid"`](#acmeerror--the-order-is-invalid)

## INVALID_NAME

### `AcmeError: createCsr(): a name is a string, not …`

**When**: an entry of `names` is not a string: `createCsr(): a name is a string, not undefined`.

**Why**: each name is a DNS name, as text.

**Fix**: pass strings; filter out the empty slots of a list built from configuration.

```ts
import { createCsr, generateKeyPair } from '@bumail/acme';

const keyPair = await generateKeyPair();
const configured: (string | undefined)[] = ['example.com', undefined];
await createCsr({ names: configured.filter((name): name is string => typeof name === 'string'), keyPair });
```

### `AcmeError: createCsr(): "…" holds a space or a control character`

**When**: a name holds a space, a tab, a line break or another ASCII control character, often from a configuration file read with its line ending.

**Why**: no DNS host name holds one.

**Fix**: trim the names you read.

```ts
import { createCsr, generateKeyPair } from '@bumail/acme';

const keyPair = await generateKeyPair();
const names = (await Bun.file('names.txt').text()).split('\n').map((line) => line.trim()).filter(Boolean);
await createCsr({ names, keyPair });
```

### `AcmeError: createCsr(): "…" is not ASCII; give an internationalized name as its A-labels (xn--…)`

**When**: a name holds a character outside ASCII: `bücher.example`.

**Why**: a certificate holds a name as its A-labels, and this package does not choose an IDNA mapping for you: a name that silently became another would be worse.

**Fix**: convert it with the platform's WHATWG mapping first.

```ts
import { createCsr, generateKeyPair } from '@bumail/acme';

const keyPair = await generateKeyPair();
await createCsr({ names: [new URL('http://bücher.example').hostname], keyPair }); // 'xn--bcher-kva.example'
```

### `AcmeError: createCsr(): "…" is a wildcard name, which this package does not request`

**When**: a name starts with `*.`.

**Why**: a wildcard can only be proven with DNS-01, and this package answers HTTP-01; DNS-01 is on the [roadmap](roadmap.md).

**Fix**: list each name you serve instead, up to 100.

```ts
import { createCsr, generateKeyPair } from '@bumail/acme';

const keyPair = await generateKeyPair();
await createCsr({ names: ['example.com', 'www.example.com', 'mail.example.com'], keyPair });
```

### `AcmeError: createCsr(): "…" ends with a dot; give the name without it`

**When**: a name is written fully qualified: `example.com.`.

**Why**: ACME identifiers and certificate names carry no trailing dot.

**Fix**: drop it.

```ts
import { createCsr, generateKeyPair } from '@bumail/acme';

const keyPair = await generateKeyPair();
const name = 'example.com.';
await createCsr({ names: [name.replace(/\.$/, '')], keyPair });
```

### `AcmeError: createCsr(): "…" is longer than 253 characters`

**When**: a name, without a trailing dot, is longer than 253 characters (the name is cut to 80 in the message).

**Why**: it could not be in the DNS (RFC 1035 §2.3.4).

**Fix**: check where the name came from: it is usually two names run together.

### `AcmeError: createCsr(): "…" has an empty label`

**When**: a name holds two dots in a row, starts with a dot, or is empty: `a..example`, `.example.com`, `""`.

**Why**: every label of a DNS name has at least one character.

**Fix**: fix the name; an empty string often comes from splitting a list with a trailing separator.

### `AcmeError: createCsr(): "…" has a label longer than 63 characters`

**When**: one label of the name is longer than 63 characters.

**Why**: that is the most a DNS label holds (RFC 1035 §2.3.4).

**Fix**: fix the name.

### `AcmeError: createCsr(): "…" has a label that is not letters, digits and inner hyphens: "…"`

**When**: a label holds something other than letters, digits and hyphens, or starts or ends with a hyphen: `_dmarc.example.com`, `-a.example`, `a.*.example`. The second quote is the label.

**Why**: a certificate names hosts, whose labels follow the LDH rule (RFC 1123 §2.1); CAs refuse an underscore, and a `*` anywhere but a whole first label.

**Fix**: name the host itself: `_dmarc` and `_domainkey` names are DNS records, never certificate names.

### `AcmeError: createCsr(): "…" is a single label; a certificate name has at least two`

**When**: a name has no dot: `localhost`, `mail`.

**Why**: a public CA issues only for names under a public suffix.

**Fix**: give the full name, `mail.example.com`. For a name only your machines resolve, use a private CA instead of ACME.

### `AcmeError: createCsr(): "…" ends in a numeric label, as an IP address does; only DNS names are supported`

**When**: the last label is a number as a URL parser reads one: all digits (`192.0.2.1`), or hexadecimal (`127.0.0.0x1`, `mail.0xff`).

**Why**: an IPv4 address is not a DNS name; a certificate for an address is an `iPAddress`, requested with another ACME identifier (RFC 8738), which this package does not make.

**Fix**: use the host's DNS name.

## INVALID_OPTION

### `AcmeError: createCsr(): options must be an object`

**When**: `createCsr` was called with nothing, or not an object.

**Why**: it takes `{ names, keyPair }`.

**Fix**: pass both.

```ts
import { createCsr, generateKeyPair } from '@bumail/acme';

const keyPair = await generateKeyPair();
await createCsr({ names: ['example.com'], keyPair });
```

### `AcmeError: createCsr(): names must be an array of DNS names`

**When**: `names` is a string, or missing.

**Why**: a request holds a list of names, even of one.

**Fix**: wrap a single name in an array.

```ts
import { createCsr, generateKeyPair } from '@bumail/acme';

const keyPair = await generateKeyPair();
await createCsr({ names: ['example.com'], keyPair });
```

### `AcmeError: createCsr(): names must hold at least one name`

**When**: `names` is `[]`.

**Why**: a certificate is for at least one name.

**Fix**: check the list is filled before asking for a certificate.

### `AcmeError: createCsr(): names holds … names; at most 100 fit one certificate`

**When**: `names` has more than `MAX_NAMES` (100) entries.

**Why**: Let's Encrypt issues for 100 names at most per certificate, and a larger request would only be refused later, at finalize.

**Fix**: split the names across several certificates.

```ts
import { createCsr, generateKeyPair, MAX_NAMES } from '@bumail/acme';

const names: string[] = [/* … */];
for (let i = 0; i < names.length; i += MAX_NAMES) {
	await createCsr({ names: names.slice(i, i + MAX_NAMES), keyPair: await generateKeyPair() });
}
```

### `AcmeError: createCsr(): "…" is given twice`

**When**: two names are the same once lowercased: `example.com` and `Example.com`.

**Why**: a name is given once; a duplicate usually means two lists were merged.

**Fix**: remove duplicates first.

```ts
import { createCsr, generateKeyPair } from '@bumail/acme';

const keyPair = await generateKeyPair();
const names = [...new Set(['example.com', 'Example.com'].map((name) => name.toLowerCase()))];
await createCsr({ names, keyPair });
```

### `AcmeError: signJws(): options must be an object`

**When**: `signJws` was called with nothing, or not an object.

**Why**: it takes `{ keyPair, nonce, url, kid?, payload? }`.

**Fix**: pass them.

### `AcmeError: signJws(): nonce must be the server's Replay-Nonce, a non-empty base64url string, not …`

**When**: `nonce` is missing, empty, or holds characters outside base64url (`+`, `/`, `=`).

**Why**: every request carries the last nonce the server gave (RFC 8555 §6.5), and a nonce is base64url (§6.5.1).

**Fix**: take it from the `Replay-Nonce` header of the last answer, or from a HEAD to the directory's `newNonce` URL.

```ts
const directory = { newNonce: 'https://acme.example/acme/new-nonce' };
const response = await fetch(directory.newNonce, { method: 'HEAD' });
const nonce = response.headers.get('replay-nonce') ?? '';
```

### `AcmeError: signJws(): … must be an https: URL without white space, credentials or a fragment, not …`

**When**: `url` or `kid` (the first `…` says which) is not an absolute `https:` URL, is longer than 2048 characters, holds white space or a control character (a line end read with it), or carries credentials (`https://user:pw@…`) or a fragment (`#…`).

**Why**: RFC 8555 §6.1 runs ACME over HTTPS only, `url` must be the exact URL posted to (§6.4), and `kid` is the account URL the server returned in `Location`.

**Fix**: pass the URLs as the directory and the server gave them, whole and trimmed. They are signed exactly as given, never normalised: the header's `url` must be the URL the request is sent to (RFC 8555 §6.4).

### `AcmeError: signJws(): payload must be an object or left out for POST-as-GET, not …`

**When**: `payload` is a string, a number, an array or `null`.

**Why**: the payloads of ACME are JSON objects; a POST-as-GET has none.

**Fix**: leave `payload` out to fetch a resource, pass `{}` to answer a challenge.

### `AcmeError: signJws(): payload cannot be written as JSON: …`

**When**: the payload is an object `JSON.stringify` refuses: one holding a
`BigInt`, or one that refers to itself. The `…` is the reason it gave,
and `cause` is its error.

**Why**: the payload is sent as JSON.

**Fix**: give numbers as numbers or strings, and build the payload from
plain data.

### `AcmeError: signJws(): payload does not write a JSON object; its toJSON() returns something else`

**When**: the payload is an object with a `toJSON()` method that returns
`undefined`, a string, a number or an array, as a class of your own can.

**Why**: an ACME payload is a JSON object, and `JSON.stringify` writes
what `toJSON()` returns.

**Fix**: pass a plain object, or make `toJSON()` return one.

### `AcmeError: generateKeyPair(): the type is 'P-256' or 'RSA-2048', not …`

**When**: `generateKeyPair` was given another type.

**Why**: those are the two keys this package signs with.

**Fix**: use `'P-256'` (the default) unless something needs RSA.

### `AcmeError: importKeyPairPem(): options must be an object`

**When**: the second argument is `null`, or not an object.

**Why**: it takes `{ extractable? }`.

**Fix**: leave it out, or pass `{ extractable: true }`.

### `AcmeError: importKeyPairPem(): extractable must be a boolean`

**When**: `extractable` is not `true` or `false`.

**Why**: it says whether the private key can be exported again.

**Fix**: pass a boolean, or leave it out for `false`.

### `AcmeError: …: options must be an object`

**When**: `new AcmeClient`, one of its methods (`newAccount()`, `newOrder()`, `waitForOrder()`…) or `obtainCertificate` was given something other than an object as its options; the `…` names which.

**Why**: each takes one options object.

**Fix**: pass one, `{}` when nothing is needed.

### `AcmeError: AcmeClient: allowInsecure must be a boolean`

**When**: `allowInsecure` is a string or a number, as an environment variable read as is.

**Why**: it turns off the `https:` check, so it takes nothing but `true` or `false`.

**Fix**: compare explicitly, and keep it for a test CA.

```ts
import { AcmeClient, generateKeyPair } from '@bumail/acme';

const client = new AcmeClient({
	directoryUrl: 'http://localhost:4001/dir', // a test CA on plain HTTP
	accountKey: await generateKeyPair(),
	allowInsecure: process.env.ACME_TEST_CA === '1',
});
```

### `AcmeError: …: … must be an https: URL without credentials or a fragment (http: only with allowInsecure), not …`

**When**: a URL you gave is not an absolute `https:` URL, is longer than 2048 characters, or holds white space, credentials or a fragment: `directoryUrl` or `kid` of `new AcmeClient`, the `url` of `authorization()`, `challenge()`, `order()`, `waitForAuthorization()`, `waitForOrder()` or `certificate()`, or `order.url` and `order.finalize` of `finalize()`.

**Why**: ACME runs over HTTPS only (RFC 8555 §6.1); the account key signs every request, and the CA's answers decide what you install.

**Fix**: use the URLs as the directory and the CA gave them. Only a test CA on plain HTTP takes `allowInsecure: true`; Pebble serves HTTPS, so give its CA to `fetch` instead (see the [guide](guide.md#testing-against-pebble)).

### `AcmeError: AcmeClient: fetch must be a function`

**When**: `fetch` is given and is not a function.

**Why**: every request goes through it.

**Fix**: leave it out for the global `fetch`, or pass `(url, init) => fetch(url, { ...init, … })`.

### `AcmeError: …: … must be an integer from … to …, not …`

**When**: `requestTimeoutMs` (1 to 600000) or `pollIntervalMs` (10 to 60000) of `new AcmeClient`, or `timeoutMs` of `waitForOrder()`, `waitForAuthorization()` (1 to 3600000) or `obtainCertificate()` (1 to 3600000), is not an integer in its range.

**Why**: every wait is bounded, and none is meant to be zero or forever.

**Fix**: give milliseconds within the range, or leave the option out for its default (30 s a request, 1 s between polls, 2 min a wait, 5 min for `obtainCertificate`).

### `AcmeError: …: signal must be an AbortSignal`

**When**: `signal` is given and is not an `AbortSignal`: a controller, a boolean.

**Why**: requests and waits listen to it.

**Fix**: pass `controller.signal`, or `AbortSignal.timeout(ms)`.

### `AcmeError: newAccount(): contact must be an array of at most 10 mailto: URLs, not …`

**When**: `contact` is a string, or holds more than 10 entries.

**Why**: RFC 8555 §7.3 sends contacts as an array of URLs.

**Fix**: `contact: ['mailto:admin@example.com']`.

### `AcmeError: newAccount(): a contact is a mailto: URL with one address, not …`

**When**: an entry of `contact` is not `mailto:` followed by one address: an `https:` URL, a bare address, two addresses after a comma, a space.

**Why**: Let's Encrypt and most CAs take `mailto:` only, one address each; anything else they refuse with `unsupportedContact` or `invalidContact`.

**Fix**: one `mailto:` entry per address.

```ts
const contact = ['admin@example.com', 'ops@example.com'].map((address) => `mailto:${address}`);
```

### `AcmeError: newAccount(): … must be a boolean`

**When**: `termsOfServiceAgreed` or `onlyReturnExisting` is not `true` or `false`.

**Why**: both are sent as JSON booleans (RFC 8555 §7.3).

**Fix**: pass `true` or `false`, or leave it out.

### `AcmeError: newOrder(): identifiers must be an array of 1 to 100 identifiers, not …`

**When**: `identifiers` is missing, empty, not an array, or longer than 100.

**Why**: an order is for one name at least, and Let's Encrypt takes 100 at most.

**Fix**: split more names over several orders.

```ts
const identifiers = ['example.com', 'www.example.com'].map((value) => ({ type: 'dns', value }));
```

### `AcmeError: newOrder(): an identifier is { type: 'dns', value: <a name> }, its value printable ASCII of at most 253 characters, not …`

**When**: an identifier is not an object, its `type` is not a lowercase word, or its `value` is empty, longer than 253 characters, or holds a space or a character outside ASCII.

**Why**: the CA checks the name itself; this only refuses what no CA would take.

**Fix**: give A-labels for an internationalized name (`new URL('http://bücher.example').hostname`).

### `AcmeError: finalize(): order must be an order from newOrder() or waitForOrder()`

**When**: `finalize` was given something other than an order object.

**Why**: it needs the order's `url` and its `finalize` URL.

**Fix**: pass the order `newOrder()` or `waitForOrder()` returned.

### `AcmeError: finalize(): csr must be a Csr from createCsr() or its DER bytes`

**When**: the CSR is a PEM string, an empty array, or missing.

**Why**: finalize sends the DER, base64url (RFC 8555 §7.4).

**Fix**: pass `createCsr`'s result, or its `der`.

### `AcmeError: obtainCertificate(): client must be an AcmeClient`

**When**: `client` is missing, or an object of another class.

**Why**: the flow runs through the client's requests.

**Fix**: `new AcmeClient({ directoryUrl, accountKey })`, then `newAccount()`.

### `AcmeError: obtainCertificate(): http01 must be { set(token, keyAuthorization), remove(token) }`

**When**: `http01` is missing, or lacks one of the two functions.

**Why**: the key authorizations must be served on port 80 for the CA to validate, then removed.

**Fix**: pass `http01Responder()`, served on port 80, or hooks of your own.

```ts
import { http01Responder } from '@bumail/acme';

const http01 = http01Responder();
Bun.serve({ port: 80, fetch: http01.fetch });
```

### `AcmeError: http01Responder(): the key authorization of a token is "<token>.<thumbprint>", not …`

**When**: `set(token, keyAuthorization)` was given a key authorization that does not start with the token and a dot, or whose thumbprint is not base64url.

**Why**: what is served is exactly what RFC 8555 §8.1 defines; anything else fails validation anyway.

**Fix**: pass what `client.keyAuthorization(token)` or `keyAuthorization(token, accountKey.publicKey)` returns.

### `AcmeError: http01Responder(): it already serves 1000 tokens; remove some first`

**When**: a responder holds 1000 tokens, and `set` was called with another.

**Why**: an order has 100 names at most; that many tokens means they are set and never removed.

**Fix**: call `remove(token)` once each authorization is settled, as `obtainCertificate` does.

## INVALID_KEY

### `AcmeError: … must be a CryptoKeyPair ({ publicKey, privateKey })`

**When**: `keyPair` of `createCsr` or `signJws`, or `accountKey` of `new AcmeClient`, is missing or not an object.

**Why**: each needs the private key to sign and the public key to put in the request.

**Fix**: pass what `generateKeyPair` or `importKeyPairPem` returns.

### `AcmeError: … must be a CryptoKey`

**When**: a key is not a Web Crypto `CryptoKey`: a PEM string, a Node `KeyObject`, `undefined`. The `…` names the function and the argument: `signJws(): keyPair.privateKey`.

**Why**: everything here signs through `crypto.subtle`.

**Fix**: read a PEM with `importKeyPairPem`.

```ts
import { importKeyPairPem } from '@bumail/acme';

const keyPair = await importKeyPairPem(await Bun.file('key.pem').text());
```

### `AcmeError: … is …; only ECDSA P-256 and RSASSA-PKCS1-v1_5 with SHA-256 are supported`

**When**: a key is of another algorithm: `createCsr(): keyPair.privateKey is ECDSA P-384; …`, or Ed25519, RSA-PSS, an RSA key imported for SHA-384.

**Why**: these are the two JWS algorithms ACME servers must support, `ES256` and `RS256`, and their CSR signatures.

**Fix**: generate the key with `generateKeyPair`, or import an RSA key with `{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }`.

### `AcmeError: … is an RSA key of … bits; only 2048, 3072 and 4096 are supported`

**When**: an RSA key's modulus is not 2048, 3072 or 4096 bits long (a JWK's `n` measured without leading zero bytes), as a `CryptoKey`, a PKCS #8 PEM, or a JWK given to `jwkThumbprint` or `keyAuthorization`. A key pair given to `createCsr` or `signJws` (and so an `AcmeClient`'s account key, at its first request) has both halves measured, the public key first: the message names the one refused, `….publicKey` or `….privateKey`.

**Why**: those are the sizes Let's Encrypt takes; a CA refuses a smaller key, and an odd size.

**Fix**: generate a new one: `generateKeyPair('RSA-2048')`.

### `AcmeError: … is an RSA key whose public exponent is not 65537`

**When**: an RSA key's public exponent (`e`) is not 65537 (`AQAB`): a key
made with `publicExponent: Uint8Array.of(3)`, or a JWK with another `e`.

**Why**: Let's Encrypt takes 65537 only.

**Fix**: generate the key with `generateKeyPair('RSA-2048')`, whose
exponent is 65537.

### `AcmeError: … must be a … key, not a … one`

**When**: a public key was given where a private one signs, or the other way round: `exportPrivateKeyPem(): the key must be a private key, not a public one`, `jwkThumbprint(): the key must be a public key, not a private one`.

**Why**: a thumbprint and a JWK are of the public key; signing and exporting a PEM take the private one.

**Fix**: pass `keyPair.publicKey` or `keyPair.privateKey` as the message says.

### `AcmeError: …'s public and private keys are not of the same algorithm`

**When**: `keyPair` mixes the halves of two pairs: an RSA public key with a P-256 private key.

**Why**: the request would carry one key and be signed by another.

**Fix**: keep each pair together.

### `AcmeError: exportPrivateKeyPem(): the key is not extractable; generate or import it with extractable: true`

**When**: the private key was made with `extractable: false`, as `importKeyPairPem` does by default.

**Why**: Web Crypto will not export such a key.

**Fix**: import it with `{ extractable: true }`, or keep the PEM you imported it from.

```ts
import { exportPrivateKeyPem, importKeyPairPem } from '@bumail/acme';

const text = await Bun.file('key.pem').text();
const keyPair = await importKeyPairPem(text, { extractable: true });
await exportPrivateKeyPem(keyPair.privateKey);
```

### `AcmeError: importKeyPairPem(): the PEM must be a string`

**When**: `importKeyPairPem` was given bytes or a `BunFile`.

**Why**: it reads PEM text.

**Fix**: read the file as text first.

```ts
import { importKeyPairPem } from '@bumail/acme';

await importKeyPairPem(await Bun.file('key.pem').text());
```

### `AcmeError: importKeyPairPem(): expected a PEM PRIVATE KEY block (PKCS #8)`

**When**: the text holds no `-----BEGIN PRIVATE KEY-----` block with valid base64: an `EC PRIVATE KEY` or `RSA PRIVATE KEY` (SEC 1, PKCS #1), an `ENCRYPTED PRIVATE KEY`, a certificate.

**Why**: only unencrypted PKCS #8 is read.

**Fix**: convert the key with openssl.

```sh
openssl pkcs8 -topk8 -nocrypt -in key.pem -out key.pk8.pem
```

### `AcmeError: importKeyPairPem(): the PRIVATE KEY is neither an ECDSA P-256 nor an RSA key`

**When**: the PKCS #8 key is of another kind: P-384, Ed25519, or not a key Web Crypto can read.

**Why**: this package signs with P-256 and RSA only.

**Fix**: generate a P-256 key with `generateKeyPair` and keep that one.

### `AcmeError: jwkThumbprint(): the key must be a public CryptoKey or a JWK object`

**When**: `jwkThumbprint` or `keyAuthorization` was given a string or nothing.

**Why**: the thumbprint is computed from a key.

**Fix**: pass the account's public key, or its JWK.

### `AcmeError: … has kty …; only "EC" and "RSA" are supported`

**When**: a JWK given to `jwkThumbprint` or `keyAuthorization` is an `OKP` or `oct` key.

**Why**: the account keys this package signs with are EC and RSA.

**Fix**: use the JWK of the account key.

### `AcmeError: … is an EC key on …; only P-256 is supported`

**When**: an EC JWK names another curve.

**Why**: P-256 is the only curve this package signs with.

**Fix**: use the JWK of the account key.

### `AcmeError: … has no base64url "…" member`

**When**: a JWK lacks one of its required members (`x` and `y` for EC, `n` and `e` for RSA), or holds one that is not base64url.

**Why**: the thumbprint hashes exactly those members (RFC 7638 §3.2).

**Fix**: pass a whole public JWK, as `publicJwk` gives it.

### `AcmeError: obtainCertificate(): certificateKey is the account key; a certificate needs a key of its own`

**When**: `certificateKey` has the same public key as the client's `accountKey`.

**Why**: a CA refuses a CSR whose key is the account's (RFC 8555 §11.1), after the whole validation.

**Fix**: generate a second key for the certificate, and keep it beside the chain.

```ts
import { exportPrivateKeyPem, generateKeyPair } from '@bumail/acme';

const certificateKey = await generateKeyPair('P-256');
await Bun.write('/data/tls/key.pem', await exportPrivateKeyPem(certificateKey.privateKey));
```

## INVALID_TOKEN

### `AcmeError: …: a challenge token is a non-empty base64url string of at most 1024 characters, not …`

**When**: `keyAuthorization` or `http01Path` was given a token that is empty, longer than 1024 characters, or holds characters outside base64url: a `/`, a `.`, a space, `=`.

**Why**: RFC 8555 §8.1 makes a token base64url; anything else could turn the path into another one (`../`).

**Fix**: pass the `token` of the challenge as the server sent it. A server that sends anything else is broken or hostile: do not answer that challenge.

## NO_ACCOUNT

### `AcmeError: …: no account yet; call newAccount() first, or give the client its kid`

**When**: `newOrder()`, `order()`, `authorization()`, `challenge()`, a wait, `finalize()` or `certificate()` was called on a client that has no account URL.

**Why**: every request after `newAccount` is signed with the account URL as `kid` (RFC 8555 §6.2).

**Fix**: call `newAccount()` once per client; it creates the account or finds the existing one of the key. Or keep the URL it returned and give it back as `kid`.

```ts
import { AcmeClient, importKeyPairPem } from '@bumail/acme';

const client = new AcmeClient({
	directoryUrl: 'https://acme-staging-v02.api.letsencrypt.org/directory',
	accountKey: await importKeyPairPem(await Bun.file('/data/acme/account.pem').text()),
});
await client.newAccount({ termsOfServiceAgreed: true }); // or new AcmeClient({ …, kid })
```

### `AcmeError: obtainCertificate(): the client has no account yet; call newAccount() first, or give the client its kid`

**When**: `obtainCertificate` was given a client before its `newAccount()`.

**Why**: as above; `obtainCertificate` does not agree to a CA's terms on your behalf.

**Fix**: `await client.newAccount({ termsOfServiceAgreed: true, contact })` first.

## SERVER_PROBLEM

### `AcmeError: …: the CA answered …: …`

**When**: the CA refused a request with a problem document (RFC 8555 §6.7): the status, the problem's `type`, its `detail`, and up to three subproblems with their names. `error.problem` holds it whole, `error.status` the status.

**Why**: what the type says. The ones met most:

| `type` (after `urn:ietf:params:acme:error:`) | means |
| --- | --- |
| `accountDoesNotExist` | `onlyReturnExisting: true` for a key with no account |
| `userActionRequired` | new terms to agree to: `newAccount({ termsOfServiceAgreed: true })` again |
| `rejectedIdentifier` | the CA will not issue for a name (policy, a blocked domain) |
| `caa` | a CAA record of the name does not allow this CA |
| `orderNotReady` | `finalize` before the authorizations are valid: `waitForOrder` first |
| `badCSR` | the CSR's names differ from the order's, or its key is refused |
| `malformed`, `unauthorized` | the request itself: a bug worth reporting |
| `badNonce` | thrown only after 3 retries in a row, each with a fresh nonce |

**Fix**: act on the type; `error.problem.subproblems` names each identifier at fault.

```ts
import { AcmeError, type AcmeClient } from '@bumail/acme';

declare const client: AcmeClient; // its account made
try {
	await client.newOrder({ identifiers: [{ type: 'dns', value: 'example.com' }] });
} catch (error) {
	if (error instanceof AcmeError && error.code === 'SERVER_PROBLEM') {
		console.error(error.problem?.type, error.problem?.subproblems?.map((sub) => sub.identifier?.value));
	}
	throw error;
}
```

### `AcmeError: …: the CA answered … without a problem document`

**When**: the CA, or something in front of it, answered an error status with a body that is not a problem document: a proxy's 502, a 404 page.

**Why**: the request did not reach the ACME server, or the URL is not one.

**Fix**: check the directory URL; retry a 5xx later. `error.retryAfter` holds a `Retry-After` when there was one.

## RATE_LIMITED

### `AcmeError: …: the CA's rate limit: …`

**When**: the CA refused with `urn:ietf:params:acme:error:rateLimited`: too many certificates for a domain, too many failed validations, too many orders. The message ends with `(retry after … s)` when the CA said when; `error.retryAfter` holds those seconds, clamped to a week.

**Why**: Let's Encrypt limits issuance per registered domain and per account; failed validations count too.

**Fix**: wait `error.retryAfter` seconds before the next attempt, and test against Let's Encrypt's staging directory, whose limits are far higher.

```ts
import { AcmeError } from '@bumail/acme';

declare function obtain(): Promise<void>; // your call to obtainCertificate
declare function scheduleRetry(ms: number): void; // your scheduler

try {
	await obtain();
} catch (error) {
	if (error instanceof AcmeError && error.code === 'RATE_LIMITED') {
		scheduleRetry((error.retryAfter ?? 3600) * 1000);
	} else throw error;
}
```

## BAD_RESPONSE

### `AcmeError: …: the CA's … must be an https: URL without credentials or a fragment, not …`

**When**: a URL the CA gave — in the directory, an order, an authorization, a challenge, or a `Location` header — is not `https:`, is longer than 2048 characters, or holds white space, credentials or a fragment. The second `…` names the member: `directory "newNonce"`, `order "finalize"`, `account URL (Location)`.

**Why**: the client sends signed requests to those URLs, so it follows none that is not HTTPS.

**Fix**: check the directory URL is the CA's. A test CA on plain HTTP takes `allowInsecure: true`, in tests only.

### `AcmeError: …: the CA's answer is over … bytes`

**When**: an answer was larger than its cap: 256 KiB for JSON (a directory, an order, an authorization, a problem), 1 MiB for a certificate chain. An announced `Content-Length` over the cap is refused before reading; otherwise reading stops at the cap.

**Why**: a real answer is a few KiB; a larger one is a misconfigured proxy or a hostile server.

**Fix**: check the directory URL points at an ACME server.

### `AcmeError: …: the CA's … is not a JSON object`

**When**: an answer that should be JSON is not: an HTML page, an empty body, an array.

**Why**: the URL answered, but not as an ACME server.

**Fix**: check the directory URL, which ends in `/directory` for Let's Encrypt and `/dir` for Pebble.

### `AcmeError: …: the CA's … has a missing or invalid "…"`

**When**: an order, authorization or challenge misses a member RFC 8555 §7.1 requires, or has one of the wrong type: a `status` not among the RFC's, no `identifiers`, an identifier longer than 256 characters, more than 1000 entries in a list, a challenge `token` that is not base64url.

**Why**: the client reads the members it acts on, and trusts none it cannot check.

**Fix**: report it to the CA; it is not an ACME answer.

### `AcmeError: …: the CA answered a redirect (…), which an ACME client does not follow`

**When**: the CA answered 3xx.

**Why**: a redirect could lead a signed request to another URL than the one signed, or off HTTPS; ACME servers do not redirect their API.

**Fix**: use the final directory URL, as the CA documents it.

### `AcmeError: …: the CA's newNonce answer has no valid Replay-Nonce`

**When**: the HEAD to `newNonce` came back without a `Replay-Nonce`, or with one that is not base64url or longer than 512 characters.

**Why**: every signed request needs a nonce (RFC 8555 §7.2).

**Fix**: check nothing between you and the CA strips response headers.

### `AcmeError: certificate(): the CA's answer is not a PEM certificate chain`

**When**: the certificate URL answered with something other than one or more `CERTIFICATE` PEM blocks.

**Why**: the chain is installed as it is; anything else in it would break a TLS listener later.

**Fix**: download it again; if it persists, report it to the CA.

### `AcmeError: certificate(): the CA's chain holds a block that is not an X.509 certificate`

**When**: the download is PEM, but a `CERTIFICATE` block in it does not parse as an X.509 certificate. The parser's error is `error.cause`.

**Why**: each certificate of the chain is read before it is handed back, so a broken one is refused here rather than by a TLS listener later.

**Fix**: download it again with `client.certificate(order.certificate)`; if it persists, report it to the CA.

### `AcmeError: certificate(): the CA's chain is not in order, each certificate issued by the next`

**When**: a certificate of the chain was not issued, and signed, by the one after it: the blocks are out of order, or one of them belongs to another chain.

**Why**: RFC 8555 §7.4.2 puts the leaf first and each issuer after the certificate it signed; a TLS listener sends the chain in that order, and clients reject one that does not link.

**Fix**: report it to the CA. Reordering the blocks yourself hides a CA bug; download it again first.

### `AcmeError: obtainCertificate(): the CA's order is "valid" but has no "certificate"`

**When**: the order became `valid` without a certificate URL.

**Why**: RFC 8555 §7.1.3 requires one once the order is valid.

**Fix**: report it to the CA.

### `AcmeError: obtainCertificate(): the CA's order is for "…", not the names requested`

**When**: the order `newOrder` returned lists other DNS identifiers than `names` — one more, one fewer or a different one. Case and order do not matter. Nothing was set through the hooks.

**Why**: RFC 8555 §7.4 has the CA echo the identifiers asked for; validating and finalizing an order for other names would serve tokens for names you did not ask for, or end in a certificate that does not cover yours.

**Fix**: report it to the CA, with the names you passed and the names in the message.

### `AcmeError: obtainCertificate(): the CA's order lists … authorizations for … names`

**When**: the order lists more authorization URLs than names requested.

**Why**: a CA gives one authorization per identifier, at most; more would make `obtainCertificate` set tokens for names you did not ask for.

**Fix**: report it to the CA.

### `AcmeError: obtainCertificate(): the CA's authorization is for "…", not one of the names requested`

**When**: an authorization of the order is for a name you did not pass (case does not matter), or is not a DNS identifier. Its token was not set.

**Why**: serving a key authorization proves control of a name to the CA; `obtainCertificate` serves tokens only for the names you asked for.

**Fix**: report it to the CA, with the names you passed and the name in the message.

### `AcmeError: obtainCertificate(): the CA's order is "valid" before it was finalized`

**When**: once its authorizations were valid, the order was already `valid`, before `obtainCertificate` sent its CSR.

**Why**: an order becomes `valid` only after finalize (RFC 8555 §7.1.6); one that is valid before has a certificate issued for a key this flow never sent, so it is not used.

**Fix**: report it to the CA, then call `obtainCertificate` again for a new order.

### `AcmeError: obtainCertificate(): the CA's certificate is not for certificateKey`

**When**: the leaf of the chain holds another public key than `certificateKey.publicKey`, the key the CSR was signed with.

**Why**: a certificate for another key cannot be served with yours: the TLS handshake would fail, or worse, the CA issued someone else's certificate.

**Fix**: do not install it; report it to the CA. The order is `valid`, so `result` is not returned; download it with `client.certificate()` only to send it with the report.

### `AcmeError: obtainCertificate(): the CA's certificate expired already, on "…"`

**When**: the leaf's `notAfter` is in the past: the certificate the CA handed back is no longer valid. The message quotes it, as `node:crypto` prints it (`Jan  1 00:00:00 2020 GMT`).

**Why**: an expired certificate fails every TLS handshake; installing it would take the listener down. Only the expiry is checked: a `notBefore` slightly ahead of your clock is normal and is not refused.

**Fix**: check this machine's clock first; if it is right, report it to the CA.

### `AcmeError: obtainCertificate(): the CA's certificate names "…", not the names requested`

**When**: the leaf's subjectAltName is not exactly the DNS names of `names`: one is missing, one is added, or an entry is not a DNS name. The message quotes the leaf's entries, as `DNS:a.example, DNS:b.example`. Case and order do not matter.

**Why**: a certificate that misses a name breaks TLS for that name, and one with names you did not ask for is not the certificate you ordered.

**Fix**: do not install it; report it to the CA.

## NETWORK_ERROR

### `AcmeError: …: fetch failed: …`

**When**: `fetch` threw: the host does not resolve, the connection is refused, the TLS certificate is not trusted. The cause is kept as `error.cause`.

**Why**: the request never got an answer.

**Fix**: check the directory URL and the network. For Pebble, or any CA under a private root, give `fetch` that root:

```ts
import { AcmeClient, generateKeyPair } from '@bumail/acme';

const ca = await Bun.file('pebble.minica.pem').text();
const client = new AcmeClient({
	directoryUrl: 'https://localhost:14000/dir',
	accountKey: await generateKeyPair(),
	fetch: (url, init) => fetch(url, { ...init, tls: { ca } }),
});
```

## TIMEOUT

### `AcmeError: …: no answer within … ms`

**When**: one request, its answer read, took longer than `requestTimeoutMs` (30 s by default).

**Why**: every request is bounded, so a CA that hangs never holds the client.

**Fix**: retry later; raise `requestTimeoutMs` only for a CA known to be slow.

### `AcmeError: …: the signal timed out`

**When**: the `signal` you gave was `AbortSignal.timeout(…)`'s, and its time ran out.

**Why**: a timeout's abort is reported as one.

**Fix**: give it more time, or leave it out: each wait has a `timeoutMs` of its own.

### `AcmeError: …: still … after … ms`

**When**: `waitForAuthorization()` or `waitForOrder()` saw the resource stay `pending` (or `processing`) for `timeoutMs`.

**Why**: an authorization stays `pending` until the CA validated its challenge, and an order until all its authorizations are `valid`: the challenge was never answered with `challenge()`, or the CA cannot reach the key authorization yet.

**Fix**: answer the challenge first, check `http://<name>/.well-known/acme-challenge/<token>` answers from outside, or give the wait more time.

### `AcmeError: obtainCertificate(): no certificate within … ms`

**When**: the whole flow took longer than its `timeoutMs` (5 minutes by default). The step it was in is `error.cause` — unless removing the tokens failed: then `error.cause` is that failure (`http01.set(…) did not settle…`, `http01.remove(…) did not settle…`, or what `remove` threw). Every token set was removed, or its `remove` called.

**Why**: the CA was slow to validate or to issue, or could not reach port 80.

**Fix**: read `error.cause`; check port 80 is reachable from the Internet for every name.

### `AcmeError: obtainCertificate(): http01.set(…) did not settle within 10000 ms, so its token may stay served`

**Where**: never thrown on its own. It is the `cause` of the error `obtainCertificate` throws, whose code and message are kept: `obtainCertificate(): no certificate within … ms` (past `timeoutMs`), `obtainCertificate(): aborted` (your signal fired), or `obtainCertificate(): the signal timed out` (your signal was an `AbortSignal.timeout`).

`error.cause` is the step that was running (past `timeoutMs`), your signal's reason (an abort), or the cleanup's failure: an `obtainCertificate(): http01.set(`/`remove(` message, or what your `remove` threw. Only the message tells which:

```ts
try {
	await obtainCertificate({ client, names, certificateKey, http01 });
} catch (error) {
	const cause = error instanceof Error ? error.cause : undefined;
	if (
		cause instanceof Error &&
		/^obtainCertificate\(\): http01\.(set|remove)\(/.test(cause.message)
	) {
		console.error('cleanup:', cause.message);
	}
	throw error;
}
```

**When**: the flow had already failed — `timeoutMs` passed or the signal fired — while a `set` hook was still pending, and that `set` did not settle within the 10 seconds the cleanup allows.

**Why**: a token is removed only once its `set` settled, so that a `set` landing late cannot serve the token again after its `remove`. When it does not settle in time, its `remove` is called at once, unwaited, and again once the `set` lands; if the `set` never lands, nothing tells whether the token is served.

**Fix**: make `set` settle, with a time limit of its own on whatever it writes to. A token left served is harmless, but stale: check the responder and remove it by hand if the `set` never landed.

Before you retry, wait for the hung `set` to settle (or stop it): its late `remove` can land after the retry has set the same token again, and take that one down mid-validation.

### `AcmeError: obtainCertificate(): http01.remove(…) did not settle within 10000 ms`

**When**: a `remove` hook neither returned nor threw within 10 seconds. Every other token was still removed. This error is thrown when nothing else failed, the order left `ready` (its authorizations stay valid for a while, so a new attempt reuses them). When the flow failed too, the flow's error is thrown, and this one goes in its `error.cause`: it replaces the cause of a `TIMEOUT` from `timeoutMs` (`no certificate within … ms`) or of an `ABORTED`/`the signal timed out` from your signal, and becomes the cause of any other `AcmeError` without one; it is lost for a hook's own error that is not an `AcmeError`, a `NETWORK_ERROR`, and a request's `…: no answer within … ms` `TIMEOUT`.

**Why**: `remove` runs even after the flow's time is up or its signal fired, so the cleanup has a bound of its own: every token is removed at once, each `remove` after its `set` settled, all within one 10-second grace, and a hook that hangs cannot hold `obtainCertificate`.

**Fix**: make the hook settle — a file write, a store call with a time limit of its own. A token left served is harmless, but stale.

## ABORTED

### `AcmeError: …: aborted`

**When**: the `signal` you gave fired with another reason than a timeout; that reason is `error.cause`. `obtainCertificate` removed every token it set first; when that failed, `error.cause` is the cleanup's failure instead, and the reason is still `signal.reason`.

**Why**: you asked it to stop.

**Fix**: nothing, unless the abort was not meant: it is thrown at once, mid-request or between two polls.

## AUTHORIZATION_FAILED

### `AcmeError: …: the authorization for … is "…"`

**When**: an authorization ended `invalid`, `deactivated`, `expired` or `revoked`. When a challenge failed, the message goes on with its problem — `urn:ietf:params:acme:error:unauthorized: …` for a wrong key authorization, `connection` or `dns` when the CA could not reach the name — and `error.problem` holds it.

**Why**: the CA could not validate the name: port 80 does not reach the responder, the name resolves elsewhere, or the answer served is not the key authorization of this account's key.

**Fix**: check that `http://<name>/.well-known/acme-challenge/<token>` reaches your responder from outside, over plain HTTP on port 80, for every name, then order again: a failed authorization is not retried.

### `AcmeError: obtainCertificate(): the authorization for … offers no http-01 challenge`

**When**: the CA offered no `http-01` challenge for a name: some CAs offer only `dns-01` for some names, and a wildcard name never has one.

**Why**: `obtainCertificate` answers HTTP-01 only.

**Fix**: leave that name out, or answer its other challenge yourself with the client's steps.

## ORDER_FAILED

### `AcmeError: …: the order is "invalid"`

**When**: the order became `invalid`, after an authorization failed or at finalize (a CSR the CA refused). The message goes on with the order's problem when it gave one; `error.problem` holds it.

**Why**: an invalid order is final.

**Fix**: read the problem, fix the cause, and place a new order.
