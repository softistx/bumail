import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Resolver as NodeDnsResolver } from 'node:dns/promises';
import { DnsError, isTemporary } from '../errors';
import type { DnsBackend } from './backend';
import { nodeResolver } from './resolver';

// The network is injected: every resolver here gets a fake backend. Should
// any spec reach `node:dns` itself, these stubs record it and the last spec
// fails.
const METHODS = [
	'resolve4',
	'resolve6',
	'resolveMx',
	'resolveTxt',
	'reverse',
] as const;
const reached: string[] = [];
const originals = new Map<string, unknown>();
const prototype = NodeDnsResolver.prototype as unknown as Record<
	string,
	unknown
>;

beforeAll(() => {
	for (const method of METHODS) {
		originals.set(method, prototype[method]);
		prototype[method] = (name: string) => {
			reached.push(`${method} ${name}`);
			return Promise.reject(new Error('a spec reached the network'));
		};
	}
});

afterAll(() => {
	for (const method of METHODS) prototype[method] = originals.get(method);
});

/** A backend that answers what it is given, and throws a `node:dns`-style error for a code. */
function backend(
	answers: Partial<Record<keyof DnsBackend, unknown>>,
): DnsBackend {
	const call = (method: keyof DnsBackend) => async () => {
		const answer = answers[method];
		if (typeof answer === 'string') {
			throw Object.assign(new Error(`query ${answer}`), { code: answer });
		}
		if (answer === undefined)
			throw Object.assign(new Error('nothing'), { code: 'ENOTFOUND' });
		return answer;
	};
	return {
		resolve4: call('resolve4'),
		resolve6: call('resolve6'),
		resolveMx: call('resolveMx'),
		resolveTxt: call('resolveTxt'),
		reverse: call('reverse'),
	} as unknown as DnsBackend;
}

async function failure(promise: Promise<unknown>): Promise<DnsError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof DnsError) return error;
		throw error;
	}
	throw new Error('expected a DnsError');
}

describe('nodeResolver', () => {
	test('sorts MX by priority, lowercases the exchange and gives the assumed TTL', async () => {
		const dns = nodeResolver({
			assumedTtl: 600,
			backend: backend({
				resolveMx: [
					{ exchange: 'ALT1.mx.example.', priority: 20 },
					{ exchange: 'mx.example', priority: 10 },
				],
			}),
		});
		expect(await dns.mx('Example.COM')).toEqual([
			{ exchange: 'mx.example', priority: 10, ttl: 600 },
			{ exchange: 'alt1.mx.example', priority: 20, ttl: 600 },
		]);
	});

	test('reads a null MX (RFC 7505) as an empty exchange', async () => {
		const dns = nodeResolver({
			backend: backend({ resolveMx: [{ exchange: '', priority: 0 }] }),
		});
		expect(await dns.mx('example.com')).toEqual([
			{ exchange: '', priority: 0, ttl: 300 },
		]);
	});

	test('joins the character-strings of each TXT record (RFC 7208 §3.3)', async () => {
		const dns = nodeResolver({
			backend: backend({
				resolveTxt: [
					['v=spf1 ip4:192.0.2.0/24 ', 'include:_spf.example.net -all'],
					['other'],
				],
			}),
		});
		expect(await dns.txt('example.com')).toEqual([
			{
				text: 'v=spf1 ip4:192.0.2.0/24 include:_spf.example.net -all',
				ttl: 300,
			},
			{ text: 'other', ttl: 300 },
		]);
	});

	test('gives A and AAAA the TTL the DNS gave', async () => {
		const dns = nodeResolver({
			backend: backend({
				resolve4: [{ address: '192.0.2.1', ttl: 42 }],
				resolve6: [{ address: '2001:db8::1', ttl: 7 }],
			}),
		});
		expect(await dns.a('example.com')).toEqual([
			{ address: '192.0.2.1', ttl: 42 },
		]);
		expect(await dns.aaaa('example.com')).toEqual([
			{ address: '2001:db8::1', ttl: 7 },
		]);
	});

	test('looks an address up by PTR', async () => {
		const dns = nodeResolver({
			backend: backend({ reverse: ['Mail.Example.COM.'] }),
		});
		expect(await dns.ptr('192.0.2.1')).toEqual([
			{ name: 'mail.example.com', ttl: 300 },
		]);
	});

	test('maps node:dns errors onto the codes that matter', async () => {
		const cases = [
			['ENOTFOUND', 'NOT_FOUND'],
			['ENODATA', 'NOT_FOUND'],
			['ETIMEOUT', 'TIMEOUT'],
			['ESERVFAIL', 'TEMPORARY'],
			['ECONNREFUSED', 'TEMPORARY'],
			['EREFUSED', 'TEMPORARY'],
			['EBADRESP', 'TEMPORARY'],
			['EBADNAME', 'INVALID_NAME'],
		] as const;
		for (const [nodeCode, code] of cases) {
			const dns = nodeResolver({ backend: backend({ resolveTxt: nodeCode }) });
			const error = await failure(dns.txt('example.com'));
			expect(error.code).toBe(code);
			expect(isTemporary(error)).toBe(
				code === 'TIMEOUT' || code === 'TEMPORARY',
			);
		}
	});

	test('says which query failed, and why', async () => {
		const dns = nodeResolver({ backend: backend({ resolveMx: 'ESERVFAIL' }) });
		expect((await failure(dns.mx('example.com'))).message).toBe(
			'The DNS could not answer MX example.com (ESERVFAIL)',
		);
		const none = nodeResolver({ backend: backend({}) });
		expect((await failure(none.txt('_dmarc.example.com'))).message).toBe(
			'No TXT _dmarc.example.com record (ENOTFOUND)',
		);
	});

	test('reads an empty answer as NOT_FOUND, never as an empty array', async () => {
		const dns = nodeResolver({ backend: backend({ resolve4: [] }) });
		expect((await failure(dns.a('example.com'))).code).toBe('NOT_FOUND');
	});

	test('refuses a malformed name without querying', async () => {
		const asked: string[] = [];
		const dns = nodeResolver({
			backend: {
				...backend({}),
				resolveMx: async (name: string) => {
					asked.push(name);
					return [];
				},
			},
		});
		expect((await failure(dns.mx('a..b'))).code).toBe('INVALID_NAME');
		expect((await failure(dns.ptr('not-an-ip'))).code).toBe('INVALID_NAME');
		expect(asked).toEqual([]);
	});

	test('refuses an assumedTtl that is not a whole number of seconds', () => {
		expect(() => nodeResolver({ assumedTtl: -1 })).toThrow(
			'nodeResolver(): assumedTtl must be an integer of at least 0, not -1',
		);
	});

	test('a resolver with no backend is on node:dns, and no spec reached it', () => {
		expect(() =>
			nodeResolver({ servers: ['192.0.2.53'], timeout: 100, tries: 1 }),
		).not.toThrow();
		expect(reached).toEqual([]);
	});
});
