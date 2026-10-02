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

**Parser options**

- [`MimeError: MimeParser: … must be an integer of at least …, not …`](#mimeerror-mimeparser--must-be-an-integer-of-at-least--not-)

**Writing**

- [`MimeError: buildMessage(): "…" is not an e-mail address`](#mimeerror-buildmessage--is-not-an-e-mail-address)
- [`MimeError: formatMailbox(): a display name cannot hold a line break or a control character`](#mimeerror-formatmailbox-a-display-name-cannot-hold-a-line-break-or-a-control-character)
- [`MimeError: The value of … holds a line break`](#mimeerror-the-value-of--holds-a-line-break)
- [`MimeError: The value of … holds a word too long for a header line (RFC 5322 §2.1.1: 998)`](#mimeerror-the-value-of--holds-a-word-too-long-for-a-header-line-rfc-5322-211-998)
- [`MimeError: "…" is not a header field name`](#mimeerror--is-not-a-header-field-name)
- [`MimeError: headers: … is written by buildMessage; set it through its own option`](#mimeerror-headers--is-written-by-buildmessage-set-it-through-its-own-option)
- [`MimeError: messageId: "…" is not a message id`](#mimeerror-messageid--is-not-a-message-id)
- [`MimeError: "…" is not a media type`](#mimeerror--is-not-a-media-type)
- [`MimeError: A file name cannot hold a control character`](#mimeerror-a-file-name-cannot-hold-a-control-character)
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

## `MimeError: MimeParser: … must be an integer of at least …, not …`

**When**: `new MimeParser(options)`, `parseMessage` or `parseMimeStream`,
with `error.code === 'INVALID_OPTION'`: `maxHeaderBytes` below 1,
`maxDepth` below 0, `maxLineBytes` below 1000, or any of them not an
integer — `NaN` included.

**Why**: a limit that is not a number would switch itself off, and a
`maxLineBytes` shorter than a delimiter line would make the parser miss
delimiters.

**Fix**: pass integers, or leave an option out for its default.

## `MimeError: buildMessage(): "…" is not an e-mail address`

**When**: `buildMessage`, `envelopeOf` or `formatMailbox`, with
`error.code === 'INVALID_ADDRESS'`. The message starts with the function
that refused it: `buildMessage():`, `envelopeOf():`, `formatMailbox():`.
Control characters show escaped, as `\r\n`.

**Why**: an address — Bcc included — held no `@`, nothing
`parseAddressList` could read, a control character, an angle bracket, or
white space outside a quoted local part. Any of them would let the value
reach a header or an SMTP command it does not belong in.

**Fix**: pass `'Name <user@example.com>'`, `'user@example.com'`, or
`{ name, address }`, and strip what you take from user input.

## `MimeError: formatMailbox(): a display name cannot hold a line break or a control character`

**When**: a `{ name, address }` whose name holds CR, LF or another control
character, from `buildMessage` or `formatMailbox`.

**Why**: a line break in a header is how a header is injected.

**Fix**: replace control characters in names taken from user input.

## `MimeError: The value of … holds a line break`

**When**: `buildMessage` or `foldHeader`, with `error.code === 'INVALID_OPTION'`:
a `subject` or a `headers` value holds CR or LF.

**Why**: it would let the value start a header of its own — `Bcc:`, for
one. It is refused before encoding, which would otherwise hide the line
break inside an encoded-word.

**Fix**: replace line breaks with spaces in values taken from user input.

## `MimeError: The value of … holds a word too long for a header line (RFC 5322 §2.1.1: 998)`

**When**: a header value has a word — a run without white space — so long
that no folding keeps its line within 998 characters.

**Why**: RFC 5322 caps a line at 998 characters, and many servers refuse a
message that does not keep to it.

**Fix**: put spaces in the value, or carry long data in the body.

## `MimeError: "…" is not a header field name`

**When**: a key of `headers` holds a space, a colon or a character outside
printable ASCII.

**Fix**: use a field name: `X-Campaign`, not `X Campaign`.

## `MimeError: headers: … is written by buildMessage; set it through its own option`

**When**: `headers` holds `From`, `Sender`, `To`, `Cc`, `Bcc`, `Reply-To`,
`Subject`, `Date`, `Message-ID`, `In-Reply-To`, `References`,
`MIME-Version` or any `Content-*` field, in any case.

**Why**: the builder writes these itself; a second `Content-Transfer-Encoding`
or `From` makes readers disagree about the message.

**Fix**: use the option: `from`, `subject`, `messageId`, `attachments`…

## `MimeError: messageId: "…" is not a message id`

**When**: `messageId`, `inReplyTo`, an entry of `references` or an
attachment's `contentId` holds an angle bracket, white space or a control
character. The message starts with the option's name.

**Why**: an id is written between angle brackets (RFC 5322 §3.6.4); a
bracket inside would end it early and start another.

**Fix**: pass the id without its brackets: `1234@example.com`.

## `MimeError: "…" is not a media type`

**When**: an attachment's `contentType` is not `type/subtype` in printable
ASCII — a line break or a parameter in it, for one.

**Fix**: pass the media type alone, such as `'application/pdf'`.

## `MimeError: A file name cannot hold a control character`

**When**: an attachment's `filename` holds a control character.

**Fix**: strip control characters from names taken from user input.

## The Bcc recipients are missing from the message

**When**: the raw message has no `Bcc` field.

**Why**: by design — a Bcc written into the message is visible to every
recipient. `envelopeOf(options).to` holds them, for the SMTP `RCPT TO`
commands.
