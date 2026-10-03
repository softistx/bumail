---
"@bumail/mime": patch
---

`parseDate` strips comments in one pass, so a Date header full of unclosed `(` no longer costs time quadratic in its length (about 0.5 s at the 64 KiB header cap), and nested comments (RFC 5322 §3.2.2) are now read whole. RFC 2231 parameter sections are joined without spreading them into one call.
