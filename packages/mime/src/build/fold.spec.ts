import { describe, expect, test } from 'bun:test';
import { MimeError } from '../errors';
import { foldHeader } from './fold';

describe('foldHeader', () => {
	test('folds at white space within 78 characters, and leaves a short one alone', () => {
		expect(foldHeader('Subject', 'short')).toBe('Subject: short');
		const folded = foldHeader(
			'Subject',
			Array.from({ length: 20 }, () => 'word').join(' '),
		);
		expect(folded.split('\r\n').every((line) => line.length <= 78)).toBe(true);
		expect(folded.replace(/\r\n/g, '')).toBe(
			`Subject: ${Array.from({ length: 20 }, () => 'word').join(' ')}`,
		);
	});

	test('refuses a name that is not one, with INVALID_OPTION', () => {
		try {
			foldHeader('Bad Name', 'x');
			throw new Error('did not throw');
		} catch (error) {
			expect(error).toBeInstanceOf(MimeError);
			expect((error as MimeError).code).toBe('INVALID_OPTION');
			expect((error as MimeError).message).toBe(
				'"Bad Name" is not a header field name',
			);
		}
		expect(() => foldHeader('X:Y', 'x')).toThrow('is not a header field name');
	});

	test('refuses a line break in the value', () => {
		expect(() => foldHeader('X-Test', 'a\nb')).toThrow(
			'The value of X-Test holds a line break',
		);
	});
});
