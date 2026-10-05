---
'@bumail/server': minor
---

`@alxia/core` moves on to `^0.10.0`, with `@bumail/jmap`. Behind a proxy (`jmap.mode = "proxy"`), JMAP now reads `X-Forwarded-Proto` from the entry the outermost trusted proxy wrote, not the right-most: on a chain where every proxy appends (`https, http`), a client that used HTTPS is no longer refused Basic, and one that used plain HTTP no longer passes as TLS. The proxies are read by `@alxia/core`'s `trustProxy` with `untrusted: 'refuse-all'`, `jmap.trusted` as its list: a peer not in it still gets a 403 before anything is read, its body now `{"error":"untrusted_proxy"}` where it was `forbidden`; a chain of trusted proxies alone is counted under its leftmost, and an empty `X-Forwarded-For` entry, like one that is no address, falls back to the peer. `jmapAuthenticate`'s `ipOf` is given the `client` jmap names as a second argument (`JmapLoginClient`).
