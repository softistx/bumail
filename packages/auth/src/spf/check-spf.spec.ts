import { describe, expect, test } from 'bun:test';
import { DnsError, fixtureResolver, type Resolver } from '@bumail/dns';
import { type CheckSpfOptions, checkSpf, type SpfInput } from './check-spf';

const session: SpfInput = {
	ip: '192.0.2.10',
	mailFrom: 'joe@example.com',
	helo: 'mail.example.net',
};

function at(
	records: Parameters<typeof fixtureResolver>[0],
	input: Partial<SpfInput> = {},
	options: Partial<CheckSpfOptions> = {},
) {
	return checkSpf(
		{ ...session, ...input },
		{ resolver: fixtureResolver(records), ...options },
	);
}

describe('checkSpf', () => {
	test('gives the result, the reason, the domain, the mechanism and the lookups', async () => {
		const got = await at({
			'example.com': { txt: ['v=spf1 a:mail.example.com -all'] },
			'mail.example.com': { a: ['192.0.2.10'] },
		});
		expect(got).toEqual({
			result: 'pass',
			reason: 'matched a:mail.example.com',
			domain: 'example.com',
			mechanism: 'a:mail.example.com',
			lookups: 1,
		});
	});

	test('none without a record, and for a domain that cannot have one (§4.3)', async () => {
		expect(await at({})).toMatchObject({
			result: 'none',
			reason: 'no SPF record at example.com',
		});
		expect(await at({}, { mailFrom: 'joe@[192.0.2.1]' })).toEqual({
			result: 'none',
			reason: '"[192.0.2.1]" is not a domain SPF can check',
			domain: '[192.0.2.1]',
			lookups: 0,
		});
		expect((await at({}, { mailFrom: '', helo: 'localhost' })).result).toBe(
			'none',
		);
	});

	test('a bounce checks postmaster@ the HELO name (§2.4)', async () => {
		const records = {
			'mail.example.net': {
				txt: ['v=spf1 -all exp=why.example.net'],
			},
			'why.example.net': { txt: ['%{s} via %{h}'] },
		};
		for (const mailFrom of ['', '<>']) {
			expect(await at(records, { mailFrom })).toMatchObject({
				result: 'fail',
				domain: 'mail.example.net',
				explanation: 'postmaster@mail.example.net via mail.example.net',
			});
		}
	});

	test("identity: 'helo' checks the HELO name even with a MAIL FROM", async () => {
		const got = await at(
			{ 'mail.example.net': { txt: ['v=spf1 ip4:192.0.2.10 -all'] } },
			{},
			{ identity: 'helo' },
		);
		expect(got).toMatchObject({ result: 'pass', domain: 'mail.example.net' });
	});

	test('takes MAIL FROM in angle brackets, and a domain in any case', async () => {
		const got = await at(
			{ 'example.com': { txt: ['v=spf1 ip4:192.0.2.0/24 -all'] } },
			{ mailFrom: '<Joe@EXAMPLE.com.>' },
		);
		expect(got).toMatchObject({ result: 'pass', domain: 'example.com' });
	});

	test('an IPv4-mapped client matches ip4 and never ip6 (§5)', async () => {
		const records = {
			'example.com': { txt: ['v=spf1 ip6:::/0 ip4:192.0.2.10 -all'] },
		};
		expect(await at(records, { ip: '::ffff:192.0.2.10' })).toMatchObject({
			result: 'pass',
			mechanism: 'ip4:192.0.2.10',
		});
	});

	test('include follows §5.2: none in the target is permerror, temperror stays', async () => {
		expect(
			await at({
				'example.com': { txt: ['v=spf1 include:nowhere.example -all'] },
			}),
		).toMatchObject({
			result: 'permerror',
			reason: 'include:nowhere.example has no SPF record',
		});
		expect(
			await at({
				'example.com': { txt: ['v=spf1 include:down.example -all'] },
				'down.example': { txt: 'TEMPORARY' },
			}),
		).toMatchObject({
			result: 'temperror',
			reason: 'DNS lookup failed: TEMPORARY for TXT down.example',
		});
	});

	test('redirect to a domain with no record is permerror (§6.1)', async () => {
		expect(
			await at({ 'example.com': { txt: ['v=spf1 redirect=nowhere.example'] } }),
		).toMatchObject({
			result: 'permerror',
			reason: 'redirect=nowhere.example has no SPF record',
		});
	});

	test('more than one record is permerror; a DNS failure is temperror', async () => {
		expect(
			await at({ 'example.com': { txt: ['v=spf1 -all', 'v=spf1 +all'] } }),
		).toMatchObject({
			result: 'permerror',
			reason: 'more than one SPF record at example.com',
		});
		expect(await at({ 'example.com': { txt: 'TIMEOUT' } })).toMatchObject({
			result: 'temperror',
			reason: 'DNS lookup failed: TIMEOUT for TXT example.com',
		});
	});

	test('the explanation comes on fail only, with %{c}, %{r} and %{t} (§6.2)', async () => {
		const records = {
			'example.com': {
				txt: ['v=spf1 ?ip4:192.0.2.11 -all exp=why.example.com'],
			},
			'why.example.com': { txt: ['%{c} refused by %{r} at %{t}'] },
		};
		const options = {
			receiver: 'mx.example.net',
			now: () => 1_400_000_000_123,
		};
		expect(await at(records, {}, options)).toMatchObject({
			result: 'fail',
			explanation: '192.0.2.10 refused by mx.example.net at 1400000000',
		});
		expect(await at(records, { ip: '192.0.2.11' }, options)).not.toHaveProperty(
			'explanation',
		);
	});

	test('a resolver that throws something else is temperror, never a throw', async () => {
		const broken = {
			...fixtureResolver({}),
			txt: async () => {
				throw new TypeError('socket closed');
			},
		} as Resolver;
		expect(await checkSpf(session, { resolver: broken })).toMatchObject({
			result: 'temperror',
			reason: 'DNS lookup failed: TypeError: socket closed for TXT example.com',
		});
		const refusing = {
			...fixtureResolver({}),
			txt: async () => {
				throw new DnsError('INVALID_NAME', 'no');
			},
		} as Resolver;
		expect((await checkSpf(session, { resolver: refusing })).result).toBe(
			'none',
		);
	});
});

test("the guide's spec example: the include is never reached", async () => {
	const got = await at(
		{
			'example.com': {
				txt: ['v=spf1 mx include:_spf.example.net -all'],
				mx: [{ exchange: 'mx.example.com', priority: 10 }],
			},
			'mx.example.com': { a: ['192.0.2.25'] },
			'_spf.example.net': { txt: 'TIMEOUT' },
		},
		{ ip: '192.0.2.25' },
	);
	expect(got).toMatchObject({ result: 'pass', lookups: 1 });
});

describe('names a resolver refuses (§4.6.4)', () => {
	test('a macro expanding to a name no lookup can send never matches, and is no void lookup', async () => {
		const resolver = fixtureResolver({
			'example.com': {
				txt: [
					'v=spf1 exists:%{l}._spf.%{d} a:gone.example mx:gone.example -all',
				],
			},
		});
		const got = await checkSpf(
			{ ...session, mailFrom: 'bob+news@example.com' },
			{ resolver },
		);
		expect(got).toMatchObject({
			result: 'fail',
			mechanism: '-all',
			lookups: 3,
		});
		expect(resolver.queries.map((q) => q.name)).toEqual([
			'example.com',
			'gone.example',
			'gone.example',
		]);
	});
});

describe('ptr (§5.5)', () => {
	test('a PTR lookup that fails does not match, and is not temperror', async () => {
		expect(
			await at({
				'example.com': { txt: ['v=spf1 ptr -all'] },
				'192.0.2.10': { ptr: 'TEMPORARY' },
			}),
		).toMatchObject({ result: 'fail', mechanism: '-all' });
	});
});
