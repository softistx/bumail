---
"@bumail/mime": patch
---

`parseDate` strips comments in one pass, so a Date header full of unclosed `(` no longer costs time quadratic in its length (about 0.5 s at the 64 KiB header cap). Comments are read as RFC 5322 §3.2.2 says: nested ones whole, so `(a (b) c) 21 Nov 1997 …` now parses, and an unclosed one runs to the end of the value, so a date after an unclosed `(` is no longer read. A very long RFC 2231 parameter can no longer throw a `RangeError`.
