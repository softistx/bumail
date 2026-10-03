import { describe, expect, test } from 'bun:test';
import { isMailbox } from './address';
import { settingsOf } from './settings';

const takes = (address: string) => {
	try {
		settingsOf({ from: '', to: address, host: 'mx.test', helo: 'a.test' });
		return true;
	} catch {
		return false;
	}
};

describe('isMailbox', () => {
	test.each([
		'mary@example.net',
		'first.last+tag@sub.example.org',
		'"a b"@example.com',
		'user@[192.0.2.1]',
		'jöel@exämple.com',
	])('takes %p, as sendMail does', (address) => {
		expect(isMailbox(address)).toBe(true);
		expect(takes(address)).toBe(true);
	});

	test.each([
		'a(b)@c.com',
		'a,b@c.com',
		'"x@c.com',
		'a@b@c.com',
		'a@c.com,',
		'a@-c',
		'a..b@c.com',
		'<a@c.com>',
		'a@c.com\r\nRCPT TO:<b@c.com>',
		'a@c.com​',
		'@relay.example:a@c.com',
		'a@',
		'@c.com',
		'',
		`${'a'.repeat(65)}@c.com`,
	])('refuses %p, as sendMail does', (address) => {
		expect(isMailbox(address)).toBe(false);
	});

	test('refuses what is not a string', () => {
		for (const value of [undefined, null, 42, ['a@c.com'], {}]) {
			expect(isMailbox(value)).toBe(false);
		}
	});

	test('what the review found sendMail refuses, it refuses too', () => {
		for (const address of [
			'a(b)@c.com',
			'a,b@c.com',
			'"x@c.com',
			'a@b@c.com',
			'a@c.com,',
			'a@-c',
		]) {
			expect(takes(address)).toBe(false);
		}
	});
});
