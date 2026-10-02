# @bumail/mime

Read and write e-mail messages in Bun: RFC 5322 headers and addresses,
encoded-words (RFC 2047) and parameter continuations (RFC 2231), MIME
multipart, base64 and quoted-printable, any charset `TextDecoder` knows,
and a streaming parser that reads a message of any size in bounded memory.
No dependency; `typescript` is an optional peer, for the types.

```sh
bun add @bumail/mime
```

## Parse a message

```ts
import { extractContent, parseMessage } from '@bumail/mime';

const message = parseMessage(await Bun.file('message.eml').bytes());

message.headers.text('subject'); // 'Réunion à 10h', encoded-words decoded
const { text, html, attachments } = extractContent(message);
for (const file of attachments) {
	await Bun.write(file.filename ?? 'attachment', file.content);
}
```

Every part is a `MimePart`: `headers`, `contentType`, `children`, and
`content` (the body decoded from base64 or quoted-printable) or `text`
(decoded again from its charset). `path` numbers the parts as IMAP does:
`''`, `'1'`, `'1.2'`.

## Parse a stream

```ts
import { createTransferDecoder, parseMimeStream } from '@bumail/mime';

for await (const event of parseMimeStream(Bun.file('message.eml').stream())) {
	if (event.type === 'headers') console.log(event.part.path, event.part.contentType.mediaType);
	if (event.type === 'body') save(event.part.path, event.data); // raw, still encoded
}
```

The parser keeps one line and one header block, never a body: give it a
message of any size. `MimeParser` is the same parser, pushed by hand with
`write(chunk)` and `end()`. Decode a body as it streams with
`createTransferDecoder(part.headers.get('content-transfer-encoding'))`.

## Read headers

```ts
import { parseAddressList, parseContentType, parseDate } from '@bumail/mime';

parseAddressList('"Doe, John" <jdoe@example.com>, Team: a@x.test, b@x.test;');
// [{ name: 'Doe, John', address: 'jdoe@example.com' },
//  { group: 'Team', members: [{ name: '', address: 'a@x.test' }, …] }]

parseContentType("application/pdf; name*=utf-8''r%C3%A9sum%C3%A9.pdf").parameters.name; // 'résumé.pdf'
parseDate('Fri, 21 Nov 1997 09:55:06 -0600'); // Date
```

## Write a message

```ts
import { buildMessage, envelopeOf } from '@bumail/mime';

const options = {
	from: { name: 'André', address: 'andre@example.org' },
	to: 'Mary Smith <mary@example.net>',
	bcc: 'archive@example.org',
	subject: 'Réunion à 10h',
	text: 'Bonjour,\nà tout à l’heure.',
	html: '<p>Bonjour, <img src="cid:logo@example.org"></p>',
	attachments: [
		{ filename: 'logo.png', contentType: 'image/png', content: logo, contentId: 'logo@example.org' },
		{ filename: 'ordre du jour.pdf', contentType: 'application/pdf', content: pdf },
	],
};

const raw = buildMessage(options); // 7-bit ASCII, CRLF, ready for SMTP
const { from, to } = envelopeOf(options); // MAIL FROM and every RCPT TO, Bcc included
```

The body nests as mail clients expect — `multipart/mixed` around
`multipart/related` around `multipart/alternative` — and only as deep as
the message needs. Bcc is never written. Every address, name, id and value
is checked: nothing given can add a header, an address or an SMTP command.

## API

| export | |
| --- | --- |
| `parseMessage(bytes \| string, options?)` | the message as a tree of `MimePart` |
| `extractContent(part)`, `MessageContent` | `{ text?, html?, attachments }` |
| `MimePart` | `path`, `headers`, `contentType`, `children`, `raw`, `content`, `text`, `disposition`, `filename`, `contentId`, `walk()` |
| `MimeParser` | the streaming parser: `write(chunk)` and `end()` return `MimeEvent[]` |
| `parseMimeStream(stream, options?)` | the parser over a `ReadableStream` or an async iterable |
| `MimeEvent`, `PartInfo`, `MimeParserOptions` | `headers` / `body` / `end` events; `maxHeaderBytes`, `maxDepth`, `maxLineBytes`, `maxParts` |
| `buildMessage(options)` | a message as a 7-bit string with CRLF |
| `envelopeOf(options)` | `{ from, to }` for SMTP |
| `MessageOptions`, `Attachment`, `AddressInput`, `Envelope` | the options of `buildMessage` |
| `parseHeaderBlock(block)`, `MessageHeaders`, `HeaderField` | header fields, unfolded, case-insensitive |
| `parseAddressList(value)`, `mailboxesOf(list)`, `formatMailbox(mailbox)` | addresses and groups (RFC 5322 §3.4) |
| `checkAddress(address, caller)` | throws unless the address is safe in a header and an SMTP command |
| `Address`, `Mailbox`, `Group` | |
| `parseContentType(value)`, `parseContentDisposition(value)` | with RFC 2231 parameters |
| `formatParameter(name, value)` | a parameter as written, with RFC 2231 continuations when long or not ASCII |
| `ContentType`, `ContentDisposition` | |
| `parseDate(value)`, `formatDate(date)` | RFC 5322 §3.3 dates |
| `decodeEncodedWords(value)`, `encodeHeaderValue(value)` | RFC 2047 |
| `foldHeader(name, value)` | `Name: value`, folded at 78 |
| `encodeBase64`, `decodeBase64`, `Base64Decoder` | RFC 2045 §6.8 |
| `encodeQuotedPrintable`, `decodeQuotedPrintable`, `QuotedPrintableDecoder` | RFC 2045 §6.7 |
| `createTransferDecoder(encoding)`, `decodeTransfer(body, encoding)`, `TransferDecoder` | by `Content-Transfer-Encoding` |
| `decodeCharset(bytes, charset)`, `charsetLabel(charset)` | charsets through `TextDecoder` |
| `MimeError`, `MimeErrorCode` | `HEADER_TOO_LARGE`, `INVALID_ADDRESS`, `INVALID_OPTION`, `TOO_MANY_PARTS` |

## Documentation

- [Guide](https://github.com/softistx/bumail/blob/develop/packages/mime/docs/guide.md): parsing whole messages and streams, headers, addresses and dates, charsets, writing messages, and the RFCs each part follows.
- [Troubleshooting](https://github.com/softistx/bumail/blob/develop/packages/mime/docs/troubleshooting.md): every error, and the traps that print none.
- [Roadmap](https://github.com/softistx/bumail/blob/develop/packages/mime/docs/roadmap.md): what is coming, and what is not planned.
