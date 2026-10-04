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
});
