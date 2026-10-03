---
"@bumail/dns": minor
---

First release: the `Resolver` interface for the DNS a mail server reads — MX (sorted, null MX recognised), TXT (character-strings joined), A, AAAA and PTR — with `nodeResolver` on `node:dns/promises`, `fixtureResolver` for specs that never touch the network, and `cachedResolver`, which honours TTLs, keeps `NOT_FOUND` for a bounded time and never keeps a temporary failure. Every failure is a `DnsError` that tells "no such record" from "try later"; names are normalised and checked before any query.
