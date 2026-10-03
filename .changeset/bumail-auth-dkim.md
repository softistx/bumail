---
"@bumail/auth": minor
---

First release: DKIM (RFC 6376). `verifyDkim` checks every DKIM-Signature on a message — bytes, a string or a stream, the body hashed with bounded memory — and gives one result per signature in RFC 8601's words, never throwing for a bad message. `signDkim` returns the folded `DKIM-Signature` field, over-signing From by default. rsa-sha256 and ed25519-sha256 (RFC 8463) through Web Crypto, simple and relaxed canonicalisation, keys looked up through `@bumail/dns`, and `importDkimPrivateKey` for PKCS #1, PKCS #8 and raw Ed25519 keys.
