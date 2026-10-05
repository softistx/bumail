---
'@bumail/server': patch
---

`@alxia/core` moves on to `^0.9.0`, with `@bumail/jmap`. JMAP on 443 answers a request with the wrong method and no valid credentials with a 401 where it answered a 405; such a request with a wrong password counts as a failed login for the client's limiter, as on the right method.
