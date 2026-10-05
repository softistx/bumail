# Troubleshooting: authentication

The refusals every route may answer before it runs, as the `detail` of an
RFC 7807 problem (`application/problem+json`, type `about:blank`). The
[index](../troubleshooting.md) lists every entry of every page.

## `401 Authentication required`

The request has no `Authorization` header, or one this server does not
read: a scheme other than `Basic` and `Bearer`, a header longer than
8 KiB, Basic whose value is not base64 of UTF-8 `user:password`, a Bearer
token with characters RFC 6750 does not allow. The response carries both
challenges in `WWW-Authenticate`. It comes before a 405: a request with the
wrong method gets this 401 until it authenticates.

```sh
curl -H 'Authorization: Bearer <token>' https://mail.example.com/.well-known/jmap
```

## `401 Authentication failed`

`authenticate` answered `null` or `undefined`: the credentials are wrong,
or the account is not allowed in. Nothing more is said to the client.

## `403 Basic authentication is refused on a clear connection: use HTTPS`

Basic credentials came on a request whose URL is `http:`. The password
would cross the network as written, so `authenticate` is not called. Use
HTTPS, or a Bearer token. Behind a proxy that ends TLS, the request the
server sees is `http:`: tell it how to know better, from what the host's
`trustProxy` read. A host that declares `trustProxy` but leaves `secure`
out still gets this 403: the default reads the request's own URL, not
`client.url`.

```ts
import { alxia, trustProxy } from '@alxia/core';

alxia({ proxy: trustProxy({ trusted: ['10.0.0.0/8'], untrusted: 'refuse-all' }) }).plugin(
	jmap({ …, secure: (_request, client) => client.url.protocol === 'https:' }),
);
```

`client.url` takes the scheme from a trusted proxy alone, the entry the
outermost one wrote: list every proxy of the chain in `trusted`, and
have the outermost overwrite `X-Forwarded-Proto` or every one append.
For local tests, `allowInsecureBasic: true`.

## `503 Temporary authentication failure`

`authenticate` threw, did not settle within `hookTimeout`, answered
something other than an id or `null`, or named an account the store does
not have; or the store's `getAccount` threw.
The response says `Retry-After: 5`; `onError` has the cause — see
[configuration](configuration.md).
