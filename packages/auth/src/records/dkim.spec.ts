import { describe, expect, test } from 'bun:test';
import { fixtureResolver } from '@bumail/dns';
import { keyPair, unsigned } from '../dkim/dkim.fixtures';
import { parseKeyRecord } from '../dkim/key';
import { signDkim } from '../dkim/sign';
import { verifyDkim } from '../dkim/verify';
import { dkimRecord } from './dkim';

describe('dkimRecord writes what verifyDkim reads', () => {
	for (const [algorithm, keyType] of [
		['rsa-sha256', 'rsa'],
		['ed25519-sha256', 'ed25519'],
	] as const) {
		test(`a ${keyType} key, as bytes or as base64, verifies a signature`, async () => {
			const { privateKey, publicKey } = await keyPair(algorithm);
			const base64 = publicKey.toBase64();
			const text = dkimRecord({ publicKey, keyType });
			expect(text).toBe(`v=DKIM1; k=${keyType}; p=${base64}`);
			expect(dkimRecord({ publicKey: base64, keyType })).toBe(text);
			const resolver = fixtureResolver({
				'sel._domainkey.example.com': { txt: [text] },
			});
			const message = unsigned();
			const signature = await signDkim(message, {
				domain: 'example.com',
				selector: 'sel',
				privateKey,
			});
			const [result] = await verifyDkim(signature + message, { resolver });
			expect(result?.result).toBe('pass');
		});
	}

	test('white space in a pasted key is dropped', () => {
		expect(dkimRecord({ publicKey: 'QUJD\r\n REVG' })).toBe(
			'v=DKIM1; k=rsa; p=QUJDREVG',
		);
	});

	test('testing adds t=y, which the parser reads', () => {
		const text = dkimRecord({ publicKey: 'QUJD', testing: true });
		expect(text).toBe('v=DKIM1; k=rsa; t=y; p=QUJD');
		expect(parseKeyRecord(text)).toMatchObject({
			type: 'rsa',
			publicKey: 'QUJD',
			flags: ['y'],
		});
	});

	test('an empty key is a revoked one', () => {
		const text = dkimRecord({ publicKey: '' });
		expect(text).toBe('v=DKIM1; p=');
		expect(parseKeyRecord(text)?.publicKey).toBe('');
	});
});

describe('dkimRecord refuses', () => {
	test.each([
		[{ publicKey: 'not base64!' }, 'publicKey is not base64'],
		[{ publicKey: 'QUJDRA' }, 'publicKey is not base64'],
		[{ publicKey: 'QUJD', keyType: 'ed25519' as const }, '32 bytes, not 3'],
		[{ publicKey: 'QUJD', keyType: 'dsa' as never }, "keyType must be 'rsa'"],
		[{ publicKey: 7 as never }, 'publicKey must be a base64 string or bytes'],
	])('%j', (options, message) => {
		expect(() => dkimRecord(options)).toThrow(message);
		try {
			dkimRecord(options);
		} catch (error) {
			expect(error).toMatchObject({
				name: 'AuthError',
				code: 'INVALID_OPTION',
			});
		}
	});
});
