import { describe, expect, test } from 'bun:test';
import { fixtureResolver } from '@bumail/dns';
import type { CanonicalizationPair } from './canon';
import { keyPair, streamOf, unsigned } from './dkim.fixtures';
import type { DkimAlgorithm } from './result';
import { signDkim } from './sign';
import { verifyDkim } from './verify';

const ALGORITHMS: DkimAlgorithm[] = ['rsa-sha256', 'ed25519-sha256'];
const PAIRS: CanonicalizationPair[] = [
	'simple/simple',
	'simple/relaxed',
	'relaxed/simple',
	'relaxed/relaxed',
];
const NOW = 1_700_000_000_000;
const BODY = 'Line one  \r\n\tindented\r\n\r\nLast line\r\n\r\n\r\n';

describe('signDkim, then verifyDkim', () => {
	for (const algorithm of ALGORITHMS) {
		for (const canonicalization of PAIRS) {
			test(`${algorithm}, c=${canonicalization}`, async () => {
				const { privateKey, record } = await keyPair(algorithm);
				const resolver = fixtureResolver({
					'sel._domainkey.example.com': { txt: [record] },
				});
				const message = unsigned(BODY);
				const signature = await signDkim(message, {
					domain: 'example.com',
					selector: 'sel',
					privateKey,
					canonicalization,
					now: () => NOW,
				});
				expect(signature).toContain(`c=${canonicalization};`);
				const [result] = await verifyDkim(signature + message, {
					resolver,
					now: () => NOW,
				});
				expect(result).toMatchObject({
					result: 'pass',
					algorithm,
					domain: 'example.com',
					selector: 'sel',
				});
				expect(result?.reason).toBeUndefined();
			});
		}
	}

	test('relaxed survives what transit does to white space and header case; simple does not', async () => {
		const { privateKey, record } = await keyPair('ed25519-sha256');
		const resolver = fixtureResolver({
			'sel._domainkey.example.com': { txt: [record] },
		});
		const message = unsigned(BODY);
		const results: string[] = [];
		for (const canonicalization of [
			'relaxed/relaxed',
			'simple/simple',
		] as const) {
			const signature = await signDkim(message, {
				domain: 'example.com',
				selector: 'sel',
				privateKey,
				canonicalization,
				now: () => NOW,
			});
			const mangled = (signature + message)
				.replace('Subject: Is', 'SUBJECT:   Is')
				.replace('Line one  ', 'Line one\t');
			const [result] = await verifyDkim(mangled, { resolver, now: () => NOW });
			results.push(result?.result ?? '');
		}
		expect(results).toEqual(['pass', 'fail']);
	});

	test('a message stored with LF line ends verifies as the CRLF one signed', async () => {
		const { privateKey, record } = await keyPair('ed25519-sha256');
		const message = unsigned(BODY);
		const signature = await signDkim(message, {
			domain: 'example.com',
			selector: 'sel',
			privateKey,
			canonicalization: 'simple/simple',
			now: () => NOW,
		});
		const [result] = await verifyDkim(
			(signature + message).replace(/\r\n/g, '\n'),
			{
				resolver: fixtureResolver({
					'sel._domainkey.example.com': { txt: [record] },
				}),
				now: () => NOW,
			},
		);
		expect(result?.result).toBe('pass');
	});

	test('streams, signed and verified, in pieces of any size', async () => {
		const { privateKey, record } = await keyPair('rsa-sha256');
		const resolver = fixtureResolver({
			'sel._domainkey.example.com': { txt: [record] },
		});
		const message = unsigned(`${'x'.repeat(100_000)}\r\n${BODY}`);
		const signature = await signDkim(streamOf(message, 4096), {
			domain: 'example.com',
			selector: 'sel',
			privateKey,
			now: () => NOW,
		});
		for (const size of [1, 2, 3, 7, 1000, 65_536]) {
			const [result] = await verifyDkim(streamOf(signature + message, size), {
				resolver,
				now: () => NOW,
			});
			expect(result?.result).toBe('pass');
		}
	});

	test('bytes verify as the string does', async () => {
		const { privateKey, record } = await keyPair('ed25519-sha256');
		const message = unsigned('Grüße, ☃\r\n');
		const signature = await signDkim(message, {
			domain: 'example.com',
			selector: 'sel',
			privateKey,
			now: () => NOW,
		});
		const [result] = await verifyDkim(
			new TextEncoder().encode(signature + message),
			{
				resolver: fixtureResolver({
					'sel._domainkey.example.com': { txt: [record] },
				}),
				now: () => NOW,
			},
		);
		expect(result?.result).toBe('pass');
	});
});

describe('names in a signature', () => {
	test('upper-case d=, s=, i= and h= verify, and are reported lower-cased but i=', async () => {
		const { privateKey, record } = await keyPair('ed25519-sha256');
		const resolver = fixtureResolver({
			'sel._domainkey.example.com': { txt: [record] },
		});
		const message = unsigned(BODY);
		const signature = await signDkim(message, {
			domain: 'EXAMPLE.COM',
			selector: 'SEL',
			identity: 'Joe@Mail.EXAMPLE.com',
			headers: ['FROM', 'Subject', 'TO'],
			privateKey,
			now: () => NOW,
		});
		const [result] = await verifyDkim(signature + message, {
			resolver,
			now: () => NOW,
		});
		expect(result).toMatchObject({
			result: 'pass',
			domain: 'example.com',
			selector: 'sel',
			identity: 'Joe@Mail.EXAMPLE.com',
			signedHeaders: ['from', 'subject', 'to'],
		});
	});

	test('a d= outside ASCII is malformed, even one that lower-cases into it', async () => {
		const message = unsigned(BODY);
		for (const domain of ['ÉXAMPLE.com', 'example.Kom']) {
			const field = `DKIM-Signature: v=1; a=ed25519-sha256; d=${domain}; s=sel; h=from; bh=AAAA; b=AAAA\r\n`;
			const [result] = await verifyDkim(field + message, {
				resolver: fixtureResolver({}),
				now: () => NOW,
			});
			expect(result).toMatchObject({
				result: 'permerror',
				reason: 'malformed d=',
			});
		}
	});
});
