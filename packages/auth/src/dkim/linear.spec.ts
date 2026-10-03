import { describe, expect, test } from 'bun:test';
import { fixtureResolver } from '@bumail/dns';
import { canonicalizeHeader } from './canon';
import { unsigned } from './dkim.fixtures';
import { splitFields } from './headers';
import { parseTagList } from './tags';
import { verifyDkim } from './verify';

/**
 * About 250 KB of white space inside a field: an anchored `/[ \t]+$/`
 * retries from each blank of the run, which took 25 to 35 seconds here.
 * Linear code takes a few milliseconds; the bound leaves CI a wide margin.
 */
const PAD = ' \t'.repeat(125_000);
const BOUND_MS = 500;
const resolver = fixtureResolver({});

function timed<T>(run: () => T): [T, number] {
	const start = performance.now();
	const value = run();
	return [value, performance.now() - start];
}

async function timedAsync<T>(run: () => Promise<T>): Promise<[T, number]> {
	const start = performance.now();
	const value = await run();
	return [value, performance.now() - start];
}

describe('hostile white space takes linear time', () => {
	test('inside a plain header field name', async () => {
		const header = `X-Pad${PAD}x: v\r\n${unsigned()}`;
		const [fields, split] = timed(() => splitFields(header));
		expect(split).toBeLessThan(BOUND_MS);
		expect(fields[0]?.name).toBe(`x-pad${PAD}x`);
		const [results, ms] = await timedAsync(() =>
			verifyDkim(header, { resolver }),
		);
		expect(ms).toBeLessThan(BOUND_MS);
		expect(results[0]?.result).toBe('none');
	});

	test('inside a DKIM-Signature tag value', async () => {
		const value = `v=1; a=${PAD}x; d=example.com`;
		const [parsed, parse] = timed(() => parseTagList(value));
		expect(parse).toBeLessThan(BOUND_MS);
		expect('tags' in parsed && parsed.tags.get('a')).toBe('x');
		const [results, ms] = await timedAsync(() =>
			verifyDkim(`DKIM-Signature: ${value}\r\n${unsigned()}`, { resolver }),
		);
		expect(ms).toBeLessThan(BOUND_MS);
		expect(results[0]).toMatchObject({
			result: 'permerror',
			reason: 'missing required tag b=',
		});
	});

	test('inside the name and the value of a field canonicalised relaxed', () => {
		const [field, ms] = timed(() =>
			canonicalizeHeader(`X-Pad${PAD}x${PAD}:${PAD}v${PAD}`, 'relaxed'),
		);
		expect(ms).toBeLessThan(BOUND_MS);
		expect(field).toBe(`x-pad${PAD}x:v\r\n`);
	});
});
