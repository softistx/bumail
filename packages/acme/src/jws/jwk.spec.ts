import { describe, expect, test } from 'bun:test';
import { createHash, createPublicKey } from 'node:crypto';
import { AcmeError } from '../errors';
import { generateKeyPair } from '../keys/keys';
import { jwkThumbprint, publicJwk } from './jwk';

/** RFC 7638 §3.1: the JWK of RFC 7517 Appendix A.1, with its `alg` and `kid`. */
const RFC_7638_JWK = {
	kty: 'RSA',
	n:
		'0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAt' +
		'VT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn6' +
		'4tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FD' +
		'W2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n9' +
		'1CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINH' +
		'aQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw',
	e: 'AQAB',
	alg: 'RS256',
	kid: '2011-04-29',
};

describe('jwkThumbprint (RFC 7638)', () => {
	test('§3.1: the example JWK gives NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs', async () => {
		expect(await jwkThumbprint(RFC_7638_JWK)).toBe(
			'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs',
		);
	});

	test('§3.1: the same key as a CryptoKey gives the same thumbprint', async () => {
		const key = await crypto.subtle.importKey(
			'jwk',
			{ kty: 'RSA', n: RFC_7638_JWK.n, e: RFC_7638_JWK.e },
			{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
			true,
			['verify'],
		);
		expect(await jwkThumbprint(key)).toBe(
			'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs',
		);
	});

	test('an EC key: crv, kty, x, y in that order, as node:crypto exports them', async () => {
		const { publicKey } = await generateKeyPair('P-256');
		const spki = Buffer.from(await crypto.subtle.exportKey('spki', publicKey));
		const jwk = createPublicKey({
			key: spki,
			format: 'der',
			type: 'spki',
		}).export({
			format: 'jwk',
		});
		const expected = createHash('sha256')
			.update(
				JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }),
			)
			.digest('base64url');
		expect(await jwkThumbprint(publicKey)).toBe(expected);
		expect(await publicJwk(publicKey)).toEqual({
			kty: 'EC',
			crv: 'P-256',
			x: jwk.x as string,
			y: jwk.y as string,
		});
	});

	test('a JWK it cannot hash is INVALID_KEY', async () => {
		await expect(
			jwkThumbprint({ kty: 'OKP', crv: 'Ed25519', x: 'AA' }),
		).rejects.toThrow(
			new AcmeError(
				'INVALID_KEY',
				'jwkThumbprint(): the key has kty "OKP"; only "EC" and "RSA" are supported',
			),
		);
		await expect(
			jwkThumbprint({ kty: 'EC', crv: 'P-384', x: 'AA', y: 'AA' }),
		).rejects.toThrow(
			'jwkThumbprint(): the key is an EC key on "P-384"; only P-256 is supported',
		);
		await expect(jwkThumbprint({ kty: 'RSA', e: 'AQAB' })).rejects.toThrow(
			'jwkThumbprint(): the key has no base64url "n" member',
		);
		await expect(
			jwkThumbprint({ kty: 'RSA', n: 'a"b', e: 'AQAB' }),
		).rejects.toThrow('jwkThumbprint(): the key has no base64url "n" member');
		await expect(jwkThumbprint('key' as never)).rejects.toThrow(
			'jwkThumbprint(): the key must be a public CryptoKey or a JWK object',
		);
	});

	test('an RSA key under 2048 bits is refused as a JWK as it is as a CryptoKey', async () => {
		const small = await crypto.subtle.generateKey(
			{
				name: 'RSASSA-PKCS1-v1_5',
				hash: 'SHA-256',
				modulusLength: 1024,
				publicExponent: Uint8Array.of(1, 0, 1),
			},
			true,
			['sign', 'verify'],
		);
		const message =
			'jwkThumbprint(): the key is an RSA key of 1024 bits; at least 2048 are needed';
		await expect(jwkThumbprint(small.publicKey)).rejects.toThrow(message);
		const jwk = await crypto.subtle.exportKey('jwk', small.publicKey);
		await expect(jwkThumbprint(jwk)).rejects.toThrow(message);
	});

	test('a private CryptoKey is refused: the thumbprint is of the public key', async () => {
		const { privateKey } = await generateKeyPair('P-256');
		await expect(jwkThumbprint(privateKey)).rejects.toThrow(
			'jwkThumbprint(): the key must be a public key, not a private one',
		);
	});
});
