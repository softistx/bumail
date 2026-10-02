# Troubleshooting

Each entry is headed by the text you see — the message of the error
thrown, or, for a trap that prints nothing, the symptom.

**Parsing**

- [`MimeError: The header block of part "…" is larger than … bytes`](#mimeerror-the-header-block-of-part--is-larger-than--bytes)
- [`Error: MimeParser.write(): the parser has ended`](#error-mimeparserwrite-the-parser-has-ended)
- [Accented letters read as `Ã©` or `�`](#accented-letters-read-as-ã-or-)
- [A `message/rfc822` part has no children](#a-messagerfc822-part-has-no-children)
- [A deeply nested part comes out as raw text](#a-deeply-nested-part-comes-out-as-raw-text)
- [`body` events are base64, not the file](#body-events-are-base64-not-the-file)

**Writing**

- [`MimeError: "…" is not an e-mail address`](#mimeerror--is-not-an-e-mail-address)
- [`MimeError: formatMailbox(): a display name cannot hold a line break`](#mimeerror-formatmailbox-a-display-name-cannot-hold-a-line-break)
- [`MimeError: The value of … holds a line break`](#mimeerror-the-value-of--holds-a-line-break)
- [`MimeError: "…" is not a header field name`](#mimeerror--is-not-a-header-field-name)
- [`MimeError: An attachment content type holds a line break`](#mimeerror-an-attachment-content-type-holds-a-line-break)
- [The Bcc recipients are missing from the message](#the-bcc-recipients-are-missing-from-the-message)

## `MimeError: The header block of part "…" is larger than … bytes`

**When**: `MimeParser.write`, `parseMimeStream` or `parseMessage`, with
`error.code === 'HEADER_TOO_LARGE'`.

**Why**: one part's headers — everything before its blank line — passed
`maxHeaderBytes` (64 KiB by default). The parser holds a header block in
memory, so it is bounded. A message with no blank line at all, or binary
data given as a message, hits it too.

**Fix**: raise the limit when such headers are legitimate — a long chain of
`Received` and `ARC-*` fields can reach it — or refuse the message:

```ts
const parser = new MimeParser({ maxHeaderBytes: 256 * 1024 });
```

## `Error: MimeParser.write(): the parser has ended`

**When**: `write` was called after `end`.

**Why**: `end` closes every open part; a parser reads one message.

**Fix**: create a `MimeParser` per message.

## Accented letters read as `Ã©` or `�`

**When**: `part.text` or a decoded header shows mojibake.

**Why**: the bytes are in another charset than the one used to read them.
`part.text` decodes with the part's `charset` parameter, UTF-8 when it has
none; `part.content` is the decoded bytes, before any charset.

**Fix**: read `part.contentType.parameters.charset` and decode the bytes
yourself when you know better:

```ts
import { decodeCharset } from '@bumail/mime';

const text = decodeCharset(part.content, 'windows-1252');
```

## A `message/rfc822` part has no children

**When**: a forwarded message is attached, and its part is a leaf.

**Why**: the parser reads a nested message as a body, not as parts, so a
forwarded message's attachments do not mix with the outer one's.

**Fix**: parse it again:

```ts
const nested = parseMessage(part.content);
```

## A deeply nested part comes out as raw text

**When**: a part's `text` starts with `--` and a boundary.

**Why**: the multipart is nested deeper than `maxDepth` (32 by default), and
is read as an opaque body to bound the work a hostile message can cause.

**Fix**: raise `maxDepth` if such messages are legitimate for you.

## `body` events are base64, not the file

**When**: reading `MimeEvent`s from `parseMimeStream` or `MimeParser`.

**Why**: the streaming parser passes on the body as written, in its
transfer encoding, so nothing is decoded that nobody reads.

**Fix**: decode with `createTransferDecoder(part.headers.get('content-transfer-encoding'))`
— see the [guide](guide.md#bounded-memory).

## `MimeError: "…" is not an e-mail address`

**When**: `buildMessage`, `envelopeOf` or `formatMailbox`, with
`error.code === 'INVALID_ADDRESS'`. From `formatMailbox` the message starts
with `formatMailbox(): `.

**Why**: an address string held no address — no `@`, or nothing
`parseAddressList` could read — or held `<`, `>` or a line break.

**Fix**: pass `'Name <user@example.com>'`, `'user@example.com'`, or
`{ name, address }`.

## `MimeError: formatMailbox(): a display name cannot hold a line break`

**When**: a `{ name, address }` whose name holds CR or LF.

**Why**: a line break in a header is how a header is injected.

**Fix**: strip line breaks from names taken from user input.

## `MimeError: The value of … holds a line break`

**When**: `buildMessage` or `foldHeader`, with `error.code === 'INVALID_OPTION'`:
a `subject` or a `headers` value holds CR or LF.

**Why**: it would let the value start a header of its own — `Bcc:`, for
one. It is refused before encoding, which would otherwise hide the line
break inside an encoded-word.

**Fix**: replace line breaks with spaces in values taken from user input.

## `MimeError: "…" is not a header field name`

**When**: a key of `headers` holds a space, a colon or a character outside
printable ASCII.

**Fix**: use a field name: `X-Campaign`, not `X Campaign`.

## `MimeError: An attachment content type holds a line break`

**When**: an attachment's `contentType` holds CR or LF.

**Fix**: pass a media type such as `'application/pdf'`.

## The Bcc recipients are missing from the message

**When**: the raw message has no `Bcc` field.

**Why**: by design — a Bcc written into the message is visible to every
recipient. `envelopeOf(options).to` holds them, for the SMTP `RCPT TO`
commands.
