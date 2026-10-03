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
