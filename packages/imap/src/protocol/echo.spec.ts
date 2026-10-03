import { describe, expect, test } from 'bun:test';
import { echo, plain } from './echo';

describe('client text in a response', () => {
	test('control characters are dropped, CRLF first', () => {
		expect(plain('&x\r\n* 1 EXPUNGE')).toBe('&x* 1 EXPUNGE');
		expect(echo('a\0b\tc\x7fd')).toBe('abcd');
	});

	test('past 100 characters, the rest is cut', () => {
		expect(echo('x'.repeat(100))).toBe('x'.repeat(100));
		expect(echo('x'.repeat(60_000))).toBe(`${'x'.repeat(100)}...`);
	});

	test('a cut never splits a surrogate pair', () => {
		expect(echo(`${'x'.repeat(99)}😀😀`)).toBe(`${'x'.repeat(99)}...`);
	});
});
