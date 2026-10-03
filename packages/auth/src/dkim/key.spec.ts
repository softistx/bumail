import { describe, expect, test } from 'bun:test';
import { fixtureResolver } from '@bumail/dns';
import { keyPair, unsigned } from './dkim.fixtures';
import { verifyDkim } from './verify';

const NOW = 1_700_000_000_000;
const BH = 'bh=2jUSOH9NhtVGCQWNr9BrIAPreKQjO6Sn7XIkfJVOzv8=';
const VALID = `v=1; a=rsa-sha256; d=example.com; s=sel; h=from:to; ${BH}; b=AAAA`;

describe('verifyDkim on hostile keys', () => {
	const keyed = async (txt: string | 'TEMPORARY' | 'TIMEOUT', tags = VALID) => {
		const dns = fixtureResolver({
			'sel._domainkey.example.com':
				txt === 'TEMPORARY' || txt === 'TIMEOUT' ? { txt } : { txt: [txt] },
		});
		const [result] = await verifyDkim(
			`DKIM-Signature: ${tags}\r\n${unsigned()}`,
			{ resolver: dns, now: () => NOW },
		);
		return [result?.result, result?.reason];
	};

	test('DNS errors: TEMPORARY and TIMEOUT are temperror, NOT_FOUND permerror', async () => {
		expect(await keyed('TEMPORARY')).toEqual([
			'temperror',
			'key lookup failed: TEMPORARY for sel._domainkey.example.com',
		]);
		expect(await keyed('TIMEOUT')).toEqual([
			'temperror',
			'key lookup failed: TIMEOUT for sel._domainkey.example.com',
		]);
		const [missing] = await verifyDkim(
			`DKIM-Signature: ${VALID}\r\n${unsigned()}`,
			{
				resolver: fixtureResolver({}),
			},
		);
		expect([missing?.result, missing?.reason]).toEqual([
			'permerror',
			'no key at sel._domainkey.example.com',
		]);
	});

	test('a resolver that throws something else is temperror', async () => {
		const broken = {
			...fixtureResolver({}),
			txt: async () => Promise.reject(new Error('boom')),
		};
		const [result] = await verifyDkim(
			`DKIM-Signature: ${VALID}\r\n${unsigned()}`,
			{ resolver: broken },
		);
		expect(result).toMatchObject({
			result: 'temperror',
			reason: 'key lookup failed: Error: boom',
		});
	});

	test('records that are not keys, or keys that cannot be', async () => {
		const ed = VALID.replace('rsa-sha256', 'ed25519-sha256');
		const cases: [string, string, string?][] = [
			['v=DKIM1; p=', 'key revoked (empty p=)'],
			['v=DKIM2; p=AAAA', 'malformed key record at sel._domainkey.example.com'],
			[
				'k=rsa; v=DKIM1; p=AAAA',
				'malformed key record at sel._domainkey.example.com',
			],
			['v=DKIM1; k=rsa', 'malformed key record at sel._domainkey.example.com'],
			[
				'v=DKIM1; k=ed25519; p=AAAA',
				'key type k=ed25519 does not match a=rsa-sha256',
			],
			['v=DKIM1; k=dsa; p=AAAA', 'key type k=dsa does not match a=rsa-sha256'],
			['v=DKIM1; h=sha1; p=AAAA', 'key h= does not allow sha256'],
			['v=DKIM1; s=other; p=AAAA', 'key s= is not for email'],
			['v=DKIM1; p=!!!not base64', 'key p= is not base64'],
			['v=DKIM1; p=AAAA', 'key p= is not an rsa public key'],
			['v=DKIM1; k=ed25519; p=AAAA', 'key p= is not an ed25519 public key', ed],
		];
		for (const [record, reason, tags] of cases) {
			expect(await keyed(record, tags)).toEqual(['permerror', reason]);
		}
	});

	test('an RSA key under 1024 bits is permerror, under minRsaBits policy', async () => {
		const { signDkim } = await import('./sign');
		for (const [bits, minRsaBits, word, reason] of [
			[512, 1024, 'permerror', 'RSA key of 512 bits, under 1024 (RFC 8301)'],
			[1024, 2048, 'policy', 'RSA key of 1024 bits, under minRsaBits (2048)'],
		] as const) {
			const { privateKey, record } = await keyPair('rsa-sha256', bits);
			const signature = await signDkim(unsigned(), {
				domain: 'example.com',
				selector: 'sel',
				privateKey,
			});
			const [result] = await verifyDkim(signature + unsigned(), {
				resolver: fixtureResolver({
					'sel._domainkey.example.com': { txt: [record] },
				}),
				minRsaBits,
			});
			expect([result?.result, result?.reason]).toEqual([word, reason]);
		}
	});
});
