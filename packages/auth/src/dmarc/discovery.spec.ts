import { describe, expect, test } from 'bun:test';
import { fixtureResolver, type Resolver } from '@bumail/dns';
import { checkDmarc } from './check-dmarc';
import { dkim, dmarcOf, messageFrom, published, spf } from './dmarc.fixtures';

const aligned = { dkim: [dkim('example.com')] };

describe('policy discovery (RFC 7489 §6.6.3)', () => {
	test('the From domain record first, no organizational lookup then', async () => {
		const resolver = fixtureResolver({
			...published('news.example.com', 'v=DMARC1; p=quarantine'),
			...published('example.com', 'v=DMARC1; p=reject'),
		});
		const got = await checkDmarc(
			{ message: messageFrom('a@news.example.com'), dkim: [] },
			{ resolver },
		);
		expect(got).toMatchObject({
			result: 'fail',
			policyDomain: 'news.example.com',
			policy: 'quarantine',
		});
		expect(resolver.queries.map((q) => q.name)).toEqual([
			'_dmarc.news.example.com',
		]);
	});

	test('falls back to the organizational domain', async () => {
		const resolver = fixtureResolver(
			published('example.co.uk', 'v=DMARC1; p=reject'),
		);
		const got = await checkDmarc(
			{ message: messageFrom('a@mail.example.co.uk'), dkim: [] },
			{ resolver },
		);
		expect(got).toMatchObject({
			domain: 'mail.example.co.uk',
			policyDomain: 'example.co.uk',
			policy: 'reject',
		});
		expect(resolver.queries.map((q) => q.name)).toEqual([
			'_dmarc.mail.example.co.uk',
			'_dmarc.example.co.uk',
		]);
	});

	test('records that do not start with v=DMARC1 are discarded before falling back', async () => {
		const got = await dmarcOf(
			{
				...published('a.example.com', 'v=spf1 -all', 'p=reject; v=DMARC1'),
				...published('example.com', 'v=DMARC1; p=quarantine'),
			},
			'x@a.example.com',
		);
		expect(got).toMatchObject({
			policyDomain: 'example.com',
			policy: 'quarantine',
		});
	});

	test('no record anywhere is none', async () => {
		expect(await dmarcOf({}, 'x@a.example.com', aligned)).toEqual({
			result: 'none',
			reason: 'no DMARC record at _dmarc.a.example.com or _dmarc.example.com',
			domain: 'a.example.com',
			policy: 'none',
			disposition: 'none',
			sampled: false,
		});
		expect((await dmarcOf({}, 'x@example.com')).reason).toBe(
			'no DMARC record at _dmarc.example.com',
		);
	});

	test('several records are a permerror, with no policy', async () => {
		const got = await dmarcOf(
			published('example.com', 'v=DMARC1; p=reject', 'v=DMARC1; p=none'),
			'x@example.com',
		);
		expect(got).toMatchObject({
			result: 'permerror',
			reason: 'more than one DMARC record at _dmarc.example.com',
			policyDomain: 'example.com',
			policy: 'none',
			disposition: 'none',
		});
	});

	test('a From that is a public suffix has no organizational lookup', async () => {
		const resolver = fixtureResolver({});
		await checkDmarc(
			{ message: messageFrom('x@co.uk'), dkim: [] },
			{ resolver },
		);
		expect(resolver.queries.map((q) => q.name)).toEqual(['_dmarc.co.uk']);
	});

	test('an IDN From is looked up in its A-labels', async () => {
		const got = await dmarcOf(
			published('xn--bcher-kva.example', 'v=DMARC1; p=reject'),
			'x@bücher.example',
		);
		expect(got).toMatchObject({
			domain: 'xn--bcher-kva.example',
			policy: 'reject',
		});
	});

	test('organizationalDomain can be given', async () => {
		const got = await dmarcOf(
			published('corp.example', 'v=DMARC1; p=reject'),
			'x@mail.a.corp.example',
			{ dkim: [dkim('b.corp.example')] },
			{ organizationalDomain: () => 'corp.example' },
		);
		expect(got).toMatchObject({ result: 'pass', policyDomain: 'corp.example' });
	});
	test('an organizationalDomain answer that is not a parent is ignored', async () => {
		const resolver = fixtureResolver(
			published('attacker.example', 'v=DMARC1; p=none'),
		);
		const got = await checkDmarc(
			{ message: messageFrom('x@mail.example.com'), dkim: [] },
			{ resolver, organizationalDomain: () => 'attacker.example' },
		);
		expect(got.result).toBe('none');
		expect(resolver.queries.map((q) => q.name)).toEqual([
			'_dmarc.mail.example.com',
		]);
	});
});

describe('DNS errors', () => {
	test('a temporary failure at the From domain is temperror, with no fallback', async () => {
		const resolver = fixtureResolver({
			'_dmarc.a.example.com': { txt: 'TEMPORARY' },
			...published('example.com', 'v=DMARC1; p=reject'),
		});
		const got = await checkDmarc(
			{ message: messageFrom('x@a.example.com'), dkim: [] },
			{ resolver },
		);
		expect(got).toMatchObject({
			result: 'temperror',
			reason: 'DNS lookup failed: TEMPORARY for TXT _dmarc.a.example.com',
			disposition: 'none',
		});
		expect(resolver.queries).toHaveLength(1);
	});

	test('a timeout at the organizational domain is temperror', async () => {
		expect(
			(
				await dmarcOf(
					{ '_dmarc.example.com': { txt: 'TIMEOUT' } },
					'x@a.example.com',
				)
			).reason,
		).toBe('DNS lookup failed: TIMEOUT for TXT _dmarc.example.com');
	});

	test('a resolver that throws something else is temperror', async () => {
		const resolver = {
			txt: async () => Promise.reject(new Error('boom')),
		} as unknown as Resolver;
		const got = await checkDmarc(
			{ message: messageFrom('x@example.com'), dkim: [] },
			{ resolver },
		);
		expect(got.reason).toBe(
			'DNS lookup failed: Error: boom for TXT _dmarc.example.com',
		);
	});

	test('a resolver that never answers is temperror after timeout', async () => {
		const resolver = {
			txt: () => new Promise(() => {}),
		} as unknown as Resolver;
		const start = performance.now();
		const got = await checkDmarc(
			{ message: messageFrom('x@example.com'), dkim: [] },
			{ resolver, timeout: 50 },
		);
		expect(got).toMatchObject({
			result: 'temperror',
			reason: 'the check took longer than its timeout (50 ms)',
		});
		expect(performance.now() - start).toBeLessThan(1000);
	});

	test('an aligned DKIM temperror and no pass is temperror; the policy is not applied', async () => {
		expect(
			await dmarcOf(
				published('example.com', 'v=DMARC1; p=reject'),
				'x@example.com',
				{
					dkim: [dkim('example.com', 'temperror')],
					spf: spf('attacker.example', 'pass'),
				},
			),
		).toMatchObject({
			result: 'temperror',
			reason: 'an aligned DKIM or SPF check had a temporary error',
			policy: 'reject',
			disposition: 'none',
		});
	});
});
