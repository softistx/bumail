import { describe, expect, test } from 'bun:test';
import { jsonSize } from './size';

describe('jsonSize', () => {
	test('is the length of the JSON, in UTF-8', () => {
		for (const value of [
			null,
			true,
			false,
			-12.5,
			'',
			'é😀',
			[],
			[1, 'a', null],
			{},
			{ a: 1, b: [true, { c: 'd' }], u: undefined },
			'"\\\b\f\n\r\t',
			'\u0000\u0001\u001f\u007f\u2028',
			{ 'k"\n\u0002': 'v\\' },
			'\ud800',
			'a\udc00b',
			'\ud83d\ude00\ud83d',
			'\udc00\ud800',
			['\ud800\ud800', '😀\udfff'],
		]) {
			expect(jsonSize(value, 1000)).toBe(
				Buffer.byteLength(JSON.stringify(value)),
			);
		}
	});

	test('stops past max', () => {
		const huge = Array.from({ length: 100_000 }, () => 'x'.repeat(100));
		expect(jsonSize(huge, 1000)).toBe(1001);
	});
});
