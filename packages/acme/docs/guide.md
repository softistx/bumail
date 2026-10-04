# Guide

- [Where each primitive fits](#where-each-primitive-fits)
- [Keys](#keys)
- [The certificate signing request](#the-certificate-signing-request)
- [Names](#names)
- [Signing ACME requests](#signing-acme-requests)
- [The thumbprint and HTTP-01](#the-thumbprint-and-http-01)
- [Errors](#errors)
- [How it is tested](#how-it-is-tested)

## Where each primitive fits

An ACME exchange (RFC 8555 §7) obtains a certificate in a few steps. This
package gives the pieces each step is built from; the client that runs
the steps over HTTP is [next](roadmap.md).

| step | RFC 8555 | from this package |
| --- | --- | --- |
| create an account key, keep it | §7.3 | `generateKeyPair`, `exportPrivateKeyPem`, `importKeyPairPem` |
| `newAccount` | §7.3 | `signJws` with the `jwk` in the header |
| `newOrder` for the names, fetch its authorizations | §7.4, §7.5 | `signJws` with the account URL as `kid`; POST-as-GET without `payload` |
| answer each HTTP-01 challenge | §8.3 | `keyAuthorization`, `http01Path`, then `signJws` with `payload: {}` |
| finalize with a CSR | §7.4 | `generateKeyPair` for the certificate, `createCsr`, `signJws` with `{ csr }` |
| download the certificate | §7.4.2 | `signJws`, POST-as-GET |

Every request is a POST of a JWS as `application/jose+json`, and each one
spends the nonce the previous answer gave in its `Replay-Nonce` header.

## Keys

Two keys take part, and they must differ: the **account key** signs every
request, and the **certificate's key** is the one the certificate
certifies, given in the CSR. A CA refuses a CSR whose key is the account's
(RFC 8555 §11.1).

```ts
import { generateKeyPair } from '@bumail/acme';

const accountKey = await generateKeyPair('P-256');
const certificateKey = await generateKeyPair('P-256'); // or 'RSA-2048' for old clients
```

| type | Web Crypto algorithm | JWS | CSR signature |
| --- | --- | --- | --- |
| `'P-256'` (default) | ECDSA, `namedCurve: 'P-256'` | `ES256` | `ecdsa-with-SHA256` (1.2.840.10045.4.3.2) |
| `'RSA-2048'` | RSASSA-PKCS1-v1_5, SHA-256, 2048 bits, exponent 65537 | `RS256` | `sha256WithRSAEncryption` (1.2.840.113549.1.1.11) |

A key pair you make yourself with `crypto.subtle.generateKey` works too, as
long as it is one of those two algorithms; an RSA key needs 2048 bits at
least. Anything else — P-384, Ed25519, RSA-PSS — is `INVALID_KEY`.

### Keeping a key on disk

`exportPrivateKeyPem` writes the private key as PKCS #8 PEM. That is the
form Bun's TLS takes as `key`, so the certificate's key goes straight into
a listener once the certificate is issued:

```ts
import { exportPrivateKeyPem, generateKeyPair } from '@bumail/acme';

const certificateKey = await generateKeyPair();
await Bun.write('/data/tls/key.pem', await exportPrivateKeyPem(certificateKey.privateKey));

// once the CA issued the chain:
Bun.serve({
	port: 443,
	tls: {
		key: Bun.file('/data/tls/key.pem'),
		cert: Bun.file('/data/tls/fullchain.pem'),
	},
	fetch: () => new Response('hello'),
});
```

`importKeyPairPem` reads it back as a pair: the private key from the PEM,
the public key derived from it, so nothing else needs storing. The
private key comes back non-extractable unless you ask:

```ts
import { importKeyPairPem } from '@bumail/acme';

const accountKey = await importKeyPairPem(await Bun.file('/data/acme/account.pem').text());
const exportable = await importKeyPairPem(await Bun.file('/data/acme/account.pem').text(), {
	extractable: true,
});
```

Only `PRIVATE KEY` blocks are read. An `EC PRIVATE KEY` or `RSA PRIVATE
KEY` (SEC 1, PKCS #1) from `openssl` is converted first:
`openssl pkcs8 -topk8 -nocrypt -in key.pem`.

## The certificate signing request

`createCsr({ names, keyPair })` builds a PKCS #10 request (RFC 2986), in
DER, with its PEM and the names as it put them:

```
CertificationRequest ::= SEQUENCE {
  certificationRequestInfo SEQUENCE {
    version       INTEGER 0
    subject       SEQUENCE { SET { SEQUENCE { 2.5.4.3 (CN), UTF8String <first name> } } }
    subjectPKInfo SubjectPublicKeyInfo, as crypto.subtle.exportKey('spki') gives it
    attributes    [0] SET {
                    SEQUENCE { 1.2.840.113549.1.9.14 (extensionRequest),
                      SET { SEQUENCE {                                  -- Extensions
                        SEQUENCE { 2.5.29.17 (subjectAltName),
                          OCTET STRING { SEQUENCE { [2] name, [2] name, … } } } } } } }
  }
  signatureAlgorithm SEQUENCE { ecdsa-with-SHA256 } | SEQUENCE { sha256WithRSAEncryption, NULL }
  signature          BIT STRING
}
```

- **The subject** is `CN=<first name>`. A CN holds 64 characters at most
  (RFC 5280's `ub-common-name`), so a first name longer than that leaves
  the subject empty, which RFC 5280 allows when the names are in the
  `subjectAltName`. Clients check that extension, never the CN.
- **The names** are each a `dNSName`, in the order given.
- **The signature** covers the DER of `certificationRequestInfo`. An
  ECDSA signature from Web Crypto is the 64 bytes of `r‖s` (IEEE P1363);
  a CSR takes it as the DER `SEQUENCE { INTEGER r, INTEGER s }` of RFC
  3279 §2.2.3, so each half has its leading zeros trimmed and a `0x00`
  put back when its first byte has the high bit set.

ACME's finalize takes the DER, base64url:

```ts
import { createCsr, generateKeyPair, signJws } from '@bumail/acme';

const accountKey = await generateKeyPair();
const certificateKey = await generateKeyPair();
const csr = await createCsr({ names: ['example.com', 'www.example.com'], keyPair: certificateKey });

const body = await signJws({
	keyPair: accountKey,
	nonce: 'b7x2bWpKZ3JkS1V5', // the last Replay-Nonce
	url: 'https://acme.example/acme/order/1/finalize',
	kid: 'https://acme.example/acme/acct/1',
	payload: { csr: Buffer.from(csr.der).toString('base64url') },
});
```

The PEM is for reading it with other tools:

```sh
openssl req -in csr.pem -noout -text -verify
```

## Names

Each name is checked and lowercased, and refused with `INVALID_NAME`
unless it is a DNS host name a public CA issues for:

- **ASCII only.** An internationalized name is refused, not converted:
  converting means choosing a mapping (UTS #46, IDNA 2008), and a name that
  silently becomes another is worse than an error. Convert it yourself,
  with the platform's WHATWG mapping, and give the A-labels:

  ```ts
  import { createCsr, generateKeyPair } from '@bumail/acme';

  const name = new URL('http://bücher.example').hostname; // 'xn--bcher-kva.example'
  await createCsr({ names: [name], keyPair: await generateKeyPair() });
  ```

- **Letters, digits and inner hyphens**, labels of 1 to 63 characters, 253
  characters at most. An underscore is refused: no CA puts one in a
  certificate.
- **Two labels at least**, the last one not all digits: `localhost` and
  `192.0.2.1` are refused. A certificate for an IP address takes a
  different identifier (RFC 8738).
- **No wildcard.** `*.example.com` needs DNS-01, which comes later; HTTP-01
  can only prove a name it can fetch from.
- **No trailing dot**, and no name twice (after lowercasing), which is
  `INVALID_OPTION`.
- **At most 100 names** (`MAX_NAMES`), Let's Encrypt's limit for one
  certificate.

## Signing ACME requests

`signJws` returns the body of a request, a JWS in the flattened JSON
serialization (RFC 7515 §7.2.2):

```json
{ "protected": "eyJhbGciOiJFUzI1NiIs…", "payload": "eyJ0ZXJtc09mU2Vydmlj…", "signature": "…" }
```

Its protected header holds what RFC 8555 §6.2 requires, in this order:

| member | value |
| --- | --- |
| `alg` | `ES256` for a P-256 key, `RS256` for an RSA key |
| `nonce` | the `nonce` you give: the last `Replay-Nonce` the server sent |
| `url` | the `url` you give: exactly the URL the request is POSTed to, `https:` only |
| `jwk` or `kid` | without a `kid`, the account's public key as a JWK (`newAccount`); with one, the account URL |

```ts
import { generateKeyPair, signJws } from '@bumail/acme';

const accountKey = await generateKeyPair();

const newAccount = await signJws({
	keyPair: accountKey,
	nonce: 'oFvnlFP1wIhRlYS2jTaXbA',
	url: 'https://acme.example/acme/new-account',
	payload: { termsOfServiceAgreed: true, contact: ['mailto:admin@example.com'] },
});

await fetch('https://acme.example/acme/new-account', {
	method: 'POST',
	headers: { 'content-type': 'application/jose+json' },
	body: JSON.stringify(newAccount),
});
```

The payload is JSON, base64url. Three cases to keep apart:

| `payload` | sent | for |
| --- | --- | --- |
| left out | `""` | POST-as-GET (§6.3): fetching an order, an authorization, a certificate |
| `{}` | `"e30"` | answering a challenge (§7.5.1) |
| an object | its JSON | `newAccount`, `newOrder`, finalize |

ES256 signs with ECDSA P-256 and SHA-256 and gives the 64 bytes of `r‖s`,
which is what JWS wants (RFC 7518 §3.4): no DER here, unlike the CSR.
ECDSA signatures differ every time; RS256's are the same for the same
input.

## The thumbprint and HTTP-01

The JWK thumbprint (RFC 7638) names the account key in a challenge
answer: SHA-256 over the JSON of the key's required members, in
lexicographic order, without white space — `{"crv","kty","x","y"}` for
P-256, `{"e","kty","n"}` for RSA — base64url. Any other member (`alg`,
`kid`, `use`) is left out:

```ts
import { jwkThumbprint } from '@bumail/acme';

await jwkThumbprint({ kty: 'RSA', e: 'AQAB', n: '0vx7agoebGcQSuu…', alg: 'RS256', kid: '2011-04-29' });
// RFC 7638 §3.1's key gives 'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs'
```

The key authorization is the challenge's token, a dot and that thumbprint
(RFC 8555 §8.1). For HTTP-01 (§8.3) the CA fetches it over plain HTTP, on
port 80 of each name, at `/.well-known/acme-challenge/<token>`:

```ts
import { generateKeyPair, http01Path, keyAuthorization } from '@bumail/acme';

const accountKey = await generateKeyPair();
const answers = new Map<string, string>(); // path → key authorization

async function prepare(token: string) {
	answers.set(http01Path(token), await keyAuthorization(token, accountKey.publicKey));
}

Bun.serve({
	port: 80,
	fetch(request) {
		const answer = answers.get(new URL(request.url).pathname);
		return answer === undefined
			? new Response('Not found', { status: 404 })
			: new Response(answer, { headers: { 'content-type': 'application/octet-stream' } });
	},
});
```

Once the path answers, tell the CA by POSTing `payload: {}` to the
challenge URL. Keep the path answering until the authorization is
`valid`: the CA may fetch it more than once, from several places.

A token is base64url (§8.1). One that is not — empty, or holding `/`,
`.` or a space — is `INVALID_TOKEN`, so a token from a hostile server
never becomes a path outside `/.well-known/acme-challenge/`.

## Errors

Every function throws an `AcmeError`, with a `code`, for what it was
given; [troubleshooting](troubleshooting.md) lists every message.

| code | thrown for |
| --- | --- |
| `INVALID_NAME` | a name `createCsr` will not put in a request |
| `INVALID_OPTION` | an option of the wrong type or out of range: no names, too many, a duplicate, a nonce or URL a JWS cannot carry, a payload that is not an object |
| `INVALID_KEY` | a key of another algorithm, of the wrong type (public for private), not extractable when it must be, or a PEM holding none |
| `INVALID_TOKEN` | a challenge token that is not base64url |

```ts
import { AcmeError, http01Path } from '@bumail/acme';

try {
	http01Path('../../etc/passwd');
} catch (error) {
	if (error instanceof AcmeError && error.code === 'INVALID_TOKEN') {
		// the server sent a token no CA would: refuse the challenge
	}
}
```

## How it is tested

The specs check what is written by reading it back with tools that did
not write it:

- the CSR, for P-256 and RSA, with a small DER reader of the specs' own:
  its structure, every OID, the subject, the SAN names, and the signature
  over `certificationRequestInfo` with `crypto.subtle.verify` (the ECDSA
  signature turned back from DER to P1363) and with `node:crypto`, which
  reads the DER signature itself;
- the CSR with `openssl req -verify -text`, where `openssl` is on the
  PATH (CI's runners have it; elsewhere those specs skip, saying so, and
  `BUMAIL_TEST_OPENSSL_REQUIRED` makes them fail instead);
- the thumbprint against RFC 7638 §3.1's example, exactly;
- each JWS's protected header, payload and signature, verified with
  `crypto.subtle.verify`;
- each exported PEM with `node:crypto`'s `createPrivateKey`, with
  `openssl pkey`, and as the `key` of a `Bun.listen` TLS listener a client
  completes a verified handshake with (on a self-signed certificate the
  specs build with the same DER writer);
- the DER writer's lengths, OIDs and integers, the edge cases of the
  last included: a high bit set, leading zeros, zero, a 256-bit value.
