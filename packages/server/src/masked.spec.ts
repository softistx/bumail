import { describe, expect, test } from 'bun:test';
import { masked } from './masked';

describe('masked', () => {
	test('masks the password as written and as decoded', () => {
		expect(masked('auth failed for p%40ss and p@ss', 'p%40ss')).toBe(
			'auth failed for … and …',
		);
	});

	test('a password that is not percent-encoding is masked as written', () => {
		expect(masked('bad p%zz here', 'p%zz')).toBe('bad … here');
	});

	test('no password leaves the text alone', () => {
		expect(masked('Connection refused', '')).toBe('Connection refused');
	});

	test('a password under 4 characters is masked in a URL, and nowhere else', () => {
		expect(masked('cannot execute: postgres://u:x@h/db', 'x')).toBe(
			'cannot execute: postgres://u:…@h/db',
		);
		expect(masked('redis://:abc@h and abc', 'abc')).toBe(
			'redis://:…@h and abc',
		);
	});

	test('a short password is masked in a URL as written and as decoded', () => {
		expect(masked('u:a%40@h, then u:a@@h', 'a%40')).toBe('u:…@h, then u:…@h');
		expect(masked('u:%41@h, then u:A@h, A and %41', '%41')).toBe(
			'u:…@h, then u:…@h, A and %41',
		);
	});

	test('from 4 characters, the password alone is masked too', () => {
		expect(masked('role "abcd" failed: u:abcd@h', 'abcd')).toBe(
			'role "…" failed: u:…@h',
		);
	});

	test('the length is counted in characters, not code units', () => {
		expect(masked('a 😀😀😀 here', '😀😀😀')).toBe('a 😀😀😀 here');
		expect(masked('a 😀😀😀😀 here', '😀😀😀😀')).toBe('a … here');
	});
});
