import { describe, expect, test } from 'bun:test';
import { Base64Decoder, decodeBase64, encodeBase64 } from './base64';

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);

// RFC 4648 §10, the test vectors.
const VECTORS: [string, string][] = [
	['', ''],
	['f', 'Zg=='],
	['fo', 'Zm8='],
	['foo', 'Zm9v'],
	['foob', 'Zm9vYg=='],
	['fooba', 'Zm9vYmE='],
	['foobar', 'Zm9vYmFy'],
];

describe('encodeBase64', () => {
	test.each(VECTORS)('RFC 4648 §10: "%s"', (input, output) => {
		expect(encodeBase64(bytes(input))).toBe(output);
	});

	test('RFC 2045 §6.8: lines of at most 76 characters, joined by CRLF', () => {
		const encoded = encodeBase64(new Uint8Array(200).fill(0xff));
		const lines = encoded.split('\r\n');
		expect(lines.slice(0, -1).every((line) => line.length === 76)).toBe(true);
		expect(decodeBase64(encoded)).toEqual(new Uint8Array(200).fill(0xff));
	});

	test('a line length of 0 writes one line', () => {
		expect(encodeBase64(new Uint8Array(100), 0)).not.toContain('\r\n');
	});
});

describe('decodeBase64', () => {
	test.each(VECTORS)('RFC 4648 §10: "%s"', (output, input) => {
		expect(text(decodeBase64(input))).toBe(output);
	});

	test('RFC 2045 §6.8: characters outside the alphabet are ignored', () => {
		expect(text(decodeBase64('Zm9v\r\nYm Fy\t!'))).toBe('foobar');
	});

	test('missing padding still decodes', () => {
		expect(text(decodeBase64('Zm9vYg'))).toBe('foob');
	});

	test('a final group too short for a byte is dropped', () => {
		expect(text(decodeBase64('Zm9vY'))).toBe('foo');
	});
});

describe('Base64Decoder', () => {
	test('decodes the same in chunks of any size', () => {
		const source = new Uint8Array(1000).map((_, i) => (i * 7) % 256);
		const encoded = bytes(encodeBase64(source));
		for (const size of [1, 3, 5, 77, 4096]) {
			const decoder = new Base64Decoder();
			const parts: number[] = [];
			for (let i = 0; i < encoded.length; i += size) {
				parts.push(...decoder.write(encoded.subarray(i, i + size)));
			}
			parts.push(...decoder.end());
			expect(Uint8Array.from(parts)).toEqual(source);
		}
	});
});
