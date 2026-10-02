# Guide

- [Parsing a whole message](#parsing-a-whole-message)
- [Parsing a stream](#parsing-a-stream)
- [Headers](#headers)
- [Addresses](#addresses)
- [Content-Type and Content-Disposition](#content-type-and-content-disposition)
- [Dates](#dates)
- [Charsets](#charsets)
- [Transfer encodings](#transfer-encodings)
- [Writing a message](#writing-a-message)
- [What each part follows](#what-each-part-follows)

## Parsing a whole message

`parseMessage` takes the message as bytes — or a string, encoded as UTF-8 —
and returns its root `MimePart`:

```ts
import { parseMessage } from '@bumail/mime';

const message = parseMessage(await Bun.file('message.eml').bytes());

message.contentType.mediaType; // 'multipart/mixed'
for (const part of message.walk()) {
	console.log(part.path, part.contentType.mediaType, part.filename);
}
// ''     multipart/mixed
// '1'    multipart/alternative
// '1.1'  text/plain
// '1.2'  text/html
// '2'    application/pdf  ordre du jour.pdf
```

A part has:

| member | what it is |
| --- | --- |
| `path` | its number, as IMAP's `BODY[1.2]` numbers it: `''` for the message, `'1'` for its first child |
| `headers` | its `MessageHeaders` |
| `contentType` | its parsed `Content-Type`; `text/plain; charset=us-ascii` when it has none (RFC 2045 §5.2) |
| `children` | the parts of a multipart, in order; empty otherwise |
| `raw` | the body as written, still in its transfer encoding |
| `content` | the body decoded from base64 or quoted-printable |
| `text` | `content` decoded from the part's `charset` |
| `disposition` | the parsed `Content-Disposition`, if any |
| `filename` | the disposition's `filename`, else the type's `name` |
| `contentId` | the `Content-ID`, without brackets |

`extractContent` finds what a mail reader shows:

```ts
import { extractContent } from '@bumail/mime';

const { text, html, attachments } = extractContent(message);
```

Inside a `multipart/alternative` the **last** text and HTML parts win, since
RFC 2046 §5.1.4 orders alternatives from plainest to richest. Outside one,
the first `text/plain` and the first `text/html` not marked
`Content-Disposition: attachment` are the bodies. Every other leaf — files,
inline images, nested messages — is in `attachments`.

A `message/rfc822` part is a leaf: its body is the nested message. Parse it
again when you need it:

```ts
const nested = parseMessage(part.content);
```

## Parsing a stream

`parseMessage` holds the whole message. For a message received over SMTP
or read from disk, read it as a stream instead:

```ts
import { parseMimeStream } from '@bumail/mime';

for await (const event of parseMimeStream(Bun.file('big.eml').stream())) {
	switch (event.type) {
		case 'headers': // a part starts: event.part.headers, event.part.contentType
			break;
		case 'body': // a chunk of a leaf part's body, still transfer-encoded
			break;
		case 'end': // the part is complete
			break;
	}
}
```

The events come in document order: a multipart's children sit between its
`headers` and its `end`, and only leaf parts get `body` events.

`MimeParser` is the same parser without the stream, for a source that
pushes — a socket's `data` handler, for one:

```ts
import { MimeParser } from '@bumail/mime';

const parser = new MimeParser({ maxHeaderBytes: 64 * 1024 });
socket.data = (chunk) => handle(parser.write(chunk));
socket.end = () => handle(parser.end());
```

`write` and `end` return the events each one completed.

### Bounded memory

The parser keeps one header block and one line, never a body:

| option | default | what it bounds |
| --- | --- | --- |
| `maxHeaderBytes` | 64 KiB | one part's header block; past it, `MimeError` `HEADER_TOO_LARGE` |
| `maxLineBytes` | 64 KiB | a body line without a line break is passed on in pieces past this |
| `maxDepth` | 32 | a multipart nested deeper is read as an opaque body |

Decode a body as it streams with a `TransferDecoder`:

```ts
import { createTransferDecoder, decodeCharset } from '@bumail/mime';

const decoders = new Map();
for await (const event of parseMimeStream(stream)) {
	if (event.type === 'headers') {
		decoders.set(event.part.path, createTransferDecoder(event.part.headers.get('content-transfer-encoding')));
	} else if (event.type === 'body') {
		await sink.write(decoders.get(event.part.path).write(event.data));
	} else {
		await sink.write(decoders.get(event.part.path)?.end() ?? new Uint8Array());
	}
}
```

### How the boundaries are read

The parser follows RFC 2046 §5.1.1:

- The line break **before** a delimiter belongs to the delimiter: a part
  whose text ends without a line break reads without one.
- A delimiter may be followed by spaces or tabs.
- The preamble and the epilogue are ignored.
- An enclosing multipart's delimiter ends every part inside it, even one
  whose own closing delimiter never came.
- Bare LF line endings are read like CRLF.

## Headers

`parseHeaderBlock` reads the lines before the blank line. Folded fields are
unfolded (RFC 5322 §2.2.3), names match case-insensitively, and a field that
appears twice keeps both:

```ts
import { parseHeaderBlock } from '@bumail/mime';

const headers = parseHeaderBlock('Received: a\r\nReceived: b\r\nSubject: =?UTF-8?Q?Gr=C3=BC=C3=9Fe?=\r\n');
headers.getAll('received'); // ['a', 'b']
headers.get('subject'); // '=?UTF-8?Q?Gr=C3=BC=C3=9Fe?=' — raw
headers.text('subject'); // 'Grüße' — encoded-words decoded
```

Header bytes are read as UTF-8 (RFC 6532), and as windows-1252 when they are
not valid UTF-8 — what an old client sends unlabelled.

`decodeEncodedWords` decodes RFC 2047 words in any text. The white space
between two encoded-words is dropped (§6.2), and adjacent words in one
charset are decoded together, so a character a sender split across two
words still reads. `encodeHeaderValue` writes the reverse: only the words
that need it become `=?UTF-8?B?…?=`.

## Addresses

```ts
import { formatMailbox, mailboxesOf, parseAddressList } from '@bumail/mime';

const list = parseAddressList(
	'=?UTF-8?Q?Andr=C3=A9?= <andre@example.org>, Team: a@x.test, b@x.test;, old@x.test (Old Style)',
);
// [
//   { name: 'André', address: 'andre@example.org' },
//   { group: 'Team', members: [{ name: '', address: 'a@x.test' }, { name: '', address: 'b@x.test' }] },
//   { name: 'Old Style', address: 'old@x.test' },
// ]

mailboxesOf(list).map((mailbox) => mailbox.address); // groups opened

formatMailbox({ name: 'Doe, John', address: 'jdoe@example.com' }); // '"Doe, John" <jdoe@example.com>'
```

`parseAddressList` reads RFC 5322 §3.4 and the obsolete forms of §4.4 —
routes, white space around dots, comments anywhere, the name in a trailing
comment — and never throws: what it cannot read is left out.
`formatMailbox` quotes a name that holds a special, encodes one that is not
ASCII, and refuses a line break or an address without `@`.

## Content-Type and Content-Disposition

```ts
import { parseContentDisposition, parseContentType } from '@bumail/mime';

parseContentType('Text/Plain; charset="UTF-8" (comment)');
// { mediaType: 'text/plain', type: 'text', subtype: 'plain', parameters: { charset: 'UTF-8' } }

parseContentType("application/pdf; name*0*=utf-8''r%C3%A9sum; name*1*=%C3%A9.pdf").parameters.name;
// 'résumé.pdf'

parseContentDisposition('attachment; filename="report.pdf"');
// { type: 'attachment', parameters: { filename: 'report.pdf' } }
```

Types and parameter names come back in lower case; values keep their case.
RFC 2231 continuations are joined in numeric order and decoded from their
charset. A value written as an RFC 2047 encoded-word — which RFC 2047 §5
forbids in a parameter, and Outlook and Gmail send anyway — is decoded too.

## Dates

```ts
import { formatDate, parseDate } from '@bumail/mime';

parseDate('Thu, 13 Feb 1969 23:32:54 -0330'); // 1969-02-14T03:02:54Z
parseDate('21 Nov 97 09:55:06 GMT'); // 1997-11-21T09:55:06Z
formatDate(new Date()); // 'Fri, 02 Oct 2026 22:00:00 +0000'
```

`parseDate` reads RFC 5322 §3.3 with §4.3's obsolete forms: two- and
three-digit years, `UT`, `GMT` and the US zone names, comments. A military
zone letter reads as UTC, as §4.3 asks. It returns `undefined` for what is
not a date. `formatDate` always writes UTC.

## Charsets

`decodeCharset(bytes, charset)` decodes through `TextDecoder`, which knows
every charset of the WHATWG Encoding Standard: ISO-8859-*, windows-125*,
KOI8, Shift_JIS, EUC-JP, ISO-2022-JP, GBK, Big5, EUC-KR and more.

- `us-ascii` reads as windows-1252, as browsers do: mail labelled ASCII
  often carries 8-bit bytes.
- `iso-8859-1` also reads as windows-1252, per the Encoding Standard.
- An unknown label reads as UTF-8 when the bytes are valid UTF-8, and as
  windows-1252 otherwise.
- `utf-7` reads as UTF-8: the platform has no UTF-7 decoder.

## Transfer encodings

| function | for |
| --- | --- |
| `decodeBase64(text)`, `encodeBase64(bytes, lineLength = 76)` | RFC 2045 §6.8; decoding ignores what is not in the alphabet |
| `decodeQuotedPrintable(text)`, `encodeQuotedPrintable(text)` | RFC 2045 §6.7; line breaks are CRLF |
| `Base64Decoder`, `QuotedPrintableDecoder` | the same, chunk by chunk |
| `createTransferDecoder(encoding)` | the decoder for a `Content-Transfer-Encoding`; `7bit`, `8bit`, `binary` and unknown ones pass through, as §6.4 asks |
| `decodeTransfer(body, encoding)` | a whole body at once |

## Writing a message

```ts
import { buildMessage, envelopeOf } from '@bumail/mime';

const options = {
	from: 'Billing <billing@example.com>',
	to: [{ name: 'Mary Smith', address: 'mary@example.net' }],
	cc: 'accounts@example.net',
	bcc: 'archive@example.com',
	replyTo: 'support@example.com',
	subject: 'Votre facture d’octobre',
	inReplyTo: '1234@example.net',
	references: ['1234@example.net'],
	text: 'Bonjour,\nvotre facture est jointe.',
	html: '<p>Bonjour,</p><p>votre facture est jointe.</p>',
	attachments: [{ filename: 'facture-octobre.pdf', contentType: 'application/pdf', content: pdf }],
	headers: { 'List-Unsubscribe': '<mailto:unsubscribe@example.com>' },
};

const raw = buildMessage(options);
const envelope = envelopeOf(options);
// { from: 'billing@example.com', to: ['mary@example.net', 'accounts@example.net', 'archive@example.com'] }
```

What `buildMessage` writes:

- `Date` (now, unless `date` is given), `From`, `Sender`, `To`, `Cc`,
  `Reply-To`, `Subject`, `Message-ID` (a random UUID at the sender's domain
  unless `messageId` is given), `In-Reply-To`, `References`, your
  `headers`, then `MIME-Version: 1.0`. **`Bcc` is never written**; only
  `envelopeOf` reads it.
- The bodies: one part, or `multipart/alternative` for text and HTML;
  inside `multipart/related` when an attachment has a `contentId`; inside
  `multipart/mixed` when there are other attachments. No level is added
  that the message does not need.
- Text as `7bit` when it is ASCII with lines up to 998 characters, as
  `quoted-printable` otherwise, always `charset=utf-8`, line breaks as CRLF.
  Attachments as base64; a non-ASCII file name with RFC 2231.
- Header values with encoded-words where needed, folded at 78 characters.

The result is 7-bit ASCII with CRLF line breaks: it goes to any SMTP server
as it is, 8BITMIME or not.

Addresses are given as `'Name <address>'` strings, bare addresses, or
`{ name, address }` objects. Every value is checked: a line break in a
header value, a header name that is not one, or an address without `@`
throws a `MimeError`.

## What each part follows

| behaviour | RFC |
| --- | --- |
| header fields, folding, addresses, dates | RFC 5322 §2.2, §3.3, §3.4, and the obsolete syntax of §4 |
| UTF-8 in headers | RFC 6532 |
| `Content-Type`, transfer encodings | RFC 2045 |
| multipart, boundaries, alternatives | RFC 2046 §5.1 |
| encoded-words | RFC 2047 |
| parameter continuations and charsets | RFC 2231 |
| `Content-Disposition` | RFC 2183 |
| base64 | RFC 4648, RFC 2045 §6.8 |
| part numbers | RFC 9051 §6.4.5 |

The specs next to each module are built on these RFCs' own examples and name
the section each one comes from.
