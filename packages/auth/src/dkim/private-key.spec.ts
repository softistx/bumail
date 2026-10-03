import { describe, expect, test } from 'bun:test';
import { AuthError } from '../errors';
import { RFC8463_ED25519_PRIVATE, RFC8463_RSA_PRIVATE } from './dkim.fixtures';
import { importDkimPrivateKey } from './private-key';

async function refusal(text: string): Promise<string> {
	try {
		await importDkimPrivateKey(text);
	} catch (error) {
		if (error instanceof AuthError) return `${error.code}: ${error.message}`;
		throw error;
	}
	return 'imported';
}

describe('importDkimPrivateKey', () => {
	test('a PKCS #1 RSA PEM and a bare Ed25519 key, as RFC 8463 prints them', async () => {
		const rsa = await importDkimPrivateKey(RFC8463_RSA_PRIVATE);
		expect(rsa.algorithm).toMatchObject({
			name: 'RSASSA-PKCS1-v1_5',
			modulusLength: 1024,
		});
		expect(rsa.usages).toEqual(['sign']);
		expect(rsa.extractable).toBe(false);
		expect(
			(await importDkimPrivateKey(RFC8463_ED25519_PRIVATE)).algorithm.name,
		).toBe('Ed25519');
	});

	test('a PKCS #8 PEM, RSA or Ed25519', async () => {
		for (const algorithm of [
			{
				name: 'RSASSA-PKCS1-v1_5',
				modulusLength: 1024,
				publicExponent: new Uint8Array([1, 0, 1]),
				hash: 'SHA-256',
			},
			{ name: 'Ed25519' },
		]) {
			const pair = (await crypto.subtle.generateKey(algorithm, true, [
				'sign',
				'verify',
			])) as CryptoKeyPair;
			const der = Buffer.from(
				await crypto.subtle.exportKey('pkcs8', pair.privateKey),
			).toString('base64');
			const pem = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g)?.join('\n')}\n-----END PRIVATE KEY-----\n`;
			expect((await importDkimPrivateKey(pem)).algorithm.name).toBe(
				algorithm.name,
			);
		}
	});

	test('refuses what is not a key', async () => {
		expect(await refusal('hello')).toBe(
			'INVALID_KEY: importDkimPrivateKey(): expected a PEM RSA PRIVATE KEY or PRIVATE KEY, or a base64 Ed25519 key of 32 bytes',
		);
		expect(
			await refusal(
				'-----BEGIN RSA PRIVATE KEY-----\n!!\n-----END RSA PRIVATE KEY-----',
			),
		).toBe(
			'INVALID_KEY: importDkimPrivateKey(): the RSA PRIVATE KEY block is not base64',
		);
		expect(
			await refusal(
				'-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----',
			),
		).toBe(
			'INVALID_KEY: importDkimPrivateKey(): the key could not be imported as an RSA or Ed25519 private key',
		);
		expect(await refusal(42 as never)).toBe(
			'INVALID_KEY: importDkimPrivateKey(): the key must be a string',
		);
	});
});
