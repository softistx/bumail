import { describe, expect, test } from 'bun:test';
import { fixtureResolver } from '@bumail/dns';
import { checkDmarc } from './check-dmarc';
import { dkim, messageFrom, published } from './dmarc.fixtures';
import { isDmarcRecord, parseDmarcRecord } from './record';

/**
 * Records and messages written to hurt: every one comes back as a result,
 * within a time bound that linear code meets with a wide margin. A
 * quadratic scan of these inputs takes seconds.
 */
const BOUND_MS = 500;
const BIG = 1_000_000;

async function timed(record: string, from = 'a@example.com') {
	const resolver = fixtureResolver(published('example.com', record));
	const start = performance.now();
	const got = await checkDmarc(
		{ message: messageFrom(from), dkim: [dkim('example.com')] },
		{ resolver },
	);
	return { got, ms: performance.now() - start };
}

describe('hostile records', () => {
	test.each([
		['a megabyte of one tag', `v=DMARC1; p=reject; x=${'a'.repeat(BIG)}`],
		[
			'a megabyte of blanks inside a value',
			`v=DMARC1; p=reject; rua=mailto:a${' '.repeat(BIG)}b`,
		],
		[
			'a megabyte of blanks after v=DMARC1',
			`v=DMARC1${' '.repeat(BIG)}; p=reject`,
		],
		[
			'a megabyte of blanks between v= and DMARC1',
			`v=${' '.repeat(BIG)}DMARC1; p=reject`,
		],
		[
			'a hundred thousand tags',
			`v=DMARC1; p=reject; ${'a=b;'.repeat(100_000)}`,
		],
		[
			'a hundred thousand semicolons',
			`v=DMARC1; p=reject${';'.repeat(100_000)}`,
		],
		[
			'a hundred thousand rua URIs',
			`v=DMARC1; p=reject; rua=${'mailto:a@example.com,'.repeat(100_000)}`,
		],
		[
			'a hundred thousand bangs in one URI',
			`v=DMARC1; p=reject; rua=mailto:a${'!'.repeat(100_000)}1`,
		],
		[
			'a hundred thousand digits of size',
			`v=DMARC1; p=reject; rua=mailto:a!${'9'.repeat(100_000)}`,
		],
		[
			'a hundred thousand fo options',
			`v=DMARC1; p=reject; fo=${'1:'.repeat(100_000)}`,
		],
		['a megabyte of pct digits', `v=DMARC1; p=reject; pct=${'1'.repeat(BIG)}`],
		[
			'a megabyte of rf keyword',
			`v=DMARC1; p=reject; rf=${'a-'.repeat(BIG / 2)}!`,
		],
	])('%s is read in linear time', async (_, record) => {
		const { got, ms } = await timed(record);
		expect(got.result).toBe('pass');
		expect(got.policy).toBe('reject');
		expect(ms).toBeLessThan(BOUND_MS);
	});

	test('isDmarcRecord and parseDmarcRecord stay linear on a megabyte of equals signs', () => {
		const text = `v=DMARC1; ${'='.repeat(BIG)}`;
		const start = performance.now();
		expect(isDmarcRecord(text)).toBe(true);
		expect(parseDmarcRecord(text).p).toBeUndefined();
		expect(performance.now() - start).toBeLessThan(BOUND_MS);
	});

	test('a hundred thousand DMARC records are one permerror', async () => {
		const records = Array.from({ length: 100_000 }, () => 'v=DMARC1; p=none');
		const resolver = fixtureResolver(published('example.com', ...records));
		const start = performance.now();
		const got = await checkDmarc(
			{ message: messageFrom('a@example.com'), dkim: [] },
			{ resolver },
		);
		expect(got.result).toBe('permerror');
		expect(performance.now() - start).toBeLessThan(BOUND_MS);
	});
});

describe('hostile messages', () => {
	test.each([
		[
			'fifty thousand From addresses',
			`${'a@example.com, '.repeat(50_000)}b@example.com`,
			'From holds more than one address',
		],
		['a From of blanks', ' '.repeat(BIG), 'From holds no address'],
		[
			'an unterminated quoted-string',
			`"${'\\"'.repeat(BIG / 2)}`,
			'From does not parse as one mailbox',
		],
		[
			'comments nested a hundred thousand deep',
			`${'('.repeat(BIG)}a@example.com`,
			'From does not parse as one mailbox',
		],
		[
			'a hundred thousand angle brackets',
			`${'<'.repeat(BIG)}a@example.com`,
			'From does not parse as one mailbox',
		],
		[
			'a domain of a hundred thousand labels',
			`a@${'a.'.repeat(100_000)}com`,
			'the From domain "a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.…" is not a domain name',
		],
	])('%s', async (_, from, reason) => {
		const start = performance.now();
		const got = await checkDmarc(
			{ message: messageFrom(from), dkim: [] },
			{ resolver: fixtureResolver({}), maxHeaderBytes: 4 * BIG },
		);
		expect(got).toMatchObject({
			result: 'permerror',
			reason,
			disposition: 'reject',
		});
		expect(performance.now() - start).toBeLessThan(BOUND_MS * 2);
	});

	test('five thousand From fields', async () => {
		const froms = Array.from({ length: 5000 }, (_, i) => `a${i}@example.com`);
		const got = await checkDmarc(
			{ message: messageFrom(...froms), dkim: [] },
			{ resolver: fixtureResolver({}) },
		);
		expect(got.reason).toBe('the message has more than one From header');
	});

	test('a second From in another case is still a second From', async () => {
		const message = 'From: a@example.com\r\nFROM: b@attacker.example\r\n\r\nx';
		const got = await checkDmarc(
			{ message, dkim: [] },
			{ resolver: fixtureResolver({}) },
		);
		expect(got.reason).toBe('the message has more than one From header');
	});
});
