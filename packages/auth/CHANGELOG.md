# @bumail/auth

## 0.3.0

### Minor Changes

- [#26](https://github.com/softistx/bumail/pull/26) [`4b4d0d0`](https://github.com/softistx/bumail/commit/4b4d0d0864d04606467c982019bc236d3ab776d8) Thanks [@SteveGT96](https://github.com/SteveGT96)! - DMARC (RFC 7489) and the `Authentication-Results` header (RFC 8601). `checkDmarc({ message, dkim, spf }, { resolver })` reads the message's From, finds the policy at `_dmarc.<From domain>` or else at its organizational domain, aligns the passing DKIM `d=` and SPF domains with From (relaxed or strict, `adkim=`/`aspf=`), applies `p=`, `sp=` and `pct` (through an injectable `random`), and gives `{ result, reason, domain, policyDomain, policy, disposition, alignedDkim, alignedSpf, sampled, record }` in RFC 8601's words. From is read strictly, as exactly one RFC 5322 mailbox whose address — never its display name — gives the domain: a message with no From, two From fields (a line after a bare CR or LF counted), one From with several addresses, a group, or a From that does not parse as one mailbox (an address in an unquoted display name, two angle addresses, text after the `>`, something unterminated, a control character) is a `permerror` with `disposition: 'reject'` (§6.6.1); several records are a `permerror`, a temporary DNS failure a `temperror`, and a record with no valid `p=` but a `rua=` is read as `p=none`. A temporary DKIM or SPF error counts only on an aligned domain. The organizational domain comes from an embedded snapshot of the Public Suffix List (ICANN and private sections, as a compact trie, shipped once: its source is left out of the source map), exported as `organizationalDomain` and replaceable through the option of that name. `rua=` and `ruf=` are parsed and returned; no report is sent. `formatAuthenticationResults(authservId, { dkim, spf, dmarc })` writes the field, folded through `@bumail/mime`, with `header.d`, `header.s`, `header.b`, `smtp.mailfrom` or `smtp.helo` and `header.from`; every value is a token or a quoted-string, and one holding a control character is left out. Never a throw for a message, the DNS or a record; `AuthError` only for an input or option it cannot take. The package's license is now `MIT AND MPL-2.0`: its own code is MIT, and the embedded Public Suffix List is MPL 2.0, whose text ships as `LICENSE-MPL-2.0`.

### Patch Changes

- Updated dependencies [[`e5f50d4`](https://github.com/softistx/bumail/commit/e5f50d46a2c14aa2a9fec2f1574e66a90086a0c0)]:
  - @bumail/mime@0.1.2

## 0.2.0

### Minor Changes

- [#23](https://github.com/softistx/bumail/pull/23) [`e54de6c`](https://github.com/softistx/bumail/commit/e54de6c3418c60060127763c3d2c00a535557650) Thanks [@SteveGT96](https://github.com/SteveGT96)! - SPF (RFC 7208). `checkSpf({ ip, mailFrom, helo }, { resolver })` runs `check_host()` for the MAIL FROM domain, or `postmaster@` the HELO name for a bounce, or the HELO name alone with `identity: 'helo'`, and gives `{ result, reason, domain, mechanism, explanation, lookups }` in RFC 8601's words. Every mechanism and qualifier, the `a/24//64` CIDR forms, `redirect=`, `exp=` (on `fail` only) and the macros are read; an IPv4-mapped client is checked as IPv4. It stops at 10 DNS-querying terms, 2 void lookups and 10 MX or PTR names, bounds macro expansion, and answers `temperror` past `timeout` (20 s, at most 2^31 − 1 ms). A name the resolver refuses before any query (a macro that expands `bob+news`) does not match and costs no void lookup; a local part past 64 octets or a HELO past 255 expands to no name. It never throws for a record or the DNS, only `AuthError` for an option or an `ip` it cannot take. It agrees with 197 of the 203 cases of the OpenSPF RFC 7208 test suite; the guide lists the six others.

## 0.1.0

### Minor Changes

- [#21](https://github.com/softistx/bumail/pull/21) [`d4bfd53`](https://github.com/softistx/bumail/commit/d4bfd5343d721f702fa0e1e4e5e484819bd8d593) Thanks [@SteveGT96](https://github.com/SteveGT96)! - First release: DKIM (RFC 6376). `verifyDkim` checks every DKIM-Signature on a message — bytes, a string or a stream, the body hashed with bounded memory — and gives one result per signature in RFC 8601's words, never throwing for a bad message. `signDkim` returns the folded `DKIM-Signature` field, over-signing From, Subject, Date, To, Cc, Reply-To, Message-ID, Content-Type and MIME-Version by default; the verifier answers `policy` for a From the signature does not cover. rsa-sha256 and ed25519-sha256 (RFC 8463) through Web Crypto, simple and relaxed canonicalisation, keys looked up through `@bumail/dns`, and `importDkimPrivateKey` for PKCS [#1](https://github.com/softistx/bumail/issues/1), PKCS [#8](https://github.com/softistx/bumail/issues/8) and raw Ed25519 keys.

### Patch Changes

- Updated dependencies [[`8bdc1ad`](https://github.com/softistx/bumail/commit/8bdc1adb2cf737992be6c21da44ab3ce5889ac09), [`8bdc1ad`](https://github.com/softistx/bumail/commit/8bdc1adb2cf737992be6c21da44ab3ce5889ac09)]:
  - @bumail/dns@0.1.1
  - @bumail/mime@0.1.1
