import { describe, expect, test } from 'bun:test';
import {
	decodeQuotedPrintable,
	encodeQuotedPrintable,
	QuotedPrintableDecoder,
} from './quoted-printable';

const text = (data: Uint8Array) => new TextDecoder().decode(data);

describe('decodeQuotedPrintable', () => {
	test('RFC 2045 §6.7 rule 5: soft line breaks join the lines', () => {
		// The example of RFC 2045 §6.7, rule (5).
		const encoded =
			"Now's the time =\r\nfor all folk to come=\r\n to the aid of their country.";
		expect(text(decodeQuotedPrintable(encoded))).toBe(
			"Now's the time for all folk to come to the aid of their country.",
		);
	});

	test('RFC 2045 §6.7 rule 1: =XX is the byte, in either case', () => {
		expect([...decodeQuotedPrintable('=E9=e9=3D')]).toEqual([0xe9, 0xe9, 0x3d]);
	});

	test('RFC 2045 §6.7 rule 3: trailing white space is dropped', () => {
		expect(text(decodeQuotedPrintable('a  \r\nb\t'))).toBe('a\r\nb');
	});

	test('white space before a soft line break is kept', () => {
		expect(text(decodeQuotedPrintable('a =\r\nb'))).toBe('a b');
	});

	test('an = that starts no escape is kept as it is', () => {
		expect(text(decodeQuotedPrintable('1=2 and =ZZ'))).toBe('1=2 and =ZZ');
	});

	test('a bare LF is a line break', () => {
		expect(text(decodeQuotedPrintable('a=\nb\nc'))).toBe('ab\r\nc');
	});

	test('UTF-8 split across escapes', () => {
		expect(text(decodeQuotedPrintable('caf=C3=A9'))).toBe('café');
	});
});

describe('encodeQuotedPrintable', () => {
	test('ASCII text is left readable', () => {
		expect(encodeQuotedPrintable('Hello, world')).toBe('Hello, world');
	});

	test('= and non-ASCII bytes are escaped', () => {
		expect(encodeQuotedPrintable('a=b café')).toBe('a=3Db caf=C3=A9');
	});

	test('rule 3: white space at the end of a line is escaped', () => {
		expect(encodeQuotedPrintable('end \nnext\t')).toBe('end=20\r\nnext=09');
	});

	test('rule 5: no line is longer than 76 characters', () => {
		const long = 'é'.repeat(100) + 'x'.repeat(200);
		const encoded = encodeQuotedPrintable(long);
		for (const line of encoded.split('\r\n')) {
			expect(line.length).toBeLessThanOrEqual(76);
		}
		expect(text(decodeQuotedPrintable(encoded))).toBe(long);
	});

	test('a line of exactly 76 characters needs no soft break', () => {
		expect(encodeQuotedPrintable('x'.repeat(76))).toBe('x'.repeat(76));
	});

	test('round-trips every byte', () => {
		const all = new Uint8Array(256).map((_, i) => i);
		const decoded = decodeQuotedPrintable(encodeQuotedPrintable(all));
		// CR and LF are line breaks in text mode: compare the rest.
		const strip = (data: Uint8Array) =>
			[...data].filter((b) => b !== 10 && b !== 13);
		expect(strip(decoded)).toEqual(strip(all));
	});
});

describe('QuotedPrintableDecoder', () => {
	test('decodes the same in chunks of any size', () => {
		const source = `${'Ligne accentuée, =égal, fin  \n'.repeat(40)}dernière`;
		const encoded = new TextEncoder().encode(encodeQuotedPrintable(source));
		const expected = decodeQuotedPrintable(encoded);
		for (const size of [1, 2, 3, 50]) {
			const decoder = new QuotedPrintableDecoder();
			const parts: number[] = [];
			for (let i = 0; i < encoded.length; i += size) {
				parts.push(...decoder.write(encoded.subarray(i, i + size)));
			}
			parts.push(...decoder.end());
			expect([...parts]).toEqual([...expected]);
		}
	});

	test('hostile input never grows the decoder: a megabyte of spaces or of =', () => {
		for (const byte of [0x20, 0x3d]) {
			const decoder = new QuotedPrintableDecoder(1024);
			let out = 0;
			const chunk = new Uint8Array(4096).fill(byte);
			for (let i = 0; i < 256; i++) out += decoder.write(chunk).length;
			// All but the last two bytes are out: an = there may open an escape.
			expect(out).toBeGreaterThanOrEqual(256 * 4096 - 2);
		}
	});

	test('a line longer than maxLine is decoded without waiting for its end, never inside =XX', () => {
		const decoder = new QuotedPrintableDecoder(10);
		const encoded = new TextEncoder().encode('=C3=A9'.repeat(20));
		const parts: number[] = [];
		for (let i = 0; i < encoded.length; i += 7) {
			const out = decoder.write(encoded.subarray(i, i + 7));
			parts.push(...out);
		}
		expect(parts.length).toBeGreaterThan(0);
		parts.push(...decoder.end());
		expect(text(Uint8Array.from(parts))).toBe('é'.repeat(20));
	});
});
