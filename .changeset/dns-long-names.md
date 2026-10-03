---
"@bumail/dns": patch
---

`normalizeName` refuses a name over 506 code units as longer than 253 characters before running the IDN mapping, whose cost grows with the length.
