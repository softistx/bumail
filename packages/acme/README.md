# @bumail/acme

The primitives of an ACME client (RFC 8555), the protocol Let's Encrypt
and other CAs issue certificates through: a certificate signing request
for DNS names, the signed JWS every ACME request is, the JWK thumbprint,
key authorizations and the HTTP-01 path, and the keys themselves, written
as PKCS #8 PEM that Bun's TLS takes. All on Web Crypto, with its own small
DER writer. No dependency; `typescript` is an optional peer, for the
types.

The client that talks to a CA — directory, nonces, account, order,
challenges, finalize — comes next, on top of these; see the
[roadmap](https://github.com/softistx/bumail/blob/develop/packages/acme/docs/roadmap.md).

**Bun only**, like every `@bumail/*` package: it runs on Bun 1.4.2 or
later.

```sh
bun add @bumail/acme
```

## Keys

```ts
import {
	exportPrivateKeyPem,
	generateKeyPair,
	importKeyPairPem,
} from '@bumail/acme';

const accountKey = await generateKeyPair('P-256'); // or 'RSA-2048'
const certificateKey = await generateKeyPair(); // P-256 by default

const pem = await exportPrivateKeyPem(certificateKey.privateKey);
// '-----BEGIN PRIVATE KEY-----\n…': PKCS #8, Bun.listen's and Bun.serve's tls.key

const again = await importKeyPairPem(pem); // { publicKey, privateKey }, from the PEM alone
```

ECDSA on P-256 and RSA of 2048 bits (RSASSA-PKCS1-v1_5, SHA-256) are the
keys this package signs with. A generated private key is extractable, so
it can be written out; an imported one is not, unless
`{ extractable: true }`.

## A certificate signing request

```ts
import { createCsr, generateKeyPair } from '@bumail/acme';

const keyPair = await generateKeyPair();
const csr = await createCsr({
	names: ['example.com', 'www.example.com', 'mail.example.com'],
	keyPair,
});

csr.der; // Uint8Array: what ACME's finalize sends, base64url, as `csr`
csr.pem; // '-----BEGIN CERTIFICATE REQUEST-----\n…', for `openssl req -text`
csr.names; // ['example.com', 'www.example.com', 'mail.example.com']
```

```ts
import { MAX_NAMES } from '@bumail/acme';

const names: string[] = [/* the names you serve */];
names.length <= MAX_NAMES; // 100: more names than that take several certificates
```

A PKCS #10 request (RFC 2986): the subject `CN=<first name>`, the public
key, and every name as a `dNSName` in a `subjectAltName` extension
request, signed with `ecdsa-with-SHA256` or `sha256WithRSAEncryption`.
Names are DNS host names in ASCII, at most 100: an internationalized name
is given as its A-labels (`new URL('http://bücher.example').hostname` is
`'xn--bcher-kva.example'`), and a wildcard, an IP address, a single label
or a trailing dot is refused. Use a key of its own for the certificate,
never the account's.

## A signed ACME request

```ts
import { generateKeyPair, signJws } from '@bumail/acme';

const accountKey = await generateKeyPair();

// newAccount: no account URL yet, so the header carries the public key (jwk)
const body = await signJws({
	keyPair: accountKey,
	nonce: 'oFvnlFP1wIhRlYS2jTaXbA', // the last Replay-Nonce
	url: 'https://acme.example/acme/new-account',
	payload: { termsOfServiceAgreed: true },
});
// { protected, payload, signature }: POST it as application/jose+json

// any later request: the account URL as kid; no payload is a POST-as-GET
await signJws({
	keyPair: accountKey,
	nonce: 'b7x2bWpKZ3JkS1V5',
	url: 'https://acme.example/acme/order/1',
	kid: 'https://acme.example/acme/acct/1',
});
```

The flattened JSON serialization (RFC 7515 §7.2.2) with the protected
header RFC 8555 §6.2 asks for, `{ alg, nonce, url, jwk | kid }`. ES256's
signature is the 64 bytes of `r‖s`, as JWS wants; RS256 for an RSA key.
Every part is base64url without padding. Leaving `payload` out sends
`""`, a POST-as-GET; `{}` is a payload, the one a challenge is answered
with.

## The thumbprint, key authorizations and HTTP-01

```ts
import {
	generateKeyPair,
	http01Path,
	jwkThumbprint,
	keyAuthorization,
} from '@bumail/acme';

const accountKey = await generateKeyPair();
const token = 'LoqXcYV8q5ONbJQxbmR7SCTNo3tiAXDfowyjxAjEuX0'; // from the challenge

await jwkThumbprint(accountKey.publicKey); // RFC 7638, base64url
const answer = await keyAuthorization(token, accountKey.publicKey); // `${token}.${thumbprint}`

Bun.serve({
	port: 80,
	fetch(request) {
		return new URL(request.url).pathname === http01Path(token) // '/.well-known/acme-challenge/<token>'
			? new Response(answer)
			: new Response('Not found', { status: 404 });
	},
});
```

`jwkThumbprint` and `keyAuthorization` take a public `CryptoKey` or a JWK
object. A token that is not base64url — a `/`, a `..` — is refused before
it can become a path.

## The public key as a JWK

```ts
import { generateKeyPair, publicJwk } from '@bumail/acme';

const { publicKey } = await generateKeyPair();
await publicJwk(publicKey); // { kty: 'EC', crv: 'P-256', x: '…', y: '…' }: the jwk of a JWS header
```

## Errors

```ts
import { AcmeError, createCsr, generateKeyPair } from '@bumail/acme';

try {
	await createCsr({ names: ['*.example.com'], keyPair: await generateKeyPair() });
} catch (error) {
	if (!(error instanceof AcmeError)) throw error;
	error.code; // 'INVALID_NAME' | 'INVALID_OPTION' | 'INVALID_KEY' | 'INVALID_TOKEN'
	error.message; // 'createCsr(): "*.example.com" is a wildcard name, which this package does not request'
}
```

Every function checks what it is given and throws an `AcmeError` for
anything it cannot take; none is worth retrying as is.

## Traps

- **Two keys, not one.** The account key signs requests; the
  certificate's key is in the CSR. A CA refuses a CSR made with the
  account key (RFC 8555 §11.1).
- **No wildcard names.** HTTP-01 cannot prove one; they come with DNS-01.
- **A first name of more than 64 characters leaves the subject empty**:
  a CN holds 64 at most (RFC 5280). The name stays in the
  `subjectAltName`, which is what a client checks.
- **`{}` is not POST-as-GET.** Fetch a resource with no `payload`, answer
  a challenge with `payload: {}`.
- **ES256 in a JWS is not ES256 in a CSR.** JWS takes `r‖s`; X.509 and
  PKCS #10 take a DER `SEQUENCE` of two `INTEGER`s. `signJws` and
  `createCsr` each write the right one.

## API

| export | |
| --- | --- |
| `createCsr({ names, keyPair })`, `CsrOptions`, `Csr`, `MAX_NAMES` | a PKCS #10 request for DNS names: `{ der, pem, names }`; 100 names at most |
| `signJws({ keyPair, nonce, url, kid?, payload? })`, `JwsOptions`, `FlattenedJws`, `ProtectedHeader` | an ACME request body: the flattened JWS, ES256 or RS256 |
| `jwkThumbprint(key)` | the RFC 7638 SHA-256 thumbprint of a public `CryptoKey` or a JWK, base64url |
| `publicJwk(publicKey)`, `PublicJwk` | a public key as a JWK with its required members only |
| `keyAuthorization(token, accountKey)` | `token.thumbprint`, what an HTTP-01 challenge serves |
| `http01Path(token)` | `/.well-known/acme-challenge/<token>` |
| `generateKeyPair(type?)`, `KeyType` | a new `'P-256'` (the default) or `'RSA-2048'` key pair, extractable |
| `exportPrivateKeyPem(privateKey)` | the private key as PKCS #8 PEM |
| `importKeyPairPem(pem, options?)`, `ImportKeyPairOptions` | a key pair from that PEM; `extractable` defaults to false |
| `JwsAlgorithm` | `'ES256' \| 'RS256'` |
| `AcmeError`, `AcmeErrorCode` | `INVALID_NAME`, `INVALID_OPTION`, `INVALID_KEY`, `INVALID_TOKEN` |

## Documentation

- [Index](https://github.com/softistx/bumail/blob/develop/packages/acme/docs/README.md): the pages below, and when to read each.
- [Guide](https://github.com/softistx/bumail/blob/develop/packages/acme/docs/guide.md): where each primitive fits in an ACME exchange, the CSR's structure and its name rules, the JWS header, HTTP-01, and keeping keys.
- [Troubleshooting](https://github.com/softistx/bumail/blob/develop/packages/acme/docs/troubleshooting.md): every `AcmeError`, and what to do about it.
- [Roadmap](https://github.com/softistx/bumail/blob/develop/packages/acme/docs/roadmap.md): what is coming — the client next — and what is not planned.
