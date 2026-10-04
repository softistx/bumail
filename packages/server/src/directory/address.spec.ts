import { describe, expect, test } from 'bun:test';
import { addressOf, domainOf } from './address';

describe('domainOf', () => {
	test.each([
		['example.com', 'example.com'],
		['Example.COM', 'example.com'],
		['example.com.', 'example.com'],
		['Bücher.Example', 'xn--bcher-kva.example'],
		['mail.sub.example.org', 'mail.sub.example.org'],
		['123.example.com', '123.example.com'],
		['0x7f.example', '0x7f.example'],
	])('%p is %p', (given, kept) => {
		expect(domainOf(given)).toBe(kept);
	});

	test.each([
		'localhost',
		'',
		'exa mple.com',
		'-example.com',
		'example..com',
		'a@example.com',
		`${'a'.repeat(64)}.com`,
		'192.0.2.1',
		'[::1]',
		'::1',
		'1.2.3.4.',
		'0x7f.1',
		'example.0x7f',
		'example.0x',
		'example.123',
		'exa%6dple.com',
		'example%2ecom',
	])('%p is not a domain name', (given) => {
		expect(domainOf(given)).toBeUndefined();
	});
});

describe('addressOf', () => {
	test('lowercases the domain and the local part', () => {
		expect(addressOf('Alice.Smith@Example.COM')).toEqual({
			address: 'alice.smith@example.com',
			local: 'alice.smith',
			domain: 'example.com',
		});
	});

	test('takes a UTF-8 local part, in NFC, lowercased', () => {
		const decomposed = 'Zélie@example.com';
		expect(addressOf(decomposed)?.address).toBe('zélie@example.com');
	});

	test.each([
		'alice',
		'@example.com',
		'alice@',
		'alice@localhost',
		'alice@192.0.2.1',
		'alice@exa%6dple.com',
		'.alice@example.com',
		'alice.@example.com',
		'al..ice@example.com',
		'"alice"@example.com',
		'al ice@example.com',
		'alice@example.com\n',
		`${'a'.repeat(65)}@example.com`,
	])('%p is not an address', (given) => {
		expect(addressOf(given)).toBeUndefined();
	});

	test('takes a local part of 64 octets, and an address of 254 at most', () => {
		expect(addressOf(`${'a'.repeat(64)}@example.com`)).toBeDefined();
		const domain = `${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(60)}.com`;
		expect(addressOf(`${'a'.repeat(61)}@${domain}`)).toBeDefined();
		expect(addressOf(`${'a'.repeat(62)}@${domain}`)).toBeUndefined();
	});
});
