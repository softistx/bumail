import { describe, expect, test } from 'bun:test';
import { parseHeaderBlock } from '@bumail/mime';
import { Response } from '../protocol/response';
import { bodyStructure } from './bodystructure';
import { envelope } from './envelope';
import { StructureScanner } from './structure';

const wire = (out: Response) =>
	out
		.done()
		.map((piece) =>
			typeof piece === 'string'
				? piece
				: new TextDecoder().decode(piece as Uint8Array),
		)
		.join('')
		.slice(0, -2);

function structureOf(message: string, extended = true): string {
	const scanner = new StructureScanner();
	scanner.write(new TextEncoder().encode(message));
	const out = new Response();
	bodyStructure(out, scanner.end(), extended);
	return wire(out);
}

describe('ENVELOPE (RFC 9051 §7.5.2)', () => {
	test("the RFC's FETCH example (§6.4.5): sender and reply-to default to from", () => {
		const headers = parseHeaderBlock(
			[
				'Date: Wed, 17 Jul 1996 02:23:25 -0700 (PDT)',
				'From: Terry Gray <gray@cac.washington.edu>',
				'Subject: IMAP4rev2 WG mtg summary and minutes',
				'To: imap@cac.washington.edu',
				'Cc: minutes@CNRI.Reston.VA.US, John Klensin <KLENSIN@MIT.EDU>',
				'Message-Id: <B27397-0100000@cac.washington.edu>',
				'',
			].join('\r\n'),
		);
		const out = new Response();
		envelope(out, headers);
		expect(wire(out)).toBe(
			'("Wed, 17 Jul 1996 02:23:25 -0700 (PDT)" "IMAP4rev2 WG mtg summary and minutes" ' +
				'(("Terry Gray" NIL "gray" "cac.washington.edu")) ' +
				'(("Terry Gray" NIL "gray" "cac.washington.edu")) ' +
				'(("Terry Gray" NIL "gray" "cac.washington.edu")) ' +
				'((NIL NIL "imap" "cac.washington.edu")) ' +
				'((NIL NIL "minutes" "CNRI.Reston.VA.US")("John Klensin" NIL "KLENSIN" "MIT.EDU")) ' +
				'NIL NIL "<B27397-0100000@cac.washington.edu>")',
		);
	});

	test('a group opens and closes with markers; a name that is not ASCII goes as encoded-words', () => {
		const headers = parseHeaderBlock(
			'From: =?utf-8?q?Ren=C3=A9?= <r@x.example>\r\nTo: Team: a@x.example;\r\n',
		);
		const out = new Response();
		envelope(out, headers);
		expect(wire(out)).toBe(
			'(NIL NIL (("=?UTF-8?B?UmVuw6k=?=" NIL "r" "x.example")) (("=?UTF-8?B?UmVuw6k=?=" NIL "r" "x.example")) ' +
				'(("=?UTF-8?B?UmVuw6k=?=" NIL "r" "x.example")) ((NIL NIL "Team" NIL)(NIL NIL "a" "x.example")(NIL NIL NIL NIL)) NIL NIL NIL NIL)',
		);
	});

	test('a subject holding a line break or 8-bit text goes as a literal', () => {
		const headers = parseHeaderBlock('Subject: café\r\n');
		const out = new Response();
		envelope(out, headers);
		expect(wire(out)).toStartWith('(NIL {5}\r\ncafé NIL');
	});
});

describe('BODYSTRUCTURE (RFC 9051 §7.5.2)', () => {
	test('a text part: type, parameters, encoding, size, lines', () => {
		expect(
			structureOf(
				'Content-Type: TEXT/PLAIN; CHARSET=US-ASCII\r\n\r\nhello\r\nworld\r\n',
				false,
			),
		).toBe('("text" "plain" ("charset" "US-ASCII") NIL NIL "7BIT" 14 2)');
	});

	test('a multipart with an attachment, its extension data', () => {
		const message = [
			'Content-Type: multipart/mixed; boundary=b',
			'',
			'--b',
			'Content-Type: text/plain',
			'Content-Language: en, fr',
			'',
			'hi',
			'--b',
			'Content-Type: application/pdf; name="r.pdf"',
			'Content-Disposition: attachment; filename="r.pdf"',
			'Content-Transfer-Encoding: base64',
			'Content-ID: <part2@x>',
			'',
			'JVBERi0=',
			'--b--',
		].join('\r\n');
		expect(structureOf(message)).toBe(
			'(("text" "plain" ("charset" "us-ascii") NIL NIL "7BIT" 2 1 NIL NIL ("en" "fr") NIL)' +
				'("application" "pdf" ("name" "r.pdf") "<part2@x>" NIL "BASE64" 8 NIL ("attachment" ("filename" "r.pdf")) NIL NIL)' +
				' "mixed" ("boundary" "b") NIL NIL NIL)',
		);
	});

	test('a message/rfc822 part: its envelope, its structure, its lines', () => {
		const message = [
			'Content-Type: multipart/mixed; boundary=b',
			'',
			'--b',
			'Content-Type: message/rfc822',
			'',
			'Subject: inner',
			'',
			'body',
			'--b--',
		].join('\r\n');
		expect(structureOf(message, false)).toBe(
			'(("message" "rfc822" NIL NIL NIL "7BIT" 22 ' +
				'(NIL "inner" NIL NIL NIL NIL NIL NIL NIL NIL) ("text" "plain" ("charset" "us-ascii") NIL NIL "7BIT" 4 1) 3) "mixed")',
		);
	});

	test('a parameter that is not ASCII goes as RFC 2231 name*', () => {
		expect(
			structureOf(
				"Content-Type: application/pdf; name*=utf-8''r%C3%A9.pdf\r\n\r\nx",
				false,
			),
		).toBe(
			`("application" "pdf" ("name*" "utf-8''r%C3%A9.pdf") NIL NIL "7BIT" 1)`,
		);
	});

	test('a multipart whose boundary never comes still has one part', () => {
		expect(
			structureOf(
				'Content-Type: multipart/mixed; boundary=b\r\n\r\nno parts',
				false,
			),
		).toBe(
			'(("text" "plain" ("charset" "us-ascii") NIL NIL "7BIT" 0 0) "mixed")',
		);
	});
});
