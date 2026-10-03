---
"@bumail/dns": patch
---

`normalizeName` now refuses a name of more than 253 code points (after NFC) before the IDN mapping runs, with the same `it is longer than 253 characters` error. Such a name could never fit, and the mapping's cost grew quadratically with the length (about 40 ms at 80 000 characters).
