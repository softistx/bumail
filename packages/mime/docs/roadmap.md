# Roadmap

What `@bumail/mime` gives a mail server or a mail client, and what is
coming. This page is a direction, not a commitment: the version something
shipped in is the only number on it.

## Now

Nothing scheduled yet.

## Next

- **The features the rest of bumail needs from a message**, as they come:
  canonical forms for DKIM in `@bumail/auth`, and the JMAP `Email`
  properties in `@bumail/jmap`.

## Later

- **Writing 8-bit and SMTPUTF8 messages** — UTF-8 headers (RFC 6532) and
  `8bit` bodies, for a server that advertises 8BITMIME and SMTPUTF8,
  instead of always encoding to 7-bit.
- **Streaming a message out** — `buildMessage` as a `ReadableStream`, so a
  large attachment is never held whole.

## Not planned

- **A runtime dependency.** Charsets come from `TextDecoder`, base64 from
  `Uint8Array`; nothing else is needed.
- **UTF-7 decoding.** The platform has no decoder for it; UTF-7 mail is
  rare, and IMAP's modified UTF-7 for mailbox names is a different thing.
- **S/MIME and OpenPGP.** Signing and encrypting message bodies belongs in
  a package of its own, if ever.
- **TNEF (`winmail.dat`).** A Microsoft format inside a message, not MIME.

## Shipped

### 0.1.2

- **Encoded-words in linear time.** A run of adjacent RFC 2047
  encoded-words in one charset is joined once, where a hostile header of
  tens of thousands of words used to cost the square of its length.

### 0.1.1

- **Dates with comments, in one pass.** `parseDate` reads nested comments
  whole and strips them in time linear in the header's length, where an
  unclosed `(` used to cost its square; a very long RFC 2231 parameter no
  longer throws a `RangeError`.

### 0.1.0

- **Reading and writing messages** — headers, addresses, dates, encoded
  words, RFC 2231 parameters, multipart, base64 and quoted-printable,
  charsets through `TextDecoder`, a streaming parser in bounded memory, and
  a builder that writes 7-bit messages ready for SMTP.
