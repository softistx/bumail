import { describe, expect, test } from 'bun:test';
import { cleanText, isStorable } from './text';

describe('cleanText', () => {
	test('never cuts inside a surrogate pair', () => {
		const text = `${'a'.repeat(508)}😀${'b'.repeat(20)}`;
		const clean = cleanText(text, 512);
		expect(clean).toBe(`${'a'.repeat(508)}...`);
		expect(isStorable(clean)).toBe(true);
		expect(cleanText(`${'a'.repeat(507)}😀${'b'.repeat(20)}`, 512)).toBe(
			`${'a'.repeat(507)}😀...`,
		);
	});

	test('a lone surrogate becomes U+FFFD; a NUL a space', () => {
		expect(cleanText('a\ud83db\u0000c', 64)).toBe('a�b c');
	});
});

describe('isStorable', () => {
	test('refuses a NUL and a lone surrogate, takes a pair', () => {
		expect(isStorable('ok 😀')).toBe(true);
		expect(isStorable('a\u0000')).toBe(false);
		expect(isStorable('a\ud83d')).toBe(false);
		expect(isStorable('\udc00a')).toBe(false);
	});
});
