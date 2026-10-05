---
'@bumail/jmap': minor
---

The `@alxia/core` peer moves on to `^0.9.0`, which a `^0.7.0` does not accept: upgrade `@alxia/core` and every other `@alxia/*` package your app uses with it. A request with the wrong method and no credentials, or wrong ones, is now a 401 with both challenges where it was a 405: alxia 0.9 runs the jmap group's authentication before it answers a 405, so its `Allow` names a route's methods to an authenticated client alone. With credentials, the 405 and its `Allow` are unchanged, as is every other answer.
