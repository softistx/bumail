# @bumail/acme

An ACME client (RFC 8555), the protocol Let's Encrypt and other CAs issue
certificates through: `obtainCertificate` runs the whole HTTP-01 flow,
`AcmeClient` each request of it, and `http01Responder` answers the CA on
port 80. Under them, the primitives: a certificate signing request for
DNS names, the signed JWS every ACME request is, the JWK thumbprint, key
authorizations, and the keys themselves, written as PKCS #8 PEM that
Bun's TLS takes. All on Web Crypto and `fetch`, with its own small DER
writer. No dependency; `typescript` is an optional peer, for the types.

**Bun only**, like every `@bumail/*` package: it runs on Bun 1.4.2 or
later.

```sh
bun add @bumail/acme
```

## Obtaining a certificate

```ts
import {
	AcmeClient,
	exportPrivateKeyPem,
	generateKeyPair,
	http01Responder,
	obtainCertificate,
} from '@bumail/acme';

const client = new AcmeClient({
	directoryUrl: 'https://acme-staging-v02.api.letsencrypt.org/directory', // staging first
	accountKey: await generateKeyPair(), // keep it: write it out with exportPrivateKeyPem
});
await client.newAccount({ termsOfServiceAgreed: true, contact: ['mailto:admin@example.com'] });

const http01 = http01Responder();
Bun.serve({ port: 80, fetch: http01.fetch }); // the CA fetches http://<name>/.well-known/acme-challenge/<token>

const certificateKey = await generateKeyPair(); // never the account key
const { certificate } = await obtainCertificate({
	client,
	names: ['example.com', 'mail.example.com'],
	certificateKey,
	http01,
	timeoutMs: 300_000, // the default: the whole flow
});

await Bun.write('/data/tls/fullchain.pem', certificate); // the leaf first: Bun's tls.cert
await Bun.write('/data/tls/key.pem', await exportPrivateKeyPem(certificateKey.privateKey));
```

`obtainCertificate` orders the names, serves each pending authorization's
`http-01` key authorization through `http01.set`, answers the challenge,
waits for the authorizations, finalizes with a CSR and downloads the
chain, checking that its leaf is for `certificateKey` and the names
asked, and not expired. It **always** calls `http01.remove` for every token it set — after
success, a failed validation, an abort or a timeout — once that token's
`set` settled. Hooks of your own
work as well as the responder: `{ set(token, keyAuthorization), remove(token) }`,
each sync or async.

## The client, step by step

```ts
import { AcmeClient, createCsr, generateKeyPair, http01Responder } from '@bumail/acme';

const client = new AcmeClient({
	directoryUrl: 'https://acme-staging-v02.api.letsencrypt.org/directory',
	accountKey: await generateKeyPair(),
});
const kid = await client.newAccount({ termsOfServiceAgreed: true }); // the account URL; new AcmeClient({ …, kid }) reuses it
const http01 = http01Responder();
Bun.serve({ port: 80, fetch: http01.fetch });

let order = await client.newOrder({ identifiers: [{ type: 'dns', value: 'example.com' }] });
for (const url of order.authorizations) {
	const authorization = await client.authorization(url); // POST-as-GET
	const challenge = authorization.challenges.find((c) => c.type === 'http-01');
	if (authorization.status === 'valid' || !challenge?.token) continue;
	http01.set(challenge.token, await client.keyAuthorization(challenge.token));
	await client.challenge(challenge.url); // POSTs {}: ready to be validated
	await client.waitForAuthorization(url, { timeoutMs: 60_000 });
	http01.remove(challenge.token);
}
order = await client.waitForOrder(order); // 'ready'

const certificateKey = await generateKeyPair();
const csr = await createCsr({ names: ['example.com'], keyPair: certificateKey });
order = await client.waitForOrder(await client.finalize(order, csr)); // 'valid'
const chain = await client.certificate(order.certificate ?? ''); // PEM, the leaf first
```

Every request is a JWS signed with the account key; every fetch is a
POST-as-GET. Nonces are kept from each answer and fetched with a HEAD
(`newNonce()`) only when none is left, and a `badNonce` refusal is
retried with the nonce it carries, 3 times at most. The waits poll as the
CA's `Retry-After` says, clamped from `pollIntervalMs` (1 s) to a minute,
within `timeoutMs` (2 minutes). Every method that sends a request takes `{ signal }`; `keyAuthorization()` and `accountThumbprint()` send none.

What the client checks of the CA: every URL must be `https:` (only
`allowInsecure: true` takes `http:`, for a test CA), a redirect is
refused, an answer is read up to 256 KiB (1 MiB for a chain), and every
number is clamped. The account key never appears in an error or in
`inspect`.

```ts
import { AcmeClient, generateKeyPair } from '@bumail/acme';

// a CA under a private root, as Pebble in tests: give fetch the root
const ca = await Bun.file('pebble.minica.pem').text();
const client = new AcmeClient({
	directoryUrl: 'https://localhost:14000/dir',
	accountKey: await generateKeyPair(),
	fetch: (url, init) => fetch(url, { ...init, tls: { ca } }),
	requestTimeoutMs: 30_000, // the default: one request
	pollIntervalMs: 1000, // the default
});
```

## Answering HTTP-01

```ts
import { type AcmeClient, http01Responder } from '@bumail/acme';

declare const client: AcmeClient; // its account made
const http01 = http01Responder();
Bun.serve({ port: 80, fetch: http01.fetch });

const token = 'LoqXcYV8q5ONbJQxbmR7SCTNo3tiAXDfowyjxAjEuX0'; // a challenge's
http01.set(token, await client.keyAuthorization(token)); // `${token}.${thumbprint}`
// GET /.well-known/acme-challenge/<token> → 200, the key authorization; anything else → 404
http01.remove(token);
http01.size; // tokens served
```

Only a base64url token and its own key authorization are taken; any
other path, an unknown token, or a method other than GET and HEAD is
answered 404.

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

ECDSA on P-256 and RSA (RSASSA-PKCS1-v1_5, SHA-256; 2048, 3072 or 4096
bits, exponent 65537, Let's Encrypt's policy) are the keys this package
signs with. A generated private key is extractable, so
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
	error.code; // 'INVALID_NAME'
	error.message; // 'createCsr(): "*.example.com" is a wildcard name, which this package does not request'
}
```

```ts
import { AcmeError, type AcmeClient } from '@bumail/acme';

declare const client: AcmeClient;
try {
	await client.newOrder({ identifiers: [{ type: 'dns', value: 'example.com' }] });
} catch (error) {
	if (!(error instanceof AcmeError)) throw error;
	if (error.code === 'RATE_LIMITED') {
		error.retryAfter; // seconds the CA asked to wait, when it said
	}
	error.problem?.type; // 'urn:ietf:params:acme:error:rateLimited', or another problem type
	error.problem?.detail; // the CA's words
	error.status; // 429
}
```

Every function checks what it is given and throws an `AcmeError` for
anything it cannot take: `INVALID_NAME`, `INVALID_OPTION`, `INVALID_KEY`,
`INVALID_TOKEN` and `NO_ACCOUNT`, none worth retrying as is. What the CA
answers, or the way to it, is `SERVER_PROBLEM`, `RATE_LIMITED`,
`BAD_RESPONSE`, `NETWORK_ERROR`, `TIMEOUT`, `ABORTED`,
`AUTHORIZATION_FAILED` or `ORDER_FAILED`, with `problem`, `status` and
`retryAfter` when the CA gave them.

## Traps

- **Staging first.** Let's Encrypt's production limits count failed
  validations; run a new setup against
  `https://acme-staging-v02.api.letsencrypt.org/directory`, whose
  certificates no client trusts, then switch.
- **Port 80, for every name.** The CA fetches each name's key
  authorization over plain HTTP on port 80; HTTP-01 cannot use another.
- **Keep the account key.** An account is its key: a new key is a new
  account, and rate limits count per account.
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
| `obtainCertificate({ client, names, certificateKey, http01, timeoutMs?, signal? })`, `ObtainCertificateOptions`, `ObtainedCertificate`, `Http01Hooks` | the whole HTTP-01 flow: `{ certificate, order, csr }`; every token set is removed |
| `new AcmeClient({ directoryUrl, accountKey, fetch?, kid?, allowInsecure?, requestTimeoutMs?, pollIntervalMs? })`, `AcmeClientOptions`, `AcmeFetch` | an ACME client: `directory()`, `newNonce()`, `newAccount()`, `newOrder()`, `order()`, `authorization()`, `challenge()`, `waitForAuthorization()`, `waitForOrder()`, `finalize()`, `certificate()`, `keyAuthorization()`, `accountThumbprint()`, `kid` |
| `NewAccountOptions`, `NewOrderOptions`, `AcmeRequestOptions`, `AcmeWaitOptions` | the methods' options |
| `AcmeDirectory`, `AcmeDirectoryMeta`, `AcmeOrder`, `AcmeOrderStatus`, `AcmeAuthorization`, `AcmeAuthorizationStatus`, `AcmeChallenge`, `AcmeChallengeStatus`, `AcmeIdentifier`, `AcmeProblem` | the resources, as the client returns them |
| `http01Responder()`, `Http01Responder` | `{ set, remove, fetch, size }`: HTTP-01 answers from memory, `fetch` a `Bun.serve` handler |
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
| `AcmeError`, `AcmeErrorCode`, `AcmeErrorOptions` | `code`, and `problem`, `status`, `retryAfter` from the CA: `INVALID_NAME`, `INVALID_OPTION`, `INVALID_KEY`, `INVALID_TOKEN`, `NO_ACCOUNT`, `SERVER_PROBLEM`, `RATE_LIMITED`, `BAD_RESPONSE`, `NETWORK_ERROR`, `TIMEOUT`, `ABORTED`, `AUTHORIZATION_FAILED`, `ORDER_FAILED` |

## Documentation

- [Index](https://github.com/softistx/bumail/blob/develop/packages/acme/docs/README.md): the pages below, and when to read each.
- [Guide](https://github.com/softistx/bumail/blob/develop/packages/acme/docs/guide.md): the client and the full flow, serving HTTP-01, Let's Encrypt staging, the client's limits, testing against Pebble; and where each primitive fits, the CSR's structure and its name rules, the JWS header, and keeping keys.
- [Troubleshooting](https://github.com/softistx/bumail/blob/develop/packages/acme/docs/troubleshooting.md): every `AcmeError` message, from what you passed or from the CA, and what to do about it.
- [Roadmap](https://github.com/softistx/bumail/blob/develop/packages/acme/docs/roadmap.md): what is coming — DNS-01, key rollover and revocation, ARI — and what is not planned.
