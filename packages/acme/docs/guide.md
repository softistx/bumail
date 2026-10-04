# Guide

- [Where each primitive fits](#where-each-primitive-fits)
- [Keys](#keys)
- [The certificate signing request](#the-certificate-signing-request)
- [Names](#names)
- [Signing ACME requests](#signing-acme-requests)
- [The thumbprint and HTTP-01](#the-thumbprint-and-http-01)
- [The client](#the-client)
- [The full flow](#the-full-flow)
- [Each step by hand](#each-step-by-hand)
- [Let's Encrypt staging](#lets-encrypt-staging)
- [Limits and checks](#limits-and-checks)
- [Errors](#errors)
- [Testing against Pebble](#testing-against-pebble)
- [How it is tested](#how-it-is-tested)

## Where each primitive fits

An ACME exchange (RFC 8555 §7) obtains a certificate in a few steps. This
package gives the pieces each step is built from, and
[the client](#the-client) that runs the steps over HTTP on them —
[`obtainCertificate`](#the-full-flow) runs them all.

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
long as it is one of those two algorithms. An RSA key follows Let's
Encrypt's policy: 2048, 3072 or 4096 bits, and the exponent 65537. Anything else — P-384, Ed25519, RSA-PSS — is `INVALID_KEY`.

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
- **Two labels at least**, the last one not a number (all digits, or
  hexadecimal as `0xff`, which a URL parser reads as one): `localhost`,
  `192.0.2.1` and `127.0.0.0x1` are refused. A certificate for an IP address takes a
  different identifier (RFC 8738).
- **No wildcard.** `*.example.com` needs DNS-01, which comes later; HTTP-01
  can only prove a name it can fetch from.
- **No trailing dot.** A name given twice (after lowercasing) is
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
| `url` | the `url` you give: exactly the URL the request is POSTed to, `https:` only, at most 2048 characters, signed exactly as given; no white space, credentials or fragment |
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

// RFC 7638 §3.1's key (RFC 7517 Appendix A.1); its kid is left out of the hash
const jwk: JsonWebKey & { kid: string } = {
	kty: 'RSA',
	n:
		'0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAt' +
		'VT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn6' +
		'4tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FD' +
		'W2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n9' +
		'1CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINH' +
		'aQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw',
	e: 'AQAB',
	alg: 'RS256',
	kid: '2011-04-29',
};

await jwkThumbprint(jwk); // 'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs'
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

A token is base64url (§8.1). One that is not — empty, longer than 1024
characters, or holding `/`, `.` or a space — is `INVALID_TOKEN`, so a token from a hostile server
never becomes a path outside `/.well-known/acme-challenge/`.

## The client

`AcmeClient` runs the exchange over HTTP, on these primitives. One client
holds one account key:

```ts
import { AcmeClient, generateKeyPair } from '@bumail/acme';

const client = new AcmeClient({
	directoryUrl: 'https://acme-staging-v02.api.letsencrypt.org/directory',
	accountKey: await generateKeyPair(),
});
await client.newAccount({ termsOfServiceAgreed: true, contact: ['mailto:admin@example.com'] });
```

| option | default | what it does |
| --- | --- | --- |
| `directoryUrl` | — | the CA's directory, `https:` only |
| `accountKey` | — | the account key pair, P-256 or RSA; it signs every request |
| `fetch` | the global `fetch` | every request goes through it: give one that trusts a private root, or goes through a proxy |
| `kid` | — | the account URL `newAccount` returned before, so requests need no `newAccount` |
| `allowInsecure` | `false` | takes `http:` URLs, for a test CA on plain HTTP only |
| `requestTimeoutMs` | `30000` | the time limit of one request, its answer read (1 to 600000) |
| `pollIntervalMs` | `1000` | the wait between polls without `Retry-After`, and the shortest with one (10 to 60000) |

Each method is one request, or a poll of one, and takes an optional
`{ signal }`:

| method | RFC 8555 | request | returns |
| --- | --- | --- | --- |
| `directory()` | §7.1.1 | GET, once; kept | the directory, its URLs checked, its `meta` |
| `newNonce()` | §7.2 | HEAD | a fresh nonce (the client fetches its own) |
| `newAccount({ contact?, termsOfServiceAgreed?, onlyReturnExisting? })` | §7.3 | POST, signed with the `jwk` | the account URL, kept as `kid` |
| `newOrder({ identifiers })` | §7.4 | POST | the order, with its `url` |
| `order(url)` | §7.4 | POST-as-GET | the order |
| `authorization(url)` | §7.5 | POST-as-GET | the authorization and its challenges |
| `challenge(url)` | §7.5.1 | POST `{}` | the challenge, as the CA answers it |
| `waitForAuthorization(url, { timeoutMs? })` | §7.5.1 | POST-as-GET, polled | the authorization, once `valid` |
| `waitForOrder(order, { timeoutMs? })` | §7.4 | POST-as-GET, polled | the order, once `ready` or `valid` |
| `finalize(order, csr)` | §7.4 | POST `{ csr }` | the order, `processing` or `valid` |
| `certificate(url)` | §7.4.2 | POST-as-GET, `Accept: application/pem-certificate-chain` | the PEM chain, the leaf first, each certificate parsed and issued by the next |
| `keyAuthorization(token)`, `accountThumbprint()` | §8.1 | — | what an HTTP-01 responder serves, and the account key's thumbprint |

A fetch is always a POST-as-GET (§6.3): a JWS with an empty payload, never
a GET, except the directory and `newNonce`, which RFC 8555 fetches
unsigned.

### Nonces

Every answer carries a `Replay-Nonce`, and the client keeps the last 16
for its next requests: a HEAD to `newNonce` is only needed when none is
left, at the start mostly. When the CA refuses a nonce (`badNonce`,
§6.5), the refusal carries a fresh one, and the request is signed again
with it, 3 times at most in a row; Pebble refuses 5 % of nonces on
purpose, which the specs run through.

### Polling

`waitForAuthorization` and `waitForOrder` fetch the resource until it is
done, waiting between two fetches as the CA's `Retry-After` says —
clamped from `pollIntervalMs` to one minute — or `pollIntervalMs` when it
says nothing. Each wait stops after `timeoutMs` (2 minutes by default)
with `TIMEOUT`, and at once on its `signal` with `ABORTED`. An
authorization that ends other than `valid` is `AUTHORIZATION_FAILED`, an
order that ends `invalid` is `ORDER_FAILED`, each with the CA's problem.

## The full flow

`obtainCertificate` runs every step for HTTP-01, given a client whose
account exists, the names, the certificate's key, and two hooks that
serve and stop serving a key authorization. `http01Responder()` is such
a pair, with the `Bun.serve` handler that answers the CA on port 80:

```ts
import {
	AcmeClient,
	exportPrivateKeyPem,
	generateKeyPair,
	http01Responder,
	importKeyPairPem,
	obtainCertificate,
} from '@bumail/acme';

// keep the account key: a CA's rate limits count per account
const accountFile = Bun.file('/data/acme/account.pem');
const accountKey = (await accountFile.exists())
	? await importKeyPairPem(await accountFile.text())
	: await generateKeyPair();
if (!(await accountFile.exists())) {
	await Bun.write(accountFile, await exportPrivateKeyPem(accountKey.privateKey));
}

const client = new AcmeClient({
	directoryUrl: 'https://acme-v02.api.letsencrypt.org/directory',
	accountKey,
});
await client.newAccount({ termsOfServiceAgreed: true, contact: ['mailto:admin@example.com'] });

const http01 = http01Responder();
const port80 = Bun.serve({ port: 80, fetch: http01.fetch });

const certificateKey = await generateKeyPair(); // never the account key
const { certificate } = await obtainCertificate({
	client,
	names: ['example.com', 'mail.example.com'],
	certificateKey,
	http01,
});
port80.stop();

await Bun.write('/data/tls/key.pem', await exportPrivateKeyPem(certificateKey.privateKey));
await Bun.write('/data/tls/fullchain.pem', certificate);
```

What it does, in order:

1. checks the names and builds the CSR first, so a name no CA takes is
   refused before any request, and refuses a certificate key that is the
   account's;
2. `newOrder` for the names, refusing an order for other names, or with
   more authorizations than names, before anything is set;
3. for each authorization: one already `valid` (the CA reuses recent
   ones) is skipped; for a `pending` one, the `http-01` challenge's key
   authorization is `set`, then the challenge is answered;
4. waits for every authorization to be `valid`;
5. calls `remove` for every token `set` — **always**: on success, on a
   failed validation, on a `set` that threw or hung, on an abort or a
   timeout. Each `remove` waits for its `set` to settle first, so a `set`
   that lands late cannot serve its token again; the removes run all at
   once, within one 10-second grace. A `remove` that throws does not stop
   the others; its error is thrown only when nothing else failed;
6. waits for the order to be `ready` — one already `valid`, before any
   CSR was sent, is refused — finalizes it with the CSR, waits for it to
   be `valid`;
7. downloads the chain, and checks it: each block an X.509 certificate,
   each issued by the next, and the leaf for `certificateKey` and exactly
   the names asked for. Anything else is `BAD_RESPONSE`, and nothing is
   returned.

It returns `{ certificate, order, csr }`. Its `timeoutMs` (5 minutes by
default) bounds the whole flow, and its `signal` stops it.

### The responder

`http01Responder()` keeps key authorizations in memory and answers `GET`
and `HEAD /.well-known/acme-challenge/<token>` with the one set for that
token, as `application/octet-stream`. Anything else — another path, a
token not set, another method — is 404. `set` refuses a token that is not
base64url, and a key authorization that is not `<token>.<thumbprint>`;
it holds 1000 tokens at most.

Mount its `fetch` in a server of your own when port 80 serves more:

```ts
import { http01Responder } from '@bumail/acme';

const http01 = http01Responder();
Bun.serve({
	port: 80,
	fetch(request) {
		const url = new URL(request.url);
		if (url.pathname.startsWith('/.well-known/acme-challenge/')) return http01.fetch(request);
		url.protocol = 'https:';
		return Response.redirect(url.toString(), 301);
	},
});
```

Hooks of your own work too — a file a front proxy serves, a shared store
when several instances answer port 80:

```ts
import { rm } from 'node:fs/promises';
import type { Http01Hooks } from '@bumail/acme';

const hooks: Http01Hooks = {
	async set(token, keyAuthorization) {
		await Bun.write(`/var/www/acme/${token}`, keyAuthorization);
	},
	async remove(token) {
		await rm(`/var/www/acme/${token}`, { force: true });
	},
};
```

The CA fetches `http://<name>/.well-known/acme-challenge/<token>` on port
80 for every name, from several places, and follows redirects. Every name
must reach the responder.

## Each step by hand

`obtainCertificate` is these calls; make them yourself to answer another
challenge type, or to keep an order across restarts:

```ts
import { AcmeClient, createCsr, generateKeyPair, http01Responder } from '@bumail/acme';

const client = new AcmeClient({
	directoryUrl: 'https://acme-staging-v02.api.letsencrypt.org/directory',
	accountKey: await generateKeyPair(),
});
await client.newAccount({ termsOfServiceAgreed: true });

const http01 = http01Responder();
Bun.serve({ port: 80, fetch: http01.fetch });

const certificateKey = await generateKeyPair();
const csr = await createCsr({ names: ['example.com'], keyPair: certificateKey });
let order = await client.newOrder({ identifiers: [{ type: 'dns', value: 'example.com' }] });

for (const url of order.authorizations) {
	const authorization = await client.authorization(url);
	if (authorization.status === 'valid') continue;
	const challenge = authorization.challenges.find((c) => c.type === 'http-01');
	if (!challenge?.token) throw new Error(`no http-01 for ${authorization.identifier.value}`);
	http01.set(challenge.token, await client.keyAuthorization(challenge.token));
	try {
		await client.challenge(challenge.url); // POSTs {}
		await client.waitForAuthorization(url);
	} finally {
		http01.remove(challenge.token);
	}
}

order = await client.waitForOrder(order); // 'ready'
order = await client.finalize(order, csr);
order = await client.waitForOrder(order); // 'valid'
const chain = await client.certificate(order.certificate ?? '');
```

## Let's Encrypt staging

Let's Encrypt's staging environment issues from roots no client trusts,
with rate limits far above production's. Run every new setup against it
first: a failed validation in production counts against limits that
hold for an hour.

| | directory |
| --- | --- |
| staging | `https://acme-staging-v02.api.letsencrypt.org/directory` |
| production | `https://acme-v02.api.letsencrypt.org/directory` |

1. Point each name's A (and AAAA, if any) record at the server, and open
   port 80 from the Internet.
2. Run the full flow above with the staging directory.
3. Check what came back: `openssl x509 -in fullchain.pem -noout -text`
   shows the names, and an issuer of `(STAGING)`.
4. Switch `directoryUrl` to production. An account is per directory:
   `newAccount` again with the same key creates the production one (keep
   one account key per directory, or one for both: the key is yours, the
   account is the CA's).

`directory()` gives the current terms as `meta.termsOfService`: show them
to the operator before agreeing on their behalf.

## Limits and checks

What the CA sends is read as untrusted:

- **HTTPS only.** Every URL you give — the directory URL, `kid`, a
  method's `url` — must be `https:`, at most 2048 characters, without
  white space, credentials or a fragment,
  or it is `INVALID_OPTION`; every URL the CA gives — the directory's,
  an order's, an authorization's, a challenge's, a `Location` — likewise,
  or the answer is `BAD_RESPONSE`. `allowInsecure: true` lifts it, for a test CA
  on plain HTTP; never use it against a real CA.
- **No redirects.** A 3xx is `BAD_RESPONSE`: a redirect could lead a
  signed request off the URL it was signed for.
- **Bounded answers.** 256 KiB for JSON, 1 MiB for a certificate chain:
  refused before reading when `Content-Length` says more, cut off while
  reading otherwise.
- **Clamped numbers.** `Retry-After` (seconds or an HTTP date) is clamped
  to 0 to a week on an error, and a poll waits from `pollIntervalMs` to a
  minute whatever it says; a problem's `status` is kept only from 100 to
  599; lists are capped (1000 authorizations or challenges, 100
  subproblems), as are nonces (512 characters) and text (a `detail` to
  1024 characters, one line in a message).
- **Bounded time.** Every request has `requestTimeoutMs`, every wait and
  `obtainCertificate` a `timeoutMs`, and every call a `signal`. They
  bound your hooks too: a `set` that never settles is no longer waited
  for at the time limit or the abort, and the cleanup, which runs even
  then, has 10 seconds in all — each `remove` after its `set` settled.
- **The account key stays private.** The client keeps it in a private
  field: `inspect` shows `AcmeClient {}`, `JSON.stringify` shows `{}`, and
  no message holds it. Only its public half leaves, in `newAccount`'s
  `jwk` and as the thumbprint in key authorizations.

Not done here yet, and on the [roadmap](roadmap.md): DNS-01 and wildcard
names, account key rollover (`keyChange`), revocation (`revokeCert`),
external account binding, alternate chains, and renewal information
(ARI).

## Errors

Every function throws an `AcmeError`, with a `code`;
[troubleshooting](troubleshooting.md) lists every message. The first
five codes are about what you passed; the others about the CA's answer,
or the way to it, and carry what the CA said: `problem` (its problem
document), `status` (the HTTP status) and `retryAfter` (seconds).

| code | thrown for |
| --- | --- |
| `INVALID_NAME` | a name `createCsr` will not put in a request |
| `INVALID_OPTION` | an option of the wrong type or out of range: no names, too many, a duplicate, a nonce or URL a JWS cannot carry, a URL that is not `https:`, a payload that is not an object |
| `INVALID_KEY` | a key of another algorithm, an RSA key of another size than 2048, 3072 or 4096 bits or with an exponent other than 65537, a key of the wrong type (public for private), not extractable when it must be, or a PEM holding none |
| `INVALID_TOKEN` | a challenge token that is not base64url, or longer than 1024 characters |
| `NO_ACCOUNT` | a request that needs the account URL before `newAccount` gave one |
| `SERVER_PROBLEM` | the CA refused: a problem document, or an error status |
| `RATE_LIMITED` | the CA's `rateLimited`, with `retryAfter` when it said |
| `BAD_RESPONSE` | an answer the client will not use: too large, not JSON, a member missing, a URL not `https:`, a redirect, no nonce, no PEM chain or one out of order; from `obtainCertificate`, an order or a certificate for other names, or a certificate for another key |
| `NETWORK_ERROR` | `fetch` threw |
| `TIMEOUT` | a request past `requestTimeoutMs`, a wait or `obtainCertificate` past `timeoutMs`, or a `signal` from `AbortSignal.timeout` |
| `ABORTED` | the `signal` fired |
| `AUTHORIZATION_FAILED` | an authorization ended other than `valid`, or offers no `http-01` |
| `ORDER_FAILED` | an order became `invalid` |

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

## Testing against Pebble

[Pebble](https://github.com/letsencrypt/pebble) is Let's Encrypt's ACME
test server. `bun run pebble:test` starts it in Docker and prints the two
variables the specs read:

```sh
eval "$(bun run --silent pebble:test)"   # BUMAIL_TEST_PEBBLE_URL, BUMAIL_TEST_PEBBLE_CA
bun run test
bun run pebble:test stop
```

Pebble serves its API over HTTPS under a test CA of its own, kept in its
image at `/test/certs/pebble.minica.pem`; the script copies it out, and
the specs' `fetch` trusts it, so they never need `allowInsecure`:

```ts
import { AcmeClient, generateKeyPair } from '@bumail/acme';

const ca = await Bun.file(process.env.BUMAIL_TEST_PEBBLE_CA ?? '').text();
const client = new AcmeClient({
	directoryUrl: 'https://localhost:14000/dir',
	accountKey: await generateKeyPair(),
	fetch: (url, init) => fetch(url, { ...init, tls: { ca } }),
});
```

Pebble validates HTTP-01 for real. It fetches the key authorization on
port 5002 rather than 80, and the names the specs order
(`a.bumail.test` to `d.bumail.test`) resolve, inside its container, to
the host (`--add-host <name>:host-gateway`), where the specs serve
`http01Responder()` on `0.0.0.0:5002`. Pebble also refuses 5 % of nonces,
which the client's `badNonce` retry runs through. CI's "CI" job runs
Pebble as a service and sets `BUMAIL_TEST_PEBBLE_REQUIRED`, which turns a
missing Pebble from a skip into a failure.

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
  last included: a high bit set, leading zeros, zero, a 256-bit value;
- the client against a fake CA behind its `fetch`: the directory kept,
  nonces reused and fetched by a HEAD only when none is left, `badNonce`
  retried with the refusal's nonce and given up after 3, every signed
  request's `url` and payload (empty for POST-as-GET, `{}` for a
  challenge), problem documents, rate limits and `Retry-After` in
  seconds and as a date, clamped, polling as `Retry-After` says, a wait's
  timeout, aborts before, during and between requests, the size caps by
  `Content-Length` and while streaming, `https:` refused elsewhere, a
  redirect refused, and the account key in no output;
- `obtainCertificate` against the same fake, which issues a real chain
  for the CSR's key: every token removed after a failed validation, a
  `set` that threw, an abort and a timeout — a `set` landing after them
  included — and an order for other names, an order valid before
  finalize, and a leaf for another key or other names refused;
- the whole flow against Pebble, Let's Encrypt's test server, validating
  HTTP-01 for real, for P-256 and RSA keys: each issued chain read back
  with `node:crypto`'s `X509Certificate` — the names, the certificate's
  public key, the leaf signed by its issuer — and a wrong key
  authorization failing as `unauthorized`.
