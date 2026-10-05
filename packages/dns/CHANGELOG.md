# @bumail/dns

## 0.2.0

### Minor Changes

- [#74](https://github.com/softistx/bumail/pull/74) [`b1cfa8e`](https://github.com/softistx/bumail/commit/b1cfa8eaba6d412342c60127eaf29e1eb7150cb5) Thanks [@SteveGT96](https://github.com/SteveGT96)! - `formatZone(records)` writes records as BIND zone-file lines, for an operator to publish: `{ name, type, ttl?, value, priority? }` for `A`, `AAAA`, `MX`, `TXT`, `SRV`, `CAA`, `CNAME`, `NS` and `PTR`. Names are made absolute with a trailing dot, a TXT value over 255 bytes is split into quoted strings of 255 bytes at most (never inside a character) with quotes and backslashes escaped, and a record it cannot write throws `DnsError` (`INVALID_NAME` or `INVALID_OPTION`), named by its index.

## 0.1.1

### Patch Changes

- [#20](https://github.com/softistx/bumail/pull/20) [`8bdc1ad`](https://github.com/softistx/bumail/commit/8bdc1adb2cf737992be6c21da44ab3ce5889ac09) Thanks [@SteveGT96](https://github.com/SteveGT96)! - `normalizeName` now refuses a name of more than 253 code points (after NFC) before the IDN mapping runs, with the same `it is longer than 253 characters` error. Such a name could never fit, and the mapping's cost grew quadratically with the length (about 40 ms at 80 000 characters).

## 0.1.0

### Minor Changes

- [#8](https://github.com/softistx/bumail/pull/8) [`387956a`](https://github.com/softistx/bumail/commit/387956a25b17ae6df92e3fe416283b4a209a50a9) Thanks [@SteveGT96](https://github.com/SteveGT96)! - First release: the `Resolver` interface for the DNS a mail server reads — MX (sorted, null MX recognised), TXT (character-strings joined), A, AAAA and PTR — with `nodeResolver` on `node:dns/promises`, `fixtureResolver` for specs that never touch the network, and `cachedResolver`, which honours TTLs, keeps `NOT_FOUND` for a bounded time and never keeps a temporary failure. Every failure is a `DnsError` that tells "no such record" from "try later"; names are normalised and checked before any query.
