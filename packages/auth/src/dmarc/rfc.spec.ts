import { describe, expect, test } from 'bun:test';
import { dkim, dmarcOf, published, spf } from './dmarc.fixtures';
import { parseDmarcRecord } from './record';

/**
 * RFC 7489 Appendix B, as printed. B.1's identifiers are checked against
 * a record for each mode; B.2's records are read; B.3.1's receiver
 * decision is reproduced.
 */

const relaxed = published('example.com', 'v=DMARC1; p=reject');
const strictSpf = published('example.com', 'v=DMARC1; p=reject; aspf=s');
const strictDkim = published('example.com', 'v=DMARC1; p=reject; adkim=s');

describe('B.1.1, SPF (SPF passes in every example)', () => {
	test('Example 1: in alignment, MAIL FROM sender@example.com, From sender@example.com', async () => {
		for (const records of [relaxed, strictSpf]) {
			expect(
				await dmarcOf(records, 'sender@example.com', {
					spf: spf('example.com'),
				}),
			).toMatchObject({ result: 'pass', alignedSpf: 'example.com' });
		}
	});

	test('Example 2: in alignment (parent) when relaxed, not when strict', async () => {
		const auth = { spf: spf('child.example.com') };
		expect(await dmarcOf(relaxed, 'sender@example.com', auth)).toMatchObject({
			result: 'pass',
			alignedSpf: 'child.example.com',
		});
		expect(await dmarcOf(strictSpf, 'sender@example.com', auth)).toMatchObject({
			result: 'fail',
			disposition: 'reject',
		});
	});

	test('Example 3: not in alignment, MAIL FROM example.net, From child.example.com', async () => {
		const got = await dmarcOf(relaxed, 'sender@child.example.com', {
			spf: spf('example.net'),
		});
		expect(got).toMatchObject({
			result: 'fail',
			policyDomain: 'example.com',
		});
		expect(got.alignedSpf).toBeUndefined();
	});
});

describe('B.1.2, DKIM (the signatures verify in every example)', () => {
	test('Example 1: in alignment, d=example.com, From sender@example.com', async () => {
		for (const records of [relaxed, strictDkim]) {
			expect(
				await dmarcOf(records, 'sender@example.com', {
					dkim: [dkim('example.com')],
				}),
			).toMatchObject({ result: 'pass', alignedDkim: 'example.com' });
		}
	});

	test('Example 2: in alignment (parent) when relaxed, not when strict', async () => {
		const auth = { dkim: [dkim('example.com')] };
		expect(
			await dmarcOf(relaxed, 'sender@child.example.com', auth),
		).toMatchObject({ result: 'pass', alignedDkim: 'example.com' });
		expect(
			await dmarcOf(strictDkim, 'sender@child.example.com', auth),
		).toMatchObject({ result: 'fail' });
	});

	test('Example 3: not in alignment, d=sample.net, From sender@child.example.com', async () => {
		expect(
			await dmarcOf(relaxed, 'sender@child.example.com', {
				dkim: [dkim('sample.net')],
			}),
		).toMatchObject({ result: 'fail' });
	});
});

describe('B.2, the Domain Owner records', () => {
	test('B.2.1: entire domain, monitoring only', () => {
		expect(
			parseDmarcRecord(
				'v=DMARC1; p=none; rua=mailto:dmarc-feedback@example.com',
			),
		).toMatchObject({
			p: 'none',
			pct: 100,
			rua: [{ uri: 'mailto:dmarc-feedback@example.com' }],
		});
	});

	test('B.2.2 and B.2.3: per-message reports, to a third party', () => {
		const record = parseDmarcRecord(
			'v=DMARC1; p=none; rua=mailto:dmarc-feedback@example.com; ruf=mailto:auth-reports@thirdparty.example.net',
		);
		expect(record.ruf).toEqual([
			{ uri: 'mailto:auth-reports@thirdparty.example.net' },
		]);
	});

	test('B.2.4: subdomain, sampling and two aggregate URIs, the second limited to 10m', async () => {
		const text =
			'v=DMARC1; p=quarantine; rua=mailto:dmarc-feedback@example.com,mailto:tld-test@thirdparty.example.net!10m; pct=25';
		expect(parseDmarcRecord(text)).toMatchObject({
			p: 'quarantine',
			pct: 25,
			rua: [
				{ uri: 'mailto:dmarc-feedback@example.com' },
				{ uri: 'mailto:tld-test@thirdparty.example.net', maxSize: 10_485_760 },
			],
		});
		const records = {
			...published('test.example.com', text),
			...published('example.com', 'v=DMARC1; p=none'),
		};
		const at = (random: number) =>
			dmarcOf(records, 'sender@test.example.com', {}, { random: () => random });
		expect(await at(0.2)).toMatchObject({
			policyDomain: 'test.example.com',
			policy: 'quarantine',
			sampled: true,
			disposition: 'quarantine',
		});
		expect(await at(0.25)).toMatchObject({
			sampled: false,
			disposition: 'none',
		});
	});
});

describe('B.3.1, the receiver at SMTP time', () => {
	test('SPF mail.example.com and DKIM example.com both align with example.com: pass, no reject', async () => {
		const got = await dmarcOf(
			published(
				'example.com',
				'v=DMARC1; p=reject; aspf=r; rua=mailto:dmarc-feedback@example.com',
			),
			'sender@example.com',
			{ dkim: [dkim('example.com')], spf: spf('mail.example.com') },
		);
		expect(got).toMatchObject({
			result: 'pass',
			policy: 'reject',
			disposition: 'none',
			alignedDkim: 'example.com',
			alignedSpf: 'mail.example.com',
		});
	});

	test('nothing aligned: the record policy applies', async () => {
		expect(
			await dmarcOf(
				published('example.com', 'v=DMARC1; p=reject; aspf=r'),
				'sender@example.com',
				{ dkim: [dkim('example.net')], spf: spf('example.net') },
			),
		).toMatchObject({ result: 'fail', disposition: 'reject' });
	});
});
