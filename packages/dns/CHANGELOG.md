# @bumail/dns

## 0.1.0

### Minor Changes

- [#8](https://github.com/softistx/bumail/pull/8) [`387956a`](https://github.com/softistx/bumail/commit/387956a25b17ae6df92e3fe416283b4a209a50a9) Thanks [@SteveGT96](https://github.com/SteveGT96)! - First release: the `Resolver` interface for the DNS a mail server reads — MX (sorted, null MX recognised), TXT (character-strings joined), A, AAAA and PTR — with `nodeResolver` on `node:dns/promises`, `fixtureResolver` for specs that never touch the network, and `cachedResolver`, which honours TTLs, keeps `NOT_FOUND` for a bounded time and never keeps a temporary failure. Every failure is a `DnsError` that tells "no such record" from "try later"; names are normalised and checked before any query.
