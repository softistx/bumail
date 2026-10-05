---
'@bumail/jmap': minor
---

The `@alxia/core` peer moves on to `^0.10.0`, which a `^0.9.0` does not accept: upgrade `@alxia/core` and every other `@alxia/*` package your app uses with it. `authenticate(credentials, request, client)` and `secure(request, client)` get a last argument, and `onError`'s context a `client`: `{ ip, url }`, the host app's `ctx.ip` and `originalUrl(ctx)`, exported as `JmapClient`. Behind `alxia({ proxy: trustProxy(…) })` they are what the trusted proxies said — the forwarded client's address, one text per address, and the scheme the outermost proxy wrote — so `secure: (_request, client) => client.url.protocol === 'https:'` replaces reading `X-Forwarded-Proto` yourself. Hooks written for the old arguments keep working, and every answer is unchanged; code that calls the hooks itself through `JmapOptions`, or builds an `ErrorContext`, now passes the `client` too.
