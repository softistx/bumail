import { describe, expect, test } from 'bun:test';
import { charsetLabel, decodeCharset } from './charset';

describe('decodeCharset', () => {
	test('ISO-8859-1, read as windows-1252 as the Encoding Standard does', () => {
		expect(
			decodeCharset(Uint8Array.of(0x4a, 0xf8, 0x72, 0x6e), 'ISO-8859-1'),
		).toBe('Jørn');
	});

	test('US-ASCII carrying 8-bit bytes still reads', () => {
		expect(
			decodeCharset(Uint8Array.of(0x63, 0x61, 0x66, 0xe9), 'us-ascii'),
		).toBe('café');
	});

	test('an unknown charset falls back to UTF-8, then windows-1252', () => {
		expect(decodeCharset(new TextEncoder().encode('café'), 'x-unknown')).toBe(
			'café',
		);
		expect(
			decodeCharset(Uint8Array.of(0x63, 0x61, 0x66, 0xe9), 'x-unknown'),
		).toBe('café');
	});

	test('charsetLabel names what the platform can decode, or nothing', () => {
		expect(charsetLabel('UTF8')).toBe('utf-8');
		expect(charsetLabel('iso-2022-jp')).toBe('iso-2022-jp');
		expect(charsetLabel('x-unknown')).toBeUndefined();
		expect(charsetLabel('utf-7')).toBeUndefined();
	});
});
