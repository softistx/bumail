---
'@bumail/jmap': minor
---

The `@alxia/core` peer moves on to `^0.14.3`, which a `^0.10.0` does not accept: upgrade `@alxia/core` and every other `@alxia/*` package your app uses with it. The JMAP app's API is as before. Behind a trusted proxy that sends `X-Forwarded-Port`, the URLs it derives from the request (`originalUrl`, since `@alxia/core` 0.13) now carry that port.
