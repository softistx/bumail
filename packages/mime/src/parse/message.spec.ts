import { describe, expect, test } from 'bun:test';
import { extractContent, type MimePart, parseMessage } from './message';

const crlf = (text: string) => text.replace(/\r?\n/g, '\r\n');

/** RFC 5322 Appendix A.1.1, as printed. */
const SIMPLE = crlf(`From: John Doe <jdoe@machine.example>
To: Mary Smith <mary@example.net>
Subject: Saying Hello
Date: Fri, 21 Nov 1997 09:55:06 -0600
Message-ID: <1234@local.machine.example>

This is a message just to say hello.
So, "Hello".
`);

/** RFC 2046 §5.1.1, the example of a multipart message, as printed. */
const MULTIPART = crlf(`From: Nathaniel Borenstein <nsb@bellcore.com>
To: Ned Freed <ned@innosoft.com>
Date: Sun, 21 Mar 1993 23:56:48 -0800 (PST)
Subject: Sample message
MIME-Version: 1.0
Content-type: multipart/mixed; boundary="simple boundary"

This is the preamble.  It is to be ignored, though it
is a handy place for composition agents to include an
explanatory note to non-MIME conformant readers.

--simple boundary

This is implicitly typed plain US-ASCII text.
It does NOT end with a linebreak.
--simple boundary
Content-type: text/plain; charset=us-ascii

This is explicitly typed plain US-ASCII text.
It DOES end with a linebreak.

--simple boundary--

This is the epilogue.  It is also to be ignored.
`);

describe('parseMessage', () => {
	test('RFC 5322 A.1.1: a simple message', () => {
		const message = parseMessage(SIMPLE);
		expect(message.path).toBe('');
		expect(message.headers.get('subject')).toBe('Saying Hello');
		expect(message.contentType.mediaType).toBe('text/plain');
		expect(message.text).toBe(
			'This is a message just to say hello.\r\nSo, "Hello".\r\n',
		);
		expect(message.children).toEqual([]);
	});

	test("RFC 2046 §5.1.1: the line break before a delimiter is the delimiter's", () => {
		const message = parseMessage(MULTIPART);
		expect(message.contentType.mediaType).toBe('multipart/mixed');
		const [first, second] = message.children;
		expect(message.children).toHaveLength(2);
		expect(first?.path).toBe('1');
		expect(first?.headers.size).toBe(0);
		expect(first?.contentType.mediaType).toBe('text/plain');
		expect(first?.text).toBe(
			'This is implicitly typed plain US-ASCII text.\r\nIt does NOT end with a linebreak.',
		);
		expect(second?.path).toBe('2');
		expect(second?.text).toBe(
			'This is explicitly typed plain US-ASCII text.\r\nIt DOES end with a linebreak.\r\n',
		);
	});

	test('RFC 2046 §5.1.1: white space after a delimiter, and bare LF line endings', () => {
		const message = parseMessage(
			'Content-Type: multipart/mixed; boundary=b\n\n--b  \t\n\none\n--b--\t\n',
		);
		expect(message.children.map((part) => part.text)).toEqual(['one']);
	});

	test('nested multiparts are numbered as IMAP numbers them', () => {
		const message = parseMessage(
			crlf(`Content-Type: multipart/mixed; boundary=outer

--outer
Content-Type: multipart/alternative; boundary=inner

--inner
Content-Type: text/plain

plain
--inner
Content-Type: text/html

<p>html</p>
--inner--
--outer
Content-Type: application/octet-stream
Content-Transfer-Encoding: base64
Content-Disposition: attachment; filename="data.bin"

AAEC
--outer--
`),
		);
		expect(
			[...message.walk()].map(
				(part) => `${part.path}:${part.contentType.mediaType}`,
			),
		).toEqual([
			':multipart/mixed',
			'1:multipart/alternative',
			'1.1:text/plain',
			'1.2:text/html',
			'2:application/octet-stream',
		]);
		const file = message.children[1];
		expect(file?.filename).toBe('data.bin');
		expect([...(file?.content ?? [])]).toEqual([0, 1, 2]);
		expect(extractContent(message)).toEqual({
			text: 'plain',
			html: '<p>html</p>',
			attachments: [file as MimePart],
		});
	});

	test('an enclosing delimiter ends an inner part that was never closed', () => {
		const message = parseMessage(
			crlf(`Content-Type: multipart/mixed; boundary=outer

--outer
Content-Type: multipart/alternative; boundary=inner

--inner

cut short
--outer

second
--outer--
`),
		);
		expect(message.children.map((part) => part.path)).toEqual(['1', '2']);
		expect(message.children[0]?.children[0]?.text).toBe('cut short');
		expect(message.children[1]?.text).toBe('second');
	});

	test('a message with no closing delimiter keeps what it has', () => {
		const message = parseMessage(
			'Content-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\n\r\npartial',
		);
		expect(message.children[0]?.text).toBe('partial');
	});

	test('a message with no body, and no blank line', () => {
		const message = parseMessage('Subject: only headers');
		expect(message.headers.get('subject')).toBe('only headers');
		expect(message.raw).toHaveLength(0);
	});

	test('quoted-printable in ISO-8859-1', () => {
		const message = parseMessage(
			crlf(`Content-Type: text/plain; charset=ISO-8859-1
Content-Transfer-Encoding: quoted-printable

Keld J=F8rn Simonsen, a long line=
 continued
`),
		);
		expect(message.text).toBe('Keld Jørn Simonsen, a long line continued\r\n');
	});

	test('message/rfc822 is a part whose body parses again', () => {
		const message = parseMessage(
			crlf(`Content-Type: multipart/mixed; boundary=b

--b
Content-Type: message/rfc822

${SIMPLE}
--b--
`),
		);
		const inner = message.children[0];
		expect(inner?.children).toEqual([]);
		expect(
			parseMessage(inner?.content ?? new Uint8Array()).headers.get('subject'),
		).toBe('Saying Hello');
	});

	test('a multipart nested past maxDepth is read as an opaque body', () => {
		const message = parseMessage(
			'Content-Type: multipart/mixed; boundary=a\r\n\r\n--a\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\n\r\nx\r\n--b--\r\n--a--\r\n',
			{ maxDepth: 1 },
		);
		const inner = message.children[0];
		expect(inner?.children).toEqual([]);
		expect(inner?.text).toBe('--b\r\n\r\nx\r\n--b--');
	});
});

describe('extractContent', () => {
	test('outside an alternative, the first text wins and other texts are attachments', () => {
		const message = parseMessage(
			crlf(`Content-Type: multipart/mixed; boundary=b

--b

body
--b
Content-Type: text/plain
Content-Disposition: attachment; filename=notes.txt

notes
--b
Content-Type: image/png; name=dot.png
Content-ID: <dot@x>

iVBORw0KGgo=
--b--
`),
		);
		const content = extractContent(message);
		expect(content.text).toBe('body');
		expect(content.html).toBeUndefined();
		expect(content.attachments.map((part) => part.filename)).toEqual([
			'notes.txt',
			'dot.png',
		]);
		expect(content.attachments[1]?.contentId).toBe('dot@x');
	});
});
