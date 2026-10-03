# @bumail/mime

## 0.1.1

### Patch Changes

- [#20](https://github.com/softistx/bumail/pull/20) [`8bdc1ad`](https://github.com/softistx/bumail/commit/8bdc1adb2cf737992be6c21da44ab3ce5889ac09) Thanks [@SteveGT96](https://github.com/SteveGT96)! - `parseDate` strips comments in one pass, so a Date header full of unclosed `(` no longer costs time quadratic in its length (about 0.5 s at the 64 KiB header cap). Comments are read as RFC 5322 §3.2.2 says: nested ones whole, so `(a (b) c) 21 Nov 1997 …` now parses, and an unclosed one runs to the end of the value, so a date after an unclosed `(` is no longer read. A very long RFC 2231 parameter can no longer throw a `RangeError`.

## 0.1.0

### Minor Changes

- [#2](https://github.com/softistx/bumail/pull/2) [`8d65daa`](https://github.com/softistx/bumail/commit/8d65daa3e1fa75c1db7a0514da104773436c9dd3) Thanks [@SteveGT96](https://github.com/SteveGT96)! - The first release of `@bumail/mime`: read and write e-mail messages with no dependency — RFC 5322 headers, addresses and dates, RFC 2047 encoded-words, RFC 2231 parameters, MIME multipart, base64 and quoted-printable, charsets through `TextDecoder`, a streaming parser in bounded memory, and a builder that writes 7-bit messages ready for SMTP.

### Patch Changes

- [#7](https://github.com/softistx/bumail/pull/7) [`bc55684`](https://github.com/softistx/bumail/commit/bc556843f31e3ac206df263f554ba2bbe74871fc) Thanks [@SteveGT96](https://github.com/SteveGT96)! - The README links the docs index.
