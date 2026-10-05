---
"@bumail/dns": minor
---

`formatZone(records)` writes records as BIND zone-file lines, for an operator to publish: `{ name, type, ttl?, value, priority? }` for `A`, `AAAA`, `MX`, `TXT`, `SRV`, `CAA`, `CNAME`, `NS` and `PTR`. Names are made absolute with a trailing dot, a TXT value over 255 bytes is split into quoted strings of 255 bytes at most (never inside a character) with quotes and backslashes escaped, and a record it cannot write throws `DnsError` (`INVALID_NAME` or `INVALID_OPTION`), named by its index.
