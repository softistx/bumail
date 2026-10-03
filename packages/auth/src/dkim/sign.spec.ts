import { describe, expect, test } from 'bun:test';
import { AuthError } from '../errors';
import { keyPair, unsigned } from './dkim.fixtures';
import { signDkim } from './sign';

const NOW = 1_700_000_000_000;

async function refusal(promise: Promise<unknown>): Promise<AuthError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof AuthError) return error;
		throw error;
	}
	throw new Error('expected an AuthError');
}

describe('signDkim', () => {
	test('folds at 78 columns, b= last, and ends with CRLF', async () => {
		const { privateKey } = await keyPair('rsa-sha256', 2048);
		const signature = await signDkim(unsigned(), {
			domain: 'example.com',
			selector: 'sel',
			privateKey,
			now: () => NOW,
		});
		expect(signature.endsWith('\r\n')).toBe(true);
		const lines = signature.slice(0, -2).split('\r\n');
		expect(
			lines[0]?.startsWith(
				'DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=example.com;',
			),
		).toBe(true);
		for (const line of lines) expect(line.length).toBeLessThanOrEqual(78);
		for (const line of lines.slice(1)) expect(line[0]).toBe(' ');
		const unfolded = lines.join('');
		expect(unfolded).toMatch(/; b=[ A-Za-z0-9+/=]+$/);
		expect(unfolded).toContain(`t=${NOW / 1000};`);
	});

	test('signs the recommended fields present, and over-signs the ones a reader sees', async () => {
		const { privateKey } = await keyPair('ed25519-sha256');
		const message = `Received: from x\r\nX-Mailer: y\r\nMIME-Version: 1.0\r\n${unsigned()}`;
		const signature = await signDkim(message, {
			domain: 'example.com',
			selector: 'sel',
			privateKey,
		});
		const h = /h=([^;]+);/.exec(signature.replace(/\r\n/g, ''))?.[1];
		expect(h?.split(':').map((name) => name.trim())).toEqual([
			'mime-version',
			'from',
			'to',
			'subject',
			'date',
			'message-id',
			'from',
			'subject',
			'date',
			'to',
			'message-id',
			'mime-version',
		]);
	});

	test('writes headers exactly as given, i=, and x= from expiresIn', async () => {
		const { privateKey } = await keyPair('ed25519-sha256');
		const signature = (
			await signDkim(unsigned(), {
				domain: 'Example.COM.',
				selector: 'sel',
				privateKey,
				headers: ['From', 'Subject', 'Subject'],
				identity: 'joe@mail.example.com',
				expiresIn: 3600,
				now: () => NOW,
			})
		).replace(/\r\n/g, '');
		expect(signature).toContain('d=example.com;');
		expect(signature).toContain('i=joe@mail.example.com;');
		expect(signature).toContain('h=from: subject: subject;');
		expect(signature).toContain(`x=${NOW / 1000 + 3600};`);
	});

	test('refuses what it cannot sign with', async () => {
		const { privateKey } = await keyPair('ed25519-sha256');
		const base = { domain: 'example.com', selector: 'sel', privateKey };
		const cases: [Record<string, unknown>, string][] = [
			[
				{ algorithm: 'rsa-sha256' },
				'signDkim(): algorithm rsa-sha256 does not match the Ed25519 key',
			],
			[
				{ headers: ['to'] },
				'signDkim(): headers must include from (RFC 6376 §5.4)',
			],
			...['bad name', 'x;y', 'x:y', 'x\ty', 'x\u0001y', 'x\u00e9y', ''].map(
				(name): [Record<string, unknown>, string] => [
					{ headers: ['from', name] },
					'signDkim(): headers holds a name that is not a header field name',
				],
			),
			[
				{ headers: 'from' },
				'signDkim(): headers must be an array of header field names',
			],
			[{ selector: 'a..b' }, 'signDkim(): selector "a..b" is not a selector'],
			[{ domain: 'a..b' }, 'signDkim(): domain "a..b" is not a domain name'],
			[
				{ identity: 'joe@other.example' },
				'signDkim(): identity "joe@other.example" is not an address within example.com',
			],
			...['@sub..example.com', '@-x.example.com', 'no-at-sign'].map(
				(identity): [Record<string, unknown>, string] => [
					{ identity },
					`signDkim(): identity "${identity}" is not an address within example.com`,
				],
			),
			[
				{ canonicalization: 'loose/simple' },
				'signDkim(): canonicalization loose/simple is not one of simple|relaxed/simple|relaxed',
			],
			[
				{ expiresIn: 0 },
				'signDkim(): expiresIn must be an integer of at least 1, not 0',
			],
			[
				{ privateKey: { algorithm: { name: 'HMAC' }, usages: ['sign'] } },
				'signDkim(): privateKey must be an RSASSA-PKCS1-v1_5 or Ed25519 CryptoKey, not HMAC',
			],
		];
		for (const [options, message] of cases) {
			const error = await refusal(
				signDkim(unsigned(), { ...base, ...options } as never),
			);
			expect(error.code).toBe('INVALID_OPTION');
			expect(error.message).toBe(message);
		}
	});

	test('refuses a public key or an RSA key on another hash', async () => {
		const pair = (await crypto.subtle.generateKey(
			{
				name: 'RSASSA-PKCS1-v1_5',
				modulusLength: 1024,
				publicExponent: new Uint8Array([1, 0, 1]),
				hash: 'SHA-1',
			},
			false,
			['sign', 'verify'],
		)) as CryptoKeyPair;
		const options = { domain: 'example.com', selector: 'sel' };
		expect(
			(
				await refusal(
					signDkim(unsigned(), { ...options, privateKey: pair.privateKey }),
				)
			).message,
		).toBe("signDkim(): the RSA key's hash must be SHA-256, not SHA-1");
		expect(
			(
				await refusal(
					signDkim(unsigned(), { ...options, privateKey: pair.publicKey }),
				)
			).message,
		).toBe("signDkim(): the RSA key's hash must be SHA-256, not SHA-1");
		const { privateKey } = await keyPair('ed25519-sha256');
		const ed = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, [
			'sign',
			'verify',
		])) as CryptoKeyPair;
		expect(privateKey.usages).toContain('sign');
		expect(
			(
				await refusal(
					signDkim(unsigned(), { ...options, privateKey: ed.publicKey }),
				)
			).message,
		).toBe('signDkim(): privateKey does not have the sign usage');
	});

	test('refuses a message with no From, or a header past maxHeaderBytes', async () => {
		const { privateKey } = await keyPair('ed25519-sha256');
		const options = { domain: 'example.com', selector: 'sel', privateKey };
		const noFrom = await refusal(
			signDkim('Subject: hi\r\n\r\nbody\r\n', options),
		);
		expect(noFrom.code).toBe('INVALID_MESSAGE');
		expect(noFrom.message).toBe('signDkim(): the message has no From header');
		const large = await refusal(
			signDkim(unsigned(), { ...options, maxHeaderBytes: 10 }),
		);
		expect(large.code).toBe('INVALID_MESSAGE');
		expect(large.message).toBe(
			'signDkim(): the header is larger than maxHeaderBytes (10)',
		);
	});
});
