---
"@bumail/dns": patch
---

`normalizeName` refuses a name of more than 253 code points, once composed (NFC), as longer than 253 characters before running the IDN mapping, whose cost grew quadratically with the length (about 40 ms at 80 000 characters).
