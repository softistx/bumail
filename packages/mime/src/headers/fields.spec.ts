import { describe, expect, test } from 'bun:test';
import { parseHeaderBlock } from './fields';

describe('parseHeaderBlock', () => {
	test('RFC 5322 §2.2.3: a folded field is unfolded', () => {
		// The example of RFC 5322 §2.2.3.
		const headers = parseHeaderBlock(
			'Subject: This\r\n is a test\r\nX-Other: 1\r\n',
		);
		expect(headers.get('subject')).toBe('This is a test');
		expect(headers.get('x-other')).toBe('1');
	});

	test('names match case-insensitively, and repeated fields keep their order', () => {
		const headers = parseHeaderBlock(
			'Received: one\r\nRECEIVED: two\r\nreceived: three\r\n',
		);
		expect(headers.getAll('Received')).toEqual(['one', 'two', 'three']);
		expect(headers.size).toBe(3);
		expect([...headers].map((field) => field.name)).toEqual([
			'Received',
			'RECEIVED',
			'received',
		]);
	});

	test('RFC 5322 §4.5: white space before the colon is allowed', () => {
		expect(parseHeaderBlock('Subject : old style\n').get('subject')).toBe(
			'old style',
		);
	});

	test('a value starting on the next line', () => {
		expect(parseHeaderBlock('Subject:\r\n  late\r\n').get('subject')).toBe(
			'late',
		);
	});

	test('bare LF, and a line without a colon is skipped', () => {
		const headers = parseHeaderBlock('A: 1\nnot a field\nB: 2\n');
		expect(headers.get('a')).toBe('1');
		expect(headers.get('b')).toBe('2');
		expect(headers.size).toBe(2);
	});

	test('RFC 6532: UTF-8 in a header, and windows-1252 when it is not UTF-8', () => {
		const utf8 = new TextEncoder().encode('Subject: Grüße\r\n');
		expect(parseHeaderBlock(utf8).get('subject')).toBe('Grüße');
		const latin = Uint8Array.from(
			[...'Subject: caf'].map((c) => c.charCodeAt(0)).concat(0xe9),
		);
		expect(parseHeaderBlock(latin).get('subject')).toBe('café');
	});

	test('one Latin-1 field does not garble the UTF-8 of the others', () => {
		const block = Uint8Array.from([
			...new TextEncoder().encode('Subject: café\r\nX-Old: caf'),
			0xe9,
			0x0d,
			0x0a,
		]);
		const headers = parseHeaderBlock(block);
		expect(headers.get('subject')).toBe('café');
		expect(headers.get('x-old')).toBe('café');
	});

	test('text() decodes the encoded-words', () => {
		const headers = parseHeaderBlock(
			'Subject: =?UTF-8?Q?Gr=C3=BC=C3=9Fe?= aus Berlin\r\n',
		);
		expect(headers.text('subject')).toBe('Grüße aus Berlin');
		expect(headers.text('missing')).toBeUndefined();
	});
});
