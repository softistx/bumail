import { describe, expect, test } from 'bun:test';
import { createTransferDecoder, decodeTransfer } from './transfer';

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);

describe('createTransferDecoder', () => {
	test('base64 and quoted-printable, in any case and with spaces', () => {
		expect(text(decodeTransfer(bytes('Zm9v'), ' BASE64 '))).toBe('foo');
		expect(text(decodeTransfer(bytes('caf=C3=A9'), 'Quoted-Printable'))).toBe(
			'café',
		);
	});

	test('7bit, 8bit, binary, none and unknown pass through (RFC 2045 §6.4)', () => {
		for (const encoding of [
			'7bit',
			'8bit',
			'binary',
			undefined,
			'x-uuencode',
		]) {
			const decoder = createTransferDecoder(encoding);
			expect(text(decoder.write(bytes('=C3 as is')))).toBe('=C3 as is');
			expect(decoder.end()).toHaveLength(0);
		}
	});
});
