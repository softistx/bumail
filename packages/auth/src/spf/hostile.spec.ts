import { describe, expect, test } from 'bun:test';
import { fixtureResolver, type Resolver } from '@bumail/dns';
import { checkSpf, type SpfInput } from './check-spf';
import { parseRecord } from './record';

/**
 * Records written to hurt: every one comes back as a result, within a
 * time bound that linear code meets with a wide margin. A quadratic scan
 * of the larger inputs here takes seconds.
 */
const BOUND_MS = 500;
const session: SpfInput = {
	ip: '192.0.2.10',
	mailFrom: 'joe@example.com',
	helo: 'mail.example.net',
};

async function timed(
	records: Parameters<typeof fixtureResolver>[0],
	input: Partial<SpfInput> = {},
) {
	const resolver = fixtureResolver(records);
	const start = performance.now();
	const got = await checkSpf({ ...session, ...input }, { resolver });
	return { got, ms: performance.now() - start, queries: resolver.queries };
}

describe('limits (RFC 7208 §4.6.4)', () => {
	test('an include loop stops at the eleventh lookup', async () => {
		const { got, queries } = await timed({
			'example.com': { txt: ['v=spf1 include:a.example -all'] },
			'a.example': { txt: ['v=spf1 include:b.example'] },
			'b.example': { txt: ['v=spf1 include:a.example'] },
		});
		expect(got).toMatchObject({
			result: 'permerror',
			reason:
				'more than 10 DNS-querying terms (include, a, mx, ptr, exists, redirect)',
			lookups: 11,
		});
		expect(queries.length).toBe(11);
	});

	test('a redirect to itself stops the same way', async () => {
		const { got } = await timed({
			'example.com': { txt: ['v=spf1 redirect=example.com'] },
		});
		expect(got).toMatchObject({ result: 'permerror', lookups: 11 });
	});

	test('ten lookups pass, eleven do not', async () => {
		const ten = `v=spf1 ${'a:a.example '.repeat(10)}`;
		const records = { 'a.example': { a: ['198.51.100.1'] } };
		expect(
			(await timed({ ...records, 'example.com': { txt: [`${ten}-all`] } })).got,
		).toMatchObject({ result: 'fail', lookups: 10 });
		expect(
			(await timed({ ...records, 'example.com': { txt: [`${ten}mx -all`] } }))
				.got,
		).toMatchObject({ result: 'permerror', lookups: 11 });
	});

	test('two void lookups pass, the third is permerror', async () => {
		const two = 'v=spf1 a:x.example exists:y.example ?all';
		expect((await timed({ 'example.com': { txt: [two] } })).got.result).toBe(
			'neutral',
		);
		const three = 'v=spf1 a:x.example exists:y.example mx:z.example ?all';
		expect(
			(await timed({ 'example.com': { txt: [three] } })).got,
		).toMatchObject({
			result: 'permerror',
			reason: 'more than 2 void lookups (no such name, or no record)',
		});
	});

	test('eleven MX names are permerror; the eleventh PTR name is not looked at', async () => {
		const mx = Array.from({ length: 11 }, (_, i) => ({
			exchange: `mx${i}.example`,
			priority: i,
		}));
		expect(
			(await timed({ 'example.com': { txt: ['v=spf1 mx -all'], mx } })).got,
		).toMatchObject({
			result: 'permerror',
			reason: 'more than 10 MX records for example.com',
		});
		const names = Array.from({ length: 11 }, (_, i) => `h${i}.example.com`);
		const { got, queries } = await timed({
			'example.com': { txt: ['v=spf1 ptr -all'] },
			'192.0.2.10': { ptr: names },
			'h10.example.com': { a: ['192.0.2.10'] },
		});
		expect(got.result).toBe('fail');
		expect(queries.some((q) => q.name === 'h10.example.com')).toBe(false);
	});

	test('a resolver slower than the timeout is temperror', async () => {
		const slow: Resolver = {
			...fixtureResolver({}),
			txt: () => new Promise(() => {}),
		};
		const got = await checkSpf(session, { resolver: slow, timeout: 50 });
		expect(got).toMatchObject({
			result: 'temperror',
			reason: 'the check took longer than its timeout (50 ms)',
		});
	});
});

describe('macro bombs (§7.3)', () => {
	test('%{d} past 253 characters loses labels on the left', async () => {
		const spec = `${'%{d}.'.repeat(30)}example.net`;
		const { got, queries } = await timed({
			'example.com': { txt: [`v=spf1 exists:${spec} -all`] },
		});
		expect(got.result).toBe('fail');
		const name = queries[1]?.name ?? '';
		expect(name.length).toBeLessThanOrEqual(253);
		expect(name.endsWith('.example.com.example.net')).toBe(true);
		expect(name.startsWith('example.com.')).toBe(true);
	});

	test('a record of thousands of macros stops expanding, and is quick', async () => {
		const bomb = `v=spf1 exists:${'%{s}%{l}%{d}%{i}'.repeat(4000)}.example -all`;
		const { got, ms } = await timed(
			{ 'example.com': { txt: [bomb] } },
			{ mailFrom: `${'x.'.repeat(2000)}y@example.com` },
		);
		expect(ms).toBeLessThan(BOUND_MS);
		expect(got.result).toBe('fail');
	});

	test('counts of every size cost the split once', async () => {
		const counts = Array.from({ length: 3000 }, (_, i) => `%{h${i + 1}r}`).join(
			'',
		);
		const { got, ms } = await timed(
			{ 'example.com': { txt: [`v=spf1 exists:${counts}.example -all`] } },
			{ helo: `${'a.'.repeat(127)}b` },
		);
		expect(ms).toBeLessThan(BOUND_MS);
		expect(got.result).toBe('fail');
	});

	test('a local part past 64 octets and a HELO past 255 expand to no name, quickly', async () => {
		const macros = Array.from(
			{ length: 2000 },
			(_, i) =>
				`%{${'slh'.charAt(i % 3)}${(i % 9) + 1}${i % 2 ? 'r' : ''}${'.-+,/_='.charAt(i % 7)}}`,
		).join('');
		const long = 'x'.repeat(2000);
		const { got, ms, queries } = await timed(
			{ 'example.com': { txt: [`v=spf1 exists:${macros}.example -all`] } },
			{ mailFrom: `${long}@example.com`, helo: `${long}.example` },
		);
		expect(ms).toBeLessThan(BOUND_MS);
		expect(got).toMatchObject({ result: 'fail', mechanism: '-all' });
		expect(queries.length).toBe(1);
	});

	test('a local part of 64 octets still expands; 65 do not', async () => {
		for (const [local, result] of [
			[`${'a.'.repeat(31)}aa`, 'pass'],
			[`${'a.'.repeat(31)}aaa`, 'fail'],
		] as const) {
			const { got } = await timed(
				{
					'example.com': { txt: ['v=spf1 exists:%{l}.ok.example -all'] },
					[`${local}.ok.example`]: { a: ['127.0.0.2'] },
				},
				{ mailFrom: `${local}@example.com` },
			);
			expect(got.result).toBe(result);
		}
	});
});

describe('huge records take linear time', () => {
	const PAD = 200_000;

	test.each([
		['spaces', `v=spf1${' '.repeat(PAD)}-all`, 'fail'],
		['one long term', `v=spf1 a:${'a'.repeat(PAD)}.example -all`, 'fail'],
		[
			'a long run of digits',
			`v=spf1 a:x.example/${'1'.repeat(PAD)}`,
			'permerror',
		],
		['dots in a top label', `v=spf1 a:x.${'1'.repeat(PAD)} -all`, 'permerror'],
		[
			'many terms',
			`v=spf1 ${'ip4:198.51.100.1 '.repeat(PAD / 16)}-all`,
			'fail',
		],
		['unclosed macros', `v=spf1 a:${'%{'.repeat(PAD / 2)}`, 'permerror'],
		['many modifiers', `v=spf1 ${'x=y '.repeat(PAD / 4)}-all`, 'fail'],
	])('%s', async (_, record, result) => {
		const { got, ms } = await timed({ 'example.com': { txt: [record] } });
		expect(ms).toBeLessThan(BOUND_MS);
		expect(got.result).toBe(result as typeof got.result);
	});

	test('parsing alone', () => {
		const start = performance.now();
		parseRecord(`v=spf1 ip6:${':'.repeat(PAD)}`);
		parseRecord(`v=spf1 a:${'%%'.repeat(PAD)}`);
		parseRecord(`v=spf1 exists:%{d${'1'.repeat(PAD)}}.example`);
		expect(performance.now() - start).toBeLessThan(BOUND_MS);
	});

	test('a huge MAIL FROM and HELO are only a result', async () => {
		const { got, ms } = await timed(
			{ 'example.com': { txt: ['v=spf1 -all'] } },
			{ mailFrom: `${'@'.repeat(PAD)}example.com`, helo: '.'.repeat(PAD) },
		);
		expect(ms).toBeLessThan(BOUND_MS);
		expect(got.result).toBe('fail');
	});
});
