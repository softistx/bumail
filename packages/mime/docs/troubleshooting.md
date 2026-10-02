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
- [`MimeError: The message has more than … parts`](#mimeerror-the-message-has-more-than--parts)

**Parser options**

- [`MimeError: MimeParser: … must be an integer of at least …, not …`](#mimeerror-mimeparser--must-be-an-integer-of-at-least--not-)

**Writing**

- [`MimeError: buildMessage(): "…" is not an e-mail address`](#mimeerror-buildmessage--is-not-an-e-mail-address)
- [`MimeError: buildMessage(): "…" holds … addresses where one is expected`](#mimeerror-buildmessage--holds--addresses-where-one-is-expected)
- [`MimeError: formatMailbox(): a display name cannot hold a line break or a control character`](#mimeerror-formatmailbox-a-display-name-cannot-hold-a-line-break-or-a-control-character)
- [`MimeError: The value of … holds a line break`](#mimeerror-the-value-of--holds-a-line-break)
- [`MimeError: The value of … holds a word too long for a header line (RFC 5322 §2.1.1: 998)`](#mimeerror-the-value-of--holds-a-word-too-long-for-a-header-line-rfc-5322-211-998)
- [`MimeError: "…" is not a header field name`](#mimeerror--is-not-a-header-field-name)
- [`MimeError: headers: … is written by buildMessage; set it through its own option`](#mimeerror-headers--is-written-by-buildmessage-set-it-through-its-own-option)
- [`MimeError: messageId: "…" is not a message id`](#mimeerror-messageid--is-not-a-message-id)
- [`MimeError: "…" is not a media type`](#mimeerror--is-not-a-media-type)
- [`MimeError: A file name cannot hold a control character`](#mimeerror-a-file-name-cannot-hold-a-control-character)
- [`MimeError: formatDate(): the date is invalid`](#mimeerror-formatdate-the-date-is-invalid)
- [`MimeError: formatDate(): the year … is outside 1900–9999`](#mimeerror-formatdate-the-year--is-outside-19009999)
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

## `MimeError: The message has more than … parts`

**When**: `MimeParser.write`, `parseMimeStream` or `parseMessage`, with
`error.code === 'TOO_MANY_PARTS'`.

**Why**: the message holds more parts than `maxParts` (1000 by default),
nested ones included. Each part costs a frame and its events however small
it is, so 4 MiB of empty parts — `--b` and a blank line, over and over —
would take hundreds of megabytes; the limit bounds that.

**Fix**: raise the limit when such messages are legitimate for you, or
refuse the message:

```ts
const parser = new MimeParser({ maxParts: 5000 });
```

## `MimeError: MimeParser: … must be an integer of at least …, not …`

**When**: `new MimeParser(options)`, `parseMessage` or `parseMimeStream`,
with `error.code === 'INVALID_OPTION'`: `maxHeaderBytes` below 1,
`maxDepth` below 0, `maxLineBytes` below 1000, `maxParts` below 1, or any
of them not an
integer — `NaN` included.

**Why**: a limit that is not a number would switch itself off, and a
`maxLineBytes` shorter than a delimiter line would make the parser miss
delimiters.

**Fix**: pass integers, or leave an option out for its default.

## `MimeError: buildMessage(): "…" is not an e-mail address`

**When**: `buildMessage`, `envelopeOf`, `formatMailbox` or
`checkAddress(address, caller)`, with `error.code === 'INVALID_ADDRESS'`.
Also when any address string — `from`, `sender`, `to`, `cc`, `bcc` or
`replyTo` — holds no mailbox at
all — an empty string, or an empty group such as
`undisclosed-recipients:;` — or holds text after an `<address>` that is not
a comma and the next mailbox: `A <a@b.test> B <v@c.test>`,
`<a@b.test>; v@c.test`, `<a@b.test>: v@c.test`, an address before the
`<`, as in `a@b.test <v@c.test>`, a comment, quote or `[` left open (it
would swallow every address after it), or two words of an address with
nothing between them, as in `a b@c.test`, which a reader would glue into
`ab@c.test`, or anything but an obs-route (`@domain,@domain:`) before a
`:` inside `<…>`, as in `<v@x.test:a@b.test>`, which a reader would drop
along with `v@x.test`.
The message starts with the function that refused it: `buildMessage():`,
`envelopeOf():`, `formatMailbox():`, or the `caller` you gave
`checkAddress`. Control and invisible characters show escaped — `\r\n`,
`\u200b` — so an address that looks valid in the message is not.

**Why**: an address — Bcc included — is not RFC 5322 §3.4.1's `addr-spec`:
its local part is neither a dot-atom (`jo.e+tag`) nor a quoted string
(`"john doe"`), or its domain is neither dot-separated labels nor an
address literal — `[192.0.2.1]`, `[IPv6:…]` or `[tag:content]` (RFC 5321
§4.1.3). A comma, a semicolon, a parenthesis, a stray quote, white space,
an empty label, an angle bracket inside a literal or a control character
are all refused: each would let the value add a recipient, or reach a
header or an SMTP command it does not belong in. So are the characters
that hide or reorder text — C1 controls, every Unicode format character
(zero-width spaces and joiners, the soft hyphen, bidirectional marks,
overrides and isolates, the BOM), the non-ASCII spaces (no-break, em,
ideographic…), the fillers that render blank (Hangul fillers, U+2800),
variation selectors (so an emoji with VS16 is refused), lone surrogates, U+2028 and
U+2029 — which let an
address pass for another. That includes the zero-width joiner and
non-joiner (U+200C, U+200D), which some scripts use inside words: they are
refused on purpose, since an address that holds them looks the same as one
that does not. Non-ASCII letters (RFC 6532) pass. Text after an `<address>`
is refused rather than dropped, so no recipient is lost unseen.

**Fix**: pass `'Name <user@example.com>'`, `'user@example.com'`, or
`{ name, address }`, and strip what you take from user input. For an empty
group such as `undisclosed-recipients:;`, leave the field out: `bcc` alone
already keeps the recipients out of the headers.

## `MimeError: buildMessage(): "…" holds … addresses where one is expected`

**When**: `from` or `sender` is a string that lists several mailboxes, or
a group of several, with `error.code === 'INVALID_ADDRESS'`. The message starts with
`buildMessage():` or `envelopeOf():`.

**Why**: a message has one author address in `From` for SMTP's `MAIL FROM`,
and one `Sender`. Keeping the first and dropping the rest would hide the
mistake. A string in `to`, `cc`, `bcc` or `replyTo` may list several: each
one is kept, a group's members included.

**Fix**: give `from` one address; put the others in `replyTo` or `cc`.

## `MimeError: formatMailbox(): a display name cannot hold a line break or a control character`

**When**: a `{ name, address }` whose name holds CR, LF or another control
character, from `buildMessage` or `formatMailbox`, with
`error.code === 'INVALID_ADDRESS'`.

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
that no folding keeps its line within 998 characters, with
`error.code === 'INVALID_OPTION'`.

**Why**: RFC 5322 caps a line at 998 characters, and many servers refuse a
message that does not keep to it.

**Fix**: put spaces in the value, or carry long data in the body.

## `MimeError: "…" is not a header field name`

**When**: a key of `headers` holds a space, a colon or a character outside
printable ASCII, with `error.code === 'INVALID_OPTION'`.

**Fix**: use a field name: `X-Campaign`, not `X Campaign`.

## `MimeError: headers: … is written by buildMessage; set it through its own option`

**When**: `headers` holds `From`, `Sender`, `To`, `Cc`, `Bcc`, `Reply-To`,
`Subject`, `Date`, `Message-ID`, `In-Reply-To`, `References`,
`MIME-Version` or any `Content-*` field, in any case, with
`error.code === 'INVALID_OPTION'`.

**Why**: the builder writes these itself; a second `Content-Transfer-Encoding`
or `From` makes readers disagree about the message.

**Fix**: use the option: `from`, `subject`, `messageId`, `attachments`…

## `MimeError: messageId: "…" is not a message id`

**When**: `messageId`, `inReplyTo`, an entry of `references` or an
attachment's `contentId` holds an angle bracket, white space or a control
character, with `error.code === 'INVALID_OPTION'`. The message starts
with the option's name.

**Why**: an id is written between angle brackets (RFC 5322 §3.6.4); a
bracket inside would end it early and start another.

**Fix**: pass the id without its brackets: `1234@example.com`.

## `MimeError: "…" is not a media type`

**When**: an attachment's `contentType` is not `type/subtype`, each an
RFC 2045 §5.1 token, with `error.code === 'INVALID_OPTION'`: a parameter
(`text/plain;name=a.exe`), a quote, a space or a line break in it, for one.

**Why**: the builder writes the parameters itself — `name=` from
`filename` — so one smuggled into the type would make readers disagree
about the file.

**Fix**: pass the media type alone, such as `'application/pdf'`.

## `MimeError: A file name cannot hold a control character`

**When**: an attachment's `filename` holds a control character, with
`error.code === 'INVALID_OPTION'`.

**Fix**: strip control characters from names taken from user input.

## `MimeError: formatDate(): the date is invalid`

**When**: `buildMessage` with a `date` that is an Invalid Date —
`new Date('not a date')`, `new Date(NaN)` — or `formatDate` given one, with
`error.code === 'INVALID_OPTION'`.

**Why**: an Invalid Date has no day, month or time to write in a `Date`
field.

**Fix**: check `Number.isNaN(date.getTime())` on dates parsed from user
input, or leave `date` out to use the current time.

## `MimeError: formatDate(): the year … is outside 1900–9999`

**When**: `buildMessage` with a `date`, or `formatDate`, whose UTC year is
before 1900 or after 9999, with `error.code === 'INVALID_OPTION'`.

**Why**: RFC 5322 §3.3 writes a year in four digits or more, and a reader
takes a short year as an obsolete two- or three-digit one (§4.3): year 999
would come back as 2899. A year past 9999 is no date a reader expects.

**Fix**: check the year of dates taken from user input — a typo such as
`0226` for `2026` is the usual cause — or leave `date` out to use the
current time.

## The Bcc recipients are missing from the message

**When**: the raw message has no `Bcc` field.

**Why**: by design — a Bcc written into the message is visible to every
recipient. `envelopeOf(options).to` holds them, for the SMTP `RCPT TO`
commands.
