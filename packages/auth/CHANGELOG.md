# @bumail/auth

## 0.1.0

### Minor Changes

- [#21](https://github.com/softistx/bumail/pull/21) [`d4bfd53`](https://github.com/softistx/bumail/commit/d4bfd5343d721f702fa0e1e4e5e484819bd8d593) Thanks [@SteveGT96](https://github.com/SteveGT96)! - First release: DKIM (RFC 6376). `verifyDkim` checks every DKIM-Signature on a message — bytes, a string or a stream, the body hashed with bounded memory — and gives one result per signature in RFC 8601's words, never throwing for a bad message. `signDkim` returns the folded `DKIM-Signature` field, over-signing From, Subject, Date, To, Cc, Reply-To, Message-ID, Content-Type and MIME-Version by default; the verifier answers `policy` for a From the signature does not cover. rsa-sha256 and ed25519-sha256 (RFC 8463) through Web Crypto, simple and relaxed canonicalisation, keys looked up through `@bumail/dns`, and `importDkimPrivateKey` for PKCS [#1](https://github.com/softistx/bumail/issues/1), PKCS [#8](https://github.com/softistx/bumail/issues/8) and raw Ed25519 keys.

### Patch Changes

- Updated dependencies [[`8bdc1ad`](https://github.com/softistx/bumail/commit/8bdc1adb2cf737992be6c21da44ab3ce5889ac09), [`8bdc1ad`](https://github.com/softistx/bumail/commit/8bdc1adb2cf737992be6c21da44ab3ce5889ac09)]:
  - @bumail/dns@0.1.1
  - @bumail/mime@0.1.1
