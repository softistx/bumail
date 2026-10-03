import { describe, expect, test } from 'bun:test';
import { DnsError } from './errors';
import { fixtureResolver } from './fixture';
import { isNullMx } from './mx';

async function code(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof DnsError) return error.code;
		throw error;
	}
	return 'answered';
}

describe('fixtureResolver', () => {
	const dns = fixtureResolver({
		'Example.com.': {
			mx: [
				{ exchange: 'b.mx.example.com', priority: 20 },
				{ exchange: 'A.mx.example.com.', priority: 10, ttl: 60 },
			],
			txt: ['v=spf1 -all', ['v=DMARC1; ', 'p=reject'], { text: 'x', ttl: 5 }],
			a: ['192.0.2.1', { address: '192.0.2.2', ttl: 9 }],
		},
		'nomail.example': { mx: [{ exchange: '.', priority: 0 }] },
		'down.example': { error: 'TEMPORARY' },
		'slow.example': { txt: 'TIMEOUT' },
		'192.0.2.1': { ptr: ['Mail.Example.com.'] },
	});

	test('answers from the object, names normalised, MX sorted, TTL 300 when left out', async () => {
		expect(await dns.mx('EXAMPLE.com')).toEqual([
			{ exchange: 'a.mx.example.com', priority: 10, ttl: 60 },
			{ exchange: 'b.mx.example.com', priority: 20, ttl: 300 },
		]);
		expect(await dns.txt('example.com')).toEqual([
			{ text: 'v=spf1 -all', ttl: 300 },
			{ text: 'v=DMARC1; p=reject', ttl: 300 },
			{ text: 'x', ttl: 5 },
		]);
		expect(await dns.a('example.com')).toEqual([
			{ address: '192.0.2.1', ttl: 300 },
			{ address: '192.0.2.2', ttl: 9 },
		]);
		expect(await dns.ptr('192.0.2.1')).toEqual([
			{ name: 'mail.example.com', ttl: 300 },
		]);
	});

	test('a null MX is one record with an empty exchange', async () => {
		expect(isNullMx(await dns.mx('nomail.example'))).toBe(true);
		expect(isNullMx(await dns.mx('example.com'))).toBe(false);
	});

	test('a name or a type it does not hold is NOT_FOUND', async () => {
		expect(await code(dns.mx('unknown.example'))).toBe('NOT_FOUND');
		expect(await code(dns.aaaa('example.com'))).toBe('NOT_FOUND');
	});

	test('answers with an error for a whole name or for one type', async () => {
		expect(await code(dns.mx('down.example'))).toBe('TEMPORARY');
		expect(await code(dns.a('down.example'))).toBe('TEMPORARY');
		expect(await code(dns.txt('slow.example'))).toBe('TIMEOUT');
		expect(await code(dns.mx('slow.example'))).toBe('NOT_FOUND');
	});

	test('refuses a malformed name as every resolver does', async () => {
		expect(await code(dns.txt('a..b'))).toBe('INVALID_NAME');
	});

	test('records every query, so a spec can count lookups', async () => {
		const counted = fixtureResolver({
			'example.com': { txt: ['v=spf1 -all'] },
		});
		await counted.txt('Example.com');
		await code(counted.mx('example.com'));
		expect(counted.queries).toEqual([
			{ type: 'txt', name: 'example.com' },
			{ type: 'mx', name: 'example.com' },
		]);
	});
});
