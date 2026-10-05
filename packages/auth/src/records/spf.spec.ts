import { describe, expect, test } from 'bun:test';
import { fixtureResolver } from '@bumail/dns';
import { checkSpf } from '../spf/check-spf';
import { parseRecord } from '../spf/record';
import { spfRecord } from './spf';

const RESOLVER = (text: string) =>
	fixtureResolver({
		'example.com': {
			txt: [text],
			mx: [{ exchange: 'mail.example.com', priority: 10 }],
		},
		'mail.example.com': { a: ['192.0.2.25'] },
		'_spf.relay.example': { txt: ['v=spf1 ip4:198.51.100.0/24 -all'] },
	});

async function verdict(text: string, ip: string): Promise<string> {
	const { result } = await checkSpf(
		{ ip, mailFrom: 'alice@example.com', helo: 'mail.example.com' },
		{ resolver: RESOLVER(text) },
	);
	return result;
}

describe('spfRecord writes what checkSpf reads', () => {
	test('the default is mx and -all', async () => {
		const text = spfRecord({ mx: true });
		expect(text).toBe('v=spf1 mx -all');
		expect(await verdict(text, '192.0.2.25')).toBe('pass');
		expect(await verdict(text, '203.0.113.9')).toBe('fail');
	});

	test('every mechanism, in order, parses back', async () => {
		const text = spfRecord({
			a: true,
			mx: true,
			include: ['_spf.relay.example'],
			ip4: ['203.0.113.7', '192.0.2.0/24'],
			ip6: ['2001:db8::/32'],
			all: '~all',
		});
		expect(text).toBe(
			'v=spf1 a mx include:_spf.relay.example ip4:203.0.113.7 ip4:192.0.2.0/24 ip6:2001:db8::/32 ~all',
		);
		const parsed = parseRecord(text);
		expect(typeof parsed).not.toBe('string');
		expect(
			typeof parsed === 'string' ? [] : parsed.mechanisms.map((m) => m.kind),
		).toEqual(['a', 'mx', 'include', 'ip4', 'ip4', 'ip6', 'all']);
		expect(await verdict(text, '198.51.100.20')).toBe('pass');
		expect(await verdict(text, '203.0.113.7')).toBe('pass');
		expect(await verdict(text, '203.0.113.8')).toBe('softfail');
	});

	test('a record with no mechanism is only its all', () => {
		expect(spfRecord({})).toBe('v=spf1 -all');
		expect(spfRecord({ all: '?all' })).toBe('v=spf1 ?all');
	});
});

describe('spfRecord refuses', () => {
	test.each([
		[{ ip4: ['192.0.2.300'] }, 'ip4 "192.0.2.300"'],
		[{ ip4: ['192.0.2.0/33'] }, 'ip4 "192.0.2.0/33"'],
		[{ ip4: ['2001:db8::1'] }, 'ip4 "2001:db8::1"'],
		[{ ip6: ['192.0.2.1'] }, 'ip6 "192.0.2.1"'],
		[{ ip6: ['2001:db8::/129'] }, 'ip6 "2001:db8::/129"'],
		[{ include: ['not a domain'] }, 'include "not a domain"'],
		[{ include: ['a.example', 7 as never] }, 'include must be an array'],
		[{ all: 'all' as never }, 'all must be one of'],
		[
			{
				mx: true,
				include: Array.from({ length: 10 }, (_, i) => `i${i}.example`),
			},
			'11 DNS lookups',
		],
	])('%j', (options, message) => {
		expect(() => spfRecord(options)).toThrow(message);
		try {
			spfRecord(options);
		} catch (error) {
			expect(error).toMatchObject({
				name: 'AuthError',
				code: 'INVALID_OPTION',
			});
		}
	});

	test('anything that is not an object', () => {
		expect(() => spfRecord(null as never)).toThrow('options must be an object');
	});
});
