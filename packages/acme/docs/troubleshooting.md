# Troubleshooting

Each entry is headed by the message of the `AcmeError` thrown; its `code`
is the group it is listed under. The parts shown as … vary. A value you passed is shown quoted and cut to 80
characters when it is a string, and by its kind (`number`, `bigint`,
`null`, `an array`) otherwise. Every
message starts with the function that threw it, except where the `…`
at its start names the function and the argument, as
`signJws(): keyPair.privateKey`. `keyAuthorization` throws
`jwkThumbprint`'s messages for its key.

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
- [`AcmeError: signJws(): … must be an https: URL as the server gave it, in its normal form, not …`](#acmeerror-signjws--must-be-an-https-url-as-the-server-gave-it-in-its-normal-form-not-)
- [`AcmeError: signJws(): payload must be an object or left out for POST-as-GET, not …`](#acmeerror-signjws-payload-must-be-an-object-or-left-out-for-post-as-get-not-)
- [`AcmeError: signJws(): payload cannot be written as JSON: …`](#acmeerror-signjws-payload-cannot-be-written-as-json-)
- [`AcmeError: signJws(): payload does not write a JSON object; its toJSON() returns something else`](#acmeerror-signjws-payload-does-not-write-a-json-object-its-tojson-returns-something-else)
- [`AcmeError: generateKeyPair(): the type is 'P-256' or 'RSA-2048', not …`](#acmeerror-generatekeypair-the-type-is-p-256-or-rsa-2048-not-)
- [`AcmeError: importKeyPairPem(): options must be an object`](#acmeerror-importkeypairpem-options-must-be-an-object)
- [`AcmeError: importKeyPairPem(): extractable must be a boolean`](#acmeerror-importkeypairpem-extractable-must-be-a-boolean)

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

**INVALID_TOKEN**

- [`AcmeError: …: a challenge token is a non-empty base64url string of at most 1024 characters, not …`](#acmeerror--a-challenge-token-is-a-non-empty-base64url-string-of-at-most-1024-characters-not-)

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

### `AcmeError: signJws(): … must be an https: URL as the server gave it, in its normal form, not …`

**When**: `url` or `kid` (the first `…` says which) is not an absolute `https:` URL, holds white space or a control character (a line end read with it), or is not in the form `new URL(…).href` gives: an upper-case host, a bare origin without its `/`, a default port spelled out.

**Why**: RFC 8555 §6.1 runs ACME over HTTPS only, `url` must be the exact URL posted to (§6.4), and `kid` is the account URL the server returned in `Location`.

**Fix**: pass the URLs as the directory and the server gave them, whole and trimmed. What is signed is compared with the URL the server sees, so a URL that changes when parsed would sign one thing and post to another.

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

## INVALID_KEY

### `AcmeError: … must be a CryptoKeyPair ({ publicKey, privateKey })`

**When**: `keyPair` of `createCsr` or `signJws` is missing or not an object.

**Why**: both functions need the private key to sign and the public key to put in the request.

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

**When**: an RSA key's modulus is not 2048, 3072 or 4096 bits long (a JWK's `n` measured without leading zero bytes), as a `CryptoKey`, a PKCS #8 PEM, or a JWK given to `jwkThumbprint` or `keyAuthorization`.

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

## INVALID_TOKEN

### `AcmeError: …: a challenge token is a non-empty base64url string of at most 1024 characters, not …`

**When**: `keyAuthorization` or `http01Path` was given a token that is empty, longer than 1024 characters, or holds characters outside base64url: a `/`, a `.`, a space, `=`.

**Why**: RFC 8555 §8.1 makes a token base64url; anything else could turn the path into another one (`../`).

**Fix**: pass the `token` of the challenge as the server sent it. A server that sends anything else is broken or hostile: do not answer that challenge.
