import { describe, expect, test } from 'bun:test';
import { fixtureResolver } from '@bumail/dns';
import { keyPair, unsigned } from './dkim.fixtures';
import { verifyDkim } from './verify';

const NOW = 1_700_000_000_000;
const BH = 'bh=2jUSOH9NhtVGCQWNr9BrIAPreKQjO6Sn7XIkfJVOzv8=';
const VALID = `v=1; a=rsa-sha256; d=example.com; s=sel; h=from:to; ${BH}; b=AAAA`;
const resolver = fixtureResolver({});

async function verdictOf(
	tags: string,
	message = unsigned(),
): Promise<[string, string | undefined]> {
	const [result] = await verifyDkim(`DKIM-Signature: ${tags}\r\n${message}`, {
		resolver,
		now: () => NOW,
	});
	return [result?.result ?? '', result?.reason];
}

describe('verifyDkim on hostile signatures: a result, never a throw', () => {
	test('malformed tag lists', async () => {
		expect(await verdictOf('v=1; a')).toEqual([
			'permerror',
			'malformed tag list: "a" has no "="',
		]);
		expect(await verdictOf('v=1;; a=rsa-sha256')).toEqual([
			'permerror',
			'malformed tag list: an empty tag',
		]);
		expect(await verdictOf('v=1; 9x=1')).toEqual([
			'permerror',
			'malformed tag list: "9x" is not a tag name',
		]);
		expect(await verdictOf('')).toEqual([
			'permerror',
			'malformed tag list: an empty tag',
		]);
		expect(await verdictOf(`${VALID}; d=example.org`)).toEqual([
			'permerror',
			'duplicate tag d=',
		]);
	});

	test('each required tag missing, and wrong values', async () => {
		for (const tag of ['v', 'a', 'b', 'bh', 'd', 'h', 's']) {
			const without = VALID.split('; ')
				.filter((spec) => !spec.startsWith(`${tag}=`))
				.join('; ');
			expect(await verdictOf(without)).toEqual([
				'permerror',
				`missing required tag ${tag}=`,
			]);
		}
		const cases: [string, string, string][] = [
			['v=1', 'v=2', 'unsupported version v=2'],
			['a=rsa-sha256', 'a=rsa-sha1', 'rsa-sha1 is not accepted (RFC 8301)'],
			['a=rsa-sha256', 'a=rsa-md5', 'unsupported algorithm a=rsa-md5'],
			['b=AAAA', 'b=not base64!', 'malformed b='],
			[BH, 'bh=', 'malformed bh='],
			['h=from:to', 'h=to:subject', 'From is not signed (h= has no from)'],
			['h=from:to', 'h=from:bad name', 'malformed h='],
			['d=example.com', 'd=exa mple.com', 'malformed d='],
			['s=sel', 's=-sel-', 'malformed s='],
		];
		for (const [from, to, reason] of cases) {
			expect(await verdictOf(VALID.replace(from, to))).toEqual([
				'permerror',
				reason,
			]);
		}
	});

	test('optional tags with values that cannot be', async () => {
		const cases: [string, string][] = [
			['c=loose', 'unsupported canonicalization c=loose'],
			[
				'c=relaxed/simple/simple',
				'unsupported canonicalization c=relaxed/simple/simple',
			],
			['q=http', 'unsupported query method (q= has no dns/txt)'],
			['i=joe@example.org', 'i= is not within d='],
			['i=joe@notexample.com', 'i= is not within d='],
			['i=no-at-sign', 'malformed i='],
			['l=-1', 'malformed l='],
			['t=soon', 'malformed t='],
			['x=1234567890123', 'malformed x='],
			['t=1700000000; x=1700000000', 'x= is not after t='],
		];
		for (const [tag, reason] of cases) {
			expect(await verdictOf(`${VALID}; ${tag}`)).toEqual([
				'permerror',
				reason,
			]);
		}
	});

	test('unknown tags are ignored', async () => {
		const [result, reason] = await verdictOf(`${VALID}; zz=whatever; z=From:x`);
		expect([result, reason]).toEqual([
			'permerror',
			'no key at sel._domainkey.example.com',
		]);
	});

	test('a huge h= is refused as policy before any lookup', async () => {
		const huge = `from${':to'.repeat(1000)}`;
		const lookups = fixtureResolver({});
		const [result] = await verifyDkim(
			`DKIM-Signature: ${VALID.replace('from:to', huge)}\r\n${unsigned()}`,
			{
				resolver: lookups,
			},
		);
		expect(result).toMatchObject({
			result: 'policy',
			reason: 'h= lists more than 64 header fields',
		});
		expect(lookups.queries).toHaveLength(0);
	});

	test('a message with no From', async () => {
		const message = unsigned().replace(/^From: [^\r]*\r\n/, '');
		expect(await verdictOf(VALID, message)).toEqual([
			'permerror',
			'the message has no From header',
		]);
	});

	test('binary garbage and lone CRs in the header', async () => {
		const garbage = String.fromCharCode(
			...Array.from({ length: 256 }, (_, i) => i),
		);
		const results = await verifyDkim(
			`DKIM-Signature: ${garbage}\r\n\r\n${garbage}`,
			{ resolver },
		);
		expect(results[0]?.result).toBe('permerror');
		const crs = await verifyDkim(`DKIM-Signature: v=1;\ra=b\r\n\r\n`, {
			resolver,
		});
		expect(crs[0]?.result).toBe('permerror');
	});

	test('a message with no blank line is all header', async () => {
		expect(await verifyDkim('From: a@example.com', { resolver })).toEqual([
			{ result: 'none', reason: 'no DKIM-Signature header', testing: false },
		]);
		expect(await verifyDkim('', { resolver })).toEqual([
			{ result: 'none', reason: 'no DKIM-Signature header', testing: false },
		]);
	});

	test('a body shorter than l=', async () => {
		const { privateKey, record } = await keyPair('ed25519-sha256');
		const dns = fixtureResolver({
			'sel._domainkey.example.com': { txt: [record] },
		});
		const { signDkim } = await import('./sign');
		const signature = await signDkim(unsigned(), {
			domain: 'example.com',
			selector: 'sel',
			privateKey,
		});
		const tampered = signature.replace('v=1;', 'v=1; l=99999999999999999999;');
		const [result] = await verifyDkim(tampered + unsigned(), { resolver: dns });
		expect(result).toMatchObject({
			result: 'permerror',
			reason: 'l= is longer than the canonical body',
		});
	});
});
