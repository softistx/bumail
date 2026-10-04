---
'@bumail/jmap': patch
---

The `@alxia/core` peer range moves from `^0.3.0` to `^0.3.1`, whose `parseRange` answers a range of an empty file as RFC 9110 does, and the download no longer works around it. Downloads answer as before: a suffix range of an empty blob (`bytes=-5`) serves it whole as a 200, and `bytes=0-` or `bytes=-0` is a 416 with `Content-Range: bytes */0`. An app on `@alxia/core` 0.3.0 upgrades it to 0.3.1.
