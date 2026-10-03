import { describe, expect, test } from 'bun:test';
import { DnsError } from '../errors';
import { fixtureResolver } from '../fixture';
import type { Resolver } from '../types';
import { cachedResolver } from './resolver';

function clock() {
	let ms = 1_000_000;
	return {
		now: () => ms,
		advance: (seconds: number) => (ms += seconds * 1000),
	};
}

async function code(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof DnsError) return error.code;
		throw error;
	}
	return 'answered';
}

describe('cachedResolver', () => {
	test('keeps an answer for its lowest TTL, counting it down', async () => {
		const inner = fixtureResolver({
			'example.com': {
				a: [
					{ address: '192.0.2.1', ttl: 60 },
					{ address: '192.0.2.2', ttl: 30 },
				],
			},
		});
		const time = clock();
		const dns = cachedResolver(inner, { now: time.now });
		await dns.a('example.com');
		time.advance(10);
		expect(await dns.a('EXAMPLE.com.')).toEqual([
			{ address: '192.0.2.1', ttl: 20 },
			{ address: '192.0.2.2', ttl: 20 },
		]);
		expect(inner.queries).toHaveLength(1);
		time.advance(20);
		await dns.a('example.com');
		expect(inner.queries).toHaveLength(2);
	});

	test('caps a TTL at maxTtl, and keeps nothing with a TTL of 0', async () => {
		const inner = fixtureResolver({
			'long.example': { txt: [{ text: 'x', ttl: 999_999 }] },
			'zero.example': { txt: [{ text: 'y', ttl: 0 }] },
		});
		const time = clock();
		const dns = cachedResolver(inner, { now: time.now, maxTtl: 100 });
		await dns.txt('long.example');
		time.advance(100);
		await dns.txt('long.example');
		await dns.txt('zero.example');
		await dns.txt('zero.example');
		expect(inner.queries.map((query) => query.name)).toEqual([
			'long.example',
			'long.example',
			'zero.example',
			'zero.example',
		]);
	});

	test('keeps NOT_FOUND for negativeTtl (RFC 2308)', async () => {
		const inner = fixtureResolver({});
		const time = clock();
		const dns = cachedResolver(inner, { now: time.now, negativeTtl: 60 });
		expect(await code(dns.txt('_dmarc.example.com'))).toBe('NOT_FOUND');
		expect(await code(dns.txt('_dmarc.example.com'))).toBe('NOT_FOUND');
		expect(inner.queries).toHaveLength(1);
		time.advance(60);
		expect(await code(dns.txt('_dmarc.example.com'))).toBe('NOT_FOUND');
		expect(inner.queries).toHaveLength(2);
	});

	test('never keeps TEMPORARY or TIMEOUT: the next query asks again', async () => {
		const inner = fixtureResolver({
			'down.example': { error: 'TEMPORARY' },
			'slow.example': { mx: 'TIMEOUT' },
		});
		const dns = cachedResolver(inner);
		expect(await code(dns.mx('down.example'))).toBe('TEMPORARY');
		expect(await code(dns.mx('down.example'))).toBe('TEMPORARY');
		expect(await code(dns.mx('slow.example'))).toBe('TIMEOUT');
		expect(await code(dns.mx('slow.example'))).toBe('TIMEOUT');
		expect(inner.queries).toHaveLength(4);
	});

	test('keeps each record type apart', async () => {
		const inner = fixtureResolver({
			'example.com': { a: ['192.0.2.1'], txt: ['t'] },
		});
		const dns = cachedResolver(inner);
		await dns.a('example.com');
		await dns.txt('example.com');
		expect(inner.queries).toHaveLength(2);
	});

	test('shares one query between identical queries made at once', async () => {
		let asked = 0;
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const inner = {
			...fixtureResolver({}),
			async mx() {
				asked++;
				await gate;
				return [{ exchange: 'mx.example.com', priority: 10, ttl: 60 }];
			},
		} as Resolver;
		const dns = cachedResolver(inner);
		const both = Promise.all([dns.mx('example.com'), dns.mx('Example.com.')]);
		release();
		const [first, second] = await both;
		expect(asked).toBe(1);
		expect(first).toEqual(second);
		expect(first).not.toBe(second);
	});

	test('shares a failing query too: NOT_FOUND is kept, TEMPORARY is not', async () => {
		for (const [failure, askedAfter] of [
			['NOT_FOUND', 1],
			['TEMPORARY', 2],
		] as const) {
			let asked = 0;
			let release: () => void = () => {};
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const inner: Resolver = {
				...fixtureResolver({}),
				async txt() {
					asked++;
					await gate;
					throw new DnsError(failure, `failed ${failure}`);
				},
			};
			const dns = cachedResolver(inner);
			const both = Promise.all([
				code(dns.txt('example.com')),
				code(dns.txt('Example.com.')),
			]);
			release();
			expect(await both).toEqual([failure, failure]);
			expect(asked).toBe(1);
			expect(await code(dns.txt('example.com'))).toBe(failure);
			expect(asked).toBe(askedAfter);
		}
	});

	test('takes an empty answer from the resolver underneath as NOT_FOUND', async () => {
		const inner: Resolver = { ...fixtureResolver({}), a: async () => [] };
		let error: unknown;
		try {
			await cachedResolver(inner).a('example.com');
		} catch (thrown) {
			error = thrown;
		}
		expect(error).toBeInstanceOf(DnsError);
		expect((error as DnsError).code).toBe('NOT_FOUND');
		expect((error as DnsError).message).toBe(
			'No A example.com record (the resolver underneath answered nothing)',
		);
	});

	test('caps a NOT_FOUND at maxTtl too', async () => {
		const inner = fixtureResolver({});
		const dns = cachedResolver(inner, { maxTtl: 0, negativeTtl: 300 });
		await code(dns.mx('example.com'));
		await code(dns.mx('example.com'));
		expect(inner.queries).toHaveLength(2);
	});

	test('forgets the least recently used answer beyond maxEntries', async () => {
		const inner = fixtureResolver({
			'a.example': { a: ['192.0.2.1'] },
			'b.example': { a: ['192.0.2.2'] },
			'c.example': { a: ['192.0.2.3'] },
		});
		const dns = cachedResolver(inner, { maxEntries: 2 });
		await dns.a('a.example');
		await dns.a('b.example');
		await dns.a('a.example');
		await dns.a('c.example');
		await dns.a('a.example');
		await dns.a('b.example');
		expect(inner.queries.map((query) => query.name)).toEqual([
			'a.example',
			'b.example',
			'c.example',
			'b.example',
		]);
	});

	test('what it returns is a copy: changing it changes nothing kept', async () => {
		const inner = fixtureResolver({ 'example.com': { a: ['192.0.2.1'] } });
		const dns = cachedResolver(inner);
		const first = (await dns.a('example.com')) as unknown as {
			address: string;
		}[];
		if (first[0]) first[0].address = 'changed';
		expect((await dns.a('example.com'))[0]?.address).toBe('192.0.2.1');
	});

	test('refuses a malformed name before the cache and the resolver underneath', async () => {
		const inner = fixtureResolver({});
		expect(await code(cachedResolver(inner).a('a..b'))).toBe('INVALID_NAME');
		expect(inner.queries).toHaveLength(0);
	});

	test('refuses options it cannot take', () => {
		const inner = fixtureResolver({});
		expect(() => cachedResolver(inner, { maxEntries: 0 })).toThrow(
			'cachedResolver(): maxEntries must be an integer of at least 1, not 0',
		);
		expect(() => cachedResolver(inner, { negativeTtl: 1.5 })).toThrow(
			'cachedResolver(): negativeTtl must be an integer of at least 0, not 1.5',
		);
	});
});
