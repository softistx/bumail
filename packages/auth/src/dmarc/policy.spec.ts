import { describe, expect, test } from 'bun:test';
import { dkim, dmarcOf, published } from './dmarc.fixtures';

const aligned = { dkim: [dkim('example.com')] };

describe('the policy that applies', () => {
	const org = published('example.com', 'v=DMARC1; p=reject; sp=none');

	test('p for the organizational domain, sp for a subdomain under its record', async () => {
		expect(await dmarcOf(org, 'x@example.com')).toMatchObject({
			policy: 'reject',
			disposition: 'reject',
		});
		expect(await dmarcOf(org, 'x@a.example.com')).toMatchObject({
			policy: 'none',
			disposition: 'none',
		});
	});

	test('without sp, p applies to subdomains', async () => {
		expect(
			await dmarcOf(
				published('example.com', 'v=DMARC1; p=quarantine'),
				'x@a.example.com',
			),
		).toMatchObject({ policy: 'quarantine' });
	});

	test('a record on the subdomain itself applies its p, never its sp', async () => {
		expect(
			await dmarcOf(
				published('a.example.com', 'v=DMARC1; p=reject; sp=none'),
				'x@a.example.com',
			),
		).toMatchObject({ policyDomain: 'a.example.com', policy: 'reject' });
	});

	test('an invalid p with a rua is p=none, and the record is kept', async () => {
		const got = await dmarcOf(
			published('example.com', 'v=DMARC1; p=bogus; rua=mailto:r@example.com'),
			'x@example.com',
		);
		expect(got).toMatchObject({
			result: 'fail',
			policy: 'none',
			disposition: 'none',
		});
		expect(got.record?.rua).toEqual([{ uri: 'mailto:r@example.com' }]);
	});

	test('an invalid sp with a rua is p=none for every domain', async () => {
		const records = published(
			'example.com',
			'v=DMARC1; p=reject; sp=bogus; rua=mailto:r@example.com',
		);
		expect((await dmarcOf(records, 'x@example.com')).policy).toBe('none');
		expect((await dmarcOf(records, 'x@a.example.com')).policy).toBe('none');
	});

	test('an invalid p or sp without a usable rua is a permerror', async () => {
		expect(
			await dmarcOf(
				published('example.com', 'v=DMARC1; rua=not-a-uri'),
				'x@example.com',
			),
		).toMatchObject({
			result: 'permerror',
			reason:
				'the DMARC record at _dmarc.example.com has no valid p=, and no rua=',
			disposition: 'none',
		});
		expect(
			(
				await dmarcOf(
					published('example.com', 'v=DMARC1; p=reject; sp=x'),
					'x@a.example.com',
				)
			).reason,
		).toBe(
			'the DMARC record at _dmarc.example.com has an invalid sp=, and no rua=',
		);
	});
});

describe('pct sampling (§6.6.4), through random()', () => {
	const records = published('example.com', 'v=DMARC1; p=reject; pct=30');
	const at = (n: number) =>
		dmarcOf(records, 'x@example.com', {}, { random: () => n });

	test('sampled: the policy', async () => {
		expect(await at(0.29)).toMatchObject({
			sampled: true,
			disposition: 'reject',
		});
	});

	test('not sampled: reject becomes quarantine', async () => {
		expect(await at(0.3)).toMatchObject({
			sampled: false,
			disposition: 'quarantine',
		});
	});

	test('not sampled: quarantine becomes none', async () => {
		const got = await dmarcOf(
			published('example.com', 'v=DMARC1; p=quarantine; pct=0'),
			'x@example.com',
			{},
			{ random: () => 0 },
		);
		expect(got).toMatchObject({ sampled: false, disposition: 'none' });
	});

	test('pct=100 and pct=0 draw nothing', async () => {
		let draws = 0;
		const random = () => {
			draws++;
			return 0.5;
		};
		for (const pct of [0, 100]) {
			await dmarcOf(
				published('example.com', `v=DMARC1; p=reject; pct=${pct}`),
				'x@example.com',
				{},
				{ random },
			);
		}
		expect(draws).toBe(0);
	});

	test('a pass is never disposed of', async () => {
		expect(
			await dmarcOf(records, 'x@example.com', aligned, { random: () => 0 }),
		).toMatchObject({
			result: 'pass',
			disposition: 'none',
		});
	});
});
