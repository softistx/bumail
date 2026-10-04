import { describe, expect, test } from 'bun:test';
import { AcmeError } from '../errors';
import { generateKeyPair } from '../keys/keys';
import { publicJwk } from './jwk';
import { type FlattenedJws, signJws } from './sign';

const p256 = await generateKeyPair('P-256');
const rsa = await generateKeyPair('RSA-2048');
const NONCE = 'oFvnlFP1wIhRlYS2jTaXbA';
const NEW_ACCOUNT = 'https://example.com/acme/new-account';
const KID = 'https://example.com/acme/acct/evOfKhNU60wg';

function decode(part: string): unknown {
	return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

async function verifies(
	jws: FlattenedJws,
	keyPair: CryptoKeyPair,
): Promise<boolean> {
	const ec = keyPair.publicKey.algorithm.name === 'ECDSA';
	return await crypto.subtle.verify(
		ec ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' },
		keyPair.publicKey,
		Buffer.from(jws.signature, 'base64url'),
		new TextEncoder().encode(`${jws.protected}.${jws.payload}`),
	);
}

const BASE64URL = /^[A-Za-z0-9_-]*$/;

describe('signJws (RFC 7515 flattened, RFC 8555 §6.2)', () => {
	for (const [alg, keyPair] of [
		['ES256', p256],
		['RS256', rsa],
	] as const) {
		test(`${alg}: newAccount, with the jwk in the header (RFC 8555 §7.3)`, async () => {
			const payload = {
				termsOfServiceAgreed: true,
				contact: ['mailto:cert-admin@example.org'],
			};
			const jws = await signJws({
				keyPair,
				nonce: NONCE,
				url: NEW_ACCOUNT,
				payload,
			});
			expect(Object.keys(jws).sort()).toEqual([
				'payload',
				'protected',
				'signature',
			]);
			for (const part of Object.values(jws)) expect(part).toMatch(BASE64URL);
			expect(decode(jws.protected)).toEqual({
				alg,
				nonce: NONCE,
				url: NEW_ACCOUNT,
				jwk: await publicJwk(keyPair.publicKey),
			});
			expect(Object.keys(decode(jws.protected) as object)).toEqual([
				'alg',
				'nonce',
				'url',
				'jwk',
			]);
			expect(decode(jws.payload)).toEqual(payload);
			expect(await verifies(jws, keyPair)).toBe(true);
			if (alg === 'ES256') {
				// P1363 r‖s, 64 bytes: JWS wants no DER (RFC 7518 §3.4).
				expect(Buffer.from(jws.signature, 'base64url')).toHaveLength(64);
			} else {
				expect(Buffer.from(jws.signature, 'base64url')).toHaveLength(256);
			}
		});

		test(`${alg}: with a kid, and no jwk`, async () => {
			const url = 'https://example.com/acme/new-order';
			const payload = {
				identifiers: [{ type: 'dns', value: 'www.example.org' }],
			};
			const jws = await signJws({
				keyPair,
				nonce: NONCE,
				url,
				kid: KID,
				payload,
			});
			expect(decode(jws.protected)).toEqual({
				alg,
				nonce: NONCE,
				url,
				kid: KID,
			});
			expect(await verifies(jws, keyPair)).toBe(true);
		});

		test(`${alg}: POST-as-GET has the payload "" (RFC 8555 §6.3)`, async () => {
			const url = 'https://example.com/acme/cert/mAt3xBGaobw';
			const jws = await signJws({ keyPair, nonce: NONCE, url, kid: KID });
			expect(jws.payload).toBe('');
			expect(await verifies(jws, keyPair)).toBe(true);
		});
	}

	test('{} is a payload, not POST-as-GET: a challenge is answered with it', async () => {
		const jws = await signJws({
			keyPair: p256,
			nonce: NONCE,
			url: 'https://example.com/acme/chall/prV_B7yEyA4',
			kid: KID,
			payload: {},
		});
		expect(jws.payload).toBe('e30');
	});

	test('a signature differs each time for ES256, and a tampered payload fails', async () => {
		const options = {
			keyPair: p256,
			nonce: NONCE,
			url: NEW_ACCOUNT,
			payload: {},
		};
		const one = await signJws(options);
		const two = await signJws(options);
		expect(one.signature).not.toBe(two.signature);
		expect(await verifies({ ...one, payload: 'e30x' }, p256)).toBe(false);
	});

	test.each([
		[
			{ nonce: '' },
			`signJws(): nonce must be the server's Replay-Nonce, a non-empty base64url string, not ""`,
		],
		[
			{ nonce: 'a=b' },
			`signJws(): nonce must be the server's Replay-Nonce, a non-empty base64url string, not "a=b"`,
		],
		[
			{ url: 'http://example.com/acme' },
			'signJws(): url must be an https: URL, not "http://example.com/acme"',
		],
		[
			{ url: 'not a url' },
			'signJws(): url must be an https: URL, not "not a url"',
		],
		[{ kid: 'acct/1' }, 'signJws(): kid must be an https: URL, not "acct/1"'],
		[
			{ payload: 'text' },
			'signJws(): payload must be an object or left out for POST-as-GET, not string',
		],
		[
			{ payload: [] },
			'signJws(): payload must be an object or left out for POST-as-GET, not an array',
		],
		[
			{ payload: null },
			'signJws(): payload must be an object or left out for POST-as-GET, not null',
		],
	])('%p is INVALID_OPTION', async (change, message) => {
		await expect(
			signJws({
				keyPair: p256,
				nonce: NONCE,
				url: NEW_ACCOUNT,
				...change,
			} as never),
		).rejects.toThrow(new AcmeError('INVALID_OPTION', message));
	});

	test('a payload JSON cannot write is INVALID_OPTION', async () => {
		const looped: Record<string, unknown> = {};
		looped['self'] = looped;
		for (const payload of [{ n: 1n }, looped]) {
			const error = await signJws({
				keyPair: p256,
				nonce: NONCE,
				url: NEW_ACCOUNT,
				payload,
			}).catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(AcmeError);
			expect((error as AcmeError).code).toBe('INVALID_OPTION');
			expect((error as AcmeError).message).toStartWith(
				'signJws(): payload cannot be written as JSON: ',
			);
		}
	});

	test('options that are not an object, a key that is not a pair', async () => {
		await expect(signJws(undefined as never)).rejects.toThrow(
			'signJws(): options must be an object',
		);
		await expect(
			signJws({
				keyPair: { publicKey: p256.publicKey } as never,
				nonce: NONCE,
				url: NEW_ACCOUNT,
			}),
		).rejects.toThrow('signJws(): keyPair.privateKey must be a CryptoKey');
	});
});
